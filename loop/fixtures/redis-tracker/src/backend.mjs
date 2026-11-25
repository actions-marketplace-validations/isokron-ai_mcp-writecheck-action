// The fixture's disposable backend: a real Redis server (the redis-server executable of a digest-pinned image, with the
// two OpenSSL libraries it links, copied out of that image by the loop's driver; see loop/binary-image.mjs) on a throwaway
// data directory under $TMPDIR, listening on 127.0.0.1 only with no Unix socket, no persistence and a random password,
// plus a small HTTP control channel for the tester's control arm (out-of-band reads and writes straight to the same keys,
// never through the MCP server).
//
//   node cli.mjs backend --port 4630   prints {"backend":"redis://127.0.0.1:4630","control":"http://127.0.0.1:4631"}
//   env: REDISFX_PASSWORD (required: the Redis password and the control channel's bearer token),
//        REDISFX_BIN_DIR (where the pinned files are mounted; default /opt/redis)
//
// Everything lives in the sandbox container next to the CLI and the server. Nothing leaves loopback.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conn } from './resp.mjs';
import { FIELDS, Store } from './store.mjs';

/**
 * The sha256 of the three files this fixture runs, from docker.io/library/redis:8.2.11-bookworm (index digest in
 * loop/fixtures.json, `binary_image`; per-platform files copied out on 25 Nov 2026). Checked before every start, here
 * again after the driver checked them when it copied them: a later change to the mounted volume stops the backend.
 */
export const BINARY_SHA256 = {
  'linux-x64': {
    'redis-server': 'acc6bf3ed19bc3ebfafec4b8eb7242543b46c76bdd56fe45d55c6eda7880538f',
    'libssl.so.3': 'cab3f5b0a1febd4a80db5319f3bca4a9378c797dc6e5dc8bce36a575eaa77e78',
    'libcrypto.so.3': 'aa01e614af634bc7c8b678c9250b5c4f613c61989bacf0a5d6aed6570e7dcabd',
  },
  'linux-arm64': {
    'redis-server': 'b0031ab0da3441aeff4702c415e29c7fafe295ab95945e9e59c7f99424872778',
    'libssl.so.3': '7b23bf339ecd38c0ad436243ab78ce0e748a3026c8d91fb45b72700546dbb9fe',
    'libcrypto.so.3': '322b1a55dbc35b68c19a72fea768c97a1b38e6afa72b84627327a443ee74912e',
  },
};
/** The version the pinned binary is (and the only one startBackend accepts from the server it measured). */
export const PINNED_SERVER_VERSION = '8.2.11';
export const DEFAULT_BIN_DIR = '/opt/redis';

export function binaries(dir = process.env.REDISFX_BIN_DIR || DEFAULT_BIN_DIR) {
  const key = `${process.platform}-${process.arch}`;
  const pins = BINARY_SHA256[key];
  if (!pins) throw new Error(`no pinned Redis binary for ${key}`);
  for (const [name, want] of Object.entries(pins)) {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`${dir} has no ${name}`);
    const got = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (got !== want) throw new Error(`${file} has sha256 ${got}, not the pinned ${want}`);
  }
  return { server: join(dir, 'redis-server'), dir };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const wipe = (dir) => rmSync(dir, { recursive: true, force: true });

const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();
/** Constant-time comparison (of the two digests, so lengths do not leak). */
export const sameToken = (a, b) => timingSafeEqual(digest(a), digest(b)) && typeof a === 'string';

const isStr = (v) => typeof v === 'string' && v.length > 0;
/** The control channel's values, held to the types the item has (a value Redis would take as text is not an item). */
function checkFields(b, { needTitle }) {
  if (needTitle && !isStr(b.title)) return false;
  if (b.title !== undefined && !isStr(b.title)) return false;
  if (b.status !== undefined && !isStr(b.status)) return false;
  if (b.assignee !== undefined && b.assignee !== null && typeof b.assignee !== 'string') return false;
  if (b.priority !== undefined && !Number.isInteger(b.priority)) return false;
  return true;
}

