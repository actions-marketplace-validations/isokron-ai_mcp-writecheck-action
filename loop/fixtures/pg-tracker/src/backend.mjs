// The fixture's disposable backend: a real PostgreSQL server (the postgres and initdb binaries of the
// embedded-postgres package, run directly; its JavaScript is not loaded) on a throwaway data directory under
// $TMPDIR, listening on 127.0.0.1 only, plus a small HTTP control channel for the tester's control arm
// (out-of-band reads and writes straight to the same tables, never through the MCP server).
//
//   node cli.mjs backend --port 4620   prints {"backend":"postgres://mws@127.0.0.1:4620/mws","control":"http://127.0.0.1:4621"}
//   env: PGFX_PASSWORD (required: the database password and the control channel's bearer token)
//
// Everything lives in the sandbox container next to the CLI and the server. Nothing leaves loopback.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { FIELDS, SCHEMA, Store } from './db.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function binaries() {
  const key = `${process.platform}-${process.arch}`;
  const pkg = `@embedded-postgres/${key}`;
  let dir = null;
  for (let d = here; dir === null; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', pkg, 'native', 'bin'))) dir = join(d, 'node_modules', pkg, 'native', 'bin');
    if (dirname(d) === d) break;
  }
  if (dir === null) throw new Error(`no PostgreSQL binaries for ${key}`);
  for (const b of ['initdb', 'postgres']) if (!existsSync(join(dir, b))) throw new Error(`${pkg} has no ${b}`);
  return { initdb: join(dir, 'initdb'), postgres: join(dir, 'postgres'), pkg };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const wipe = (dir) => rmSync(dir, { recursive: true, force: true });

/** The control channel: the platform-side API the tester uses to read and change objects without the MCP server. */
export function controlServer(store, token) {
  return createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url, 'http://x');
      const m = /^\/items(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(url.pathname);
      if (!m) return json(res, 404, { error: 'not found' });
      const chunks = [];
      let size = 0;
      for await (const c of req) { chunks.push(c); size += c.length; if (size > 65536) return json(res, 413, { error: 'too large' }); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const id = m[1];
      const ifMatch = req.headers['if-match'] === undefined ? null : Number(req.headers['if-match']);
      if (req.method === 'POST' && !id) {
        const r = await store.pool.query('INSERT INTO items (project, title, status, assignee, priority) VALUES ($1, $2, $3, $4, $5) RETURNING *', [body.project ?? 'inbox', body.title, body.status ?? 'open', body.assignee ?? null, body.priority ?? 0]);
        return json(res, 201, { item: r.rows[0] });
      }
      if (!id) return json(res, 405, { error: 'method not allowed' });
      const cur = await store.get(id);
      if (!cur) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET') return json(res, 200, { item: cur });
      if (ifMatch !== null && cur.version !== ifMatch) return json(res, 412, { error: 'version conflict' });
      if (req.method === 'DELETE') { await store.pool.query('DELETE FROM items WHERE id = $1', [id]); return json(res, 200, { deleted: true }); }
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const cols = Object.keys(body).filter((k) => FIELDS.includes(k));
        if (!cols.length) return json(res, 400, { error: 'no fields' });
        const r = await store.pool.query(`UPDATE items SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => body[c])]);
        return json(res, 200, { item: r.rows[0] });
      }
      return json(res, 405, { error: 'method not allowed' });
    } catch { return json(res, 500, { error: 'backend error' }); }
  });
}

export async function startBackend({ port, password, log = (m) => process.stderr.write(`${m}\n`) }) {
  const bin = binaries();
  const root = mkdtempSync(join(process.env.PGFX_DATA_DIR || tmpdir(), 'pgfx-'));
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o700 });
  const pw = join(root, 'pw');
  writeFileSync(pw, `${password}\n`, { mode: 0o600 });
  const t0 = Date.now();
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
  const init = spawnSync(bin.initdb, ['-D', data, '-U', 'mws', '--auth=scram-sha-256', `--pwfile=${pw}`, '--locale=C', '--encoding=UTF8', '--no-sync'], { env, encoding: 'utf8', timeout: 120_000 });
  wipe(pw);
  if (init.status !== 0) { wipe(root); throw new Error(`initdb failed: ${String(init.stderr).slice(0, 300)}`); }
  const proc = spawn(bin.postgres, ['-D', data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=', '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'shared_buffers=32MB', '-c', 'max_connections=40', '-c', 'log_min_messages=warning', '-c', 'logging_collector=off'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const cfg = { host: '127.0.0.1', port, user: 'mws', password, database: 'postgres' };
  let ready = false;
  for (let i = 0; i < 300 && !exited; i++) {
    const c = new pg.Client(cfg);
    c.on('error', () => {});
    try { await c.connect(); await c.query('SELECT 1'); await c.end(); ready = true; break; } catch { try { await c.end(); } catch { /* not connected */ } await sleep(100); }
  }
  const stop = async () => {
    if (!exited) { proc.kill('SIGINT'); for (let i = 0; i < 100 && !exited; i++) await sleep(100); if (!exited) proc.kill('SIGKILL'); }
    wipe(root);
  };
  if (!ready) { await stop(); throw new Error('postgres did not start'); }
  const admin = new pg.Client(cfg);
  await admin.connect();
  await admin.query('CREATE DATABASE mws');
  await admin.end();
  const db = new pg.Client({ ...cfg, database: 'mws' });
  await db.connect();
  await db.query(SCHEMA);
  const version = (await db.query('SHOW server_version')).rows[0].server_version;
  await db.end();
  log(`postgres ${version} ready in ${Date.now() - t0} ms`);
  return { stop, version, url: `postgres://mws@127.0.0.1:${port}/mws`, config: { ...cfg, database: 'mws' } };
}

export async function runBackend({ port, env = process.env }) {
  const password = env.PGFX_PASSWORD;
  if (!password || password.length < 16) throw new Error('PGFX_PASSWORD (at least 16 characters) is required');
  const be = await startBackend({ port, password });
  const store = new Store(be.config);
  const control = controlServer(store, password);
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(port + 1, '127.0.0.1', resolve); });
  process.stdout.write(`${JSON.stringify({ backend: be.url, control: `http://127.0.0.1:${port + 1}`, postgres: be.version })}\n`);
  let stopping = false;
  const down = async () => {
    if (stopping) return;
    stopping = true;
    control.close();
    await store.close().catch(() => {});
    await be.stop();
    process.exit(0);
  };
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, down);
}