/** The control channel: the platform-side API the tester uses to read and change objects without the MCP server. */
export function controlServer(store, token) {
  return createServer(async (req, res) => {
    try {
      if (!sameToken(req.headers.authorization, `Bearer ${token}`)) return json(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url, 'http://x');
      const m = /^\/items(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(url.pathname);
      if (!m) return json(res, 404, { error: 'not found' });
      const chunks = [];
      let size = 0;
      for await (const c of req) { chunks.push(c); size += c.length; if (size > 65536) return json(res, 413, { error: 'too large' }); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'bad json' });
      const id = m[1];
      const ifMatch = req.headers['if-match'] === undefined ? null : Number(req.headers['if-match']);
      if (req.method === 'POST' && !id) {
        if (!checkFields(body, { needTitle: true })) return json(res, 400, { error: 'refused by the database' });
        const project = body.project ?? 'inbox';
        if (typeof project !== 'string' || !(await store.hasProject(project))) return json(res, 400, { error: 'refused by the database' });
        const item = await store.adminCreate({ project, title: body.title, status: body.status ?? 'open', assignee: body.assignee ?? null, priority: body.priority ?? 0 });
        return json(res, 201, { item });
      }
      if (!id) return json(res, 405, { error: 'method not allowed' });
      const cur = await store.get(id);
      if (!cur) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET') return json(res, 200, { item: cur });
      if (ifMatch !== null && cur.version !== ifMatch) return json(res, 412, { error: 'version conflict' });
      if (req.method === 'DELETE') { await store.adminDelete(id); return json(res, 200, { deleted: true }); }
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const cols = Object.keys(body).filter((k) => FIELDS.includes(k));
        if (!cols.length) return json(res, 400, { error: 'no fields' });
        if (!checkFields(body, { needTitle: false })) return json(res, 400, { error: 'refused by the database' });
        return json(res, 200, { item: await store.adminUpdate(id, Object.fromEntries(cols.map((c) => [c, body[c]]))) });
      }
      return json(res, 405, { error: 'method not allowed' });
    } catch (e) {
      return json(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'bad json' : 'backend error' });
    }
  });
}

export async function startBackend({ port, password, binDir, log = (m) => process.stderr.write(`${m}\n`) }) {
  const bin = binaries(binDir);
  const root = mkdtempSync(join(process.env.REDISFX_DATA_DIR || tmpdir(), 'rfx-'));
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o700 });
  // The password goes to Redis in a mode 0600 config file that is removed once the server is up, not on a command line.
  const conf = join(root, 'redis.conf');
  writeFileSync(conf, [
    'bind 127.0.0.1', `port ${port}`, 'protected-mode yes', `requirepass ${password}`,
    'save ""', 'appendonly no', `dir ${data}`, 'daemonize no', 'logfile ""', 'loglevel notice',
    'maxclients 64', 'databases 1', 'maxmemory 256mb', 'maxmemory-policy noeviction',
    'enable-debug-command no', 'enable-module-command no', 'enable-protected-configs no',
  ].join('\n') + '\n', { mode: 0o600 });
  const t0 = Date.now();
  const env = { PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: bin.dir, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
  const proc = spawn(bin.server, [conf], { cwd: data, env, stdio: ['ignore', 2, 2] });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  proc.on('error', () => { exited = true; });
  const cfg = { host: '127.0.0.1', port, password };
  const stop = async () => {
    if (!exited) { proc.kill('SIGTERM'); for (let i = 0; i < 100 && !exited; i++) await sleep(100); if (!exited) proc.kill('SIGKILL'); }
    wipe(root);
  };
  let conn = null;
  for (let i = 0; i < 300 && !exited && !conn; i++) {
    try { conn = await Conn.connect(cfg); await conn.cmd('PING'); } catch { conn?.close(); conn = null; await sleep(100); }
  }
  wipe(conf);
  if (!conn) { await stop(); throw new Error('redis-server did not start'); }
  const info = await conn.cmd('INFO', 'server');
  conn.close();
  const version = /^redis_version:(\S+)/m.exec(info)?.[1] ?? '';
  if (version !== PINNED_SERVER_VERSION) { await stop(); throw new Error(`the server says it is Redis ${version}, not the pinned ${PINNED_SERVER_VERSION}`); }
  log(`redis ${version} ready in ${Date.now() - t0} ms`);
  return { stop, version, url: `redis://127.0.0.1:${port}`, config: cfg };
}

export async function runBackend({ port, env = process.env }) {
  const password = env.REDISFX_PASSWORD;
  if (!password || password.length < 16) throw new Error('REDISFX_PASSWORD (at least 16 characters) is required');
  const be = await startBackend({ port, password });
  const store = new Store(be.config);
  await store.seed();
  const control = controlServer(store, password);
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(port + 1, '127.0.0.1', resolve); });
  process.stdout.write(`${JSON.stringify({ backend: be.url, control: `http://127.0.0.1:${port + 1}`, redis: be.version })}\n`);
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
