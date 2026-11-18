#!/usr/bin/env node
/**
 * A stand-in `docker` for test/corpus.test.mjs, so the driver's container plumbing is tested without
 * a Docker daemon. Every call is appended to $FAKE_DOCKER_LOG as one JSON line (argv). Volumes are
 * folders under $FAKE_DOCKER_ROOT/vols. A sandbox `run` of the CLI behaves like a stand-in CLI that
 * prints target-specific text, writes a results folder and exits with the number in
 * $FAKE_DOCKER_ROOT/cli-exit (catalog step). The driver gives docker an allowlisted environment, so
 * the shim that calls this script sets FAKE_DOCKER_ROOT itself; the log is $FAKE_DOCKER_ROOT/calls.jsonl.
 * The real thing is tested by test/corpus-container.test.mjs (CORPUS_DOCKER_TESTS=1).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { moveEvidence } from '../../../corpus/sandbox/evidence.mjs';

const argv = process.argv.slice(2);
const root = process.env.FAKE_DOCKER_ROOT;
const NAME = 'zz-secret-target-name';
const env = JSON.parse(process.env.FAKE_DOCKER_SEEN_ENV ?? '[]');
// The values of secret-like names the docker client was given in its own environment (`--env NAME`).
const secrets = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FAKE_') && /(TOKEN|SECRET|PASS|PWD|KEY|AUTH|CRED|_URL$|_URI$|DSN)/i.test(k)));
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ argv, env, secrets }) + '\n');
const netFile = join(root, 'networks.json');
const nets = existsSync(netFile) ? JSON.parse(readFileSync(netFile, 'utf8')) : {};
const done = (code = 0, out = '') => {
  if (out) process.stdout.write(out);
  process.exit(code);
};
/** A counter kept in a FAKE root file, for answers that change from one call to the next. */
const count = (name) => {
  const f = join(root, `${name}-count`);
  const n = (existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0) + 1;
  writeFileSync(f, String(n));
  return n;
};
/** The n-th line of a FAKE root file (the last one once they run out), or null without the file. */
const nth = (name, n) => {
  const f = join(root, name);
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  return lines[Math.min(n, lines.length) - 1];
};
const stdin = () => new Promise((r) => {
  const c = [];
  process.stdin.on('data', (x) => c.push(x));
  process.stdin.on('end', () => r(Buffer.concat(c)));
});

const [cmd, ...rest] = argv;
const serverVersion = join(root, 'server-version');
if (cmd === 'version') done(0, rest.join(' ').includes('Server.Os') ? 'linux/amd64\n' : existsSync(serverVersion) ? readFileSync(serverVersion, 'utf8') : '29.0.0-fake\n');
if (cmd === 'info') done(0, '4\n');
if (cmd === 'pull') done(0);
if (cmd === 'image') done(0, 'sha256:fake\n');
// `volume inspect` finds only a volume named in FAKE root `volume-exists` (one name suffix per line).
if (cmd === 'volume' && rest[0] === 'inspect') {
  const ends = existsSync(join(root, 'volume-exists')) ? readFileSync(join(root, 'volume-exists'), 'utf8').trim().split('\n') : [];
  done(ends.some((e) => e && rest.at(-1).endsWith(e)) ? 0 : 1, '');
}
if (cmd === 'volume') done(0, rest[0] === 'create' ? `${rest.at(-1)}\n` : '');
if (cmd === 'network') {
  if (rest[0] === 'create') {
    nets[rest.at(-1)] = rest.includes('--internal');
    writeFileSync(netFile, JSON.stringify(nets));
    done(0);
  }
  if (rest[0] === 'inspect') done(0, `${nets[rest.at(-1)] ? 'true' : 'false'}\n`);
  done(0);
}
// A backend that never gets ready (wait fails) and what its logs say (FAKE root files). A snapshot
// exec (an argument SNAPSHOT) prints a numbered state; a capture exec (CAPTURE) prints `capture-values`' n-th line.
if (cmd === 'exec') {
  // FAKE root `exec-echo`: every exec says what it ran on stderr (output the driver logs, line by line).
  if (existsSync(join(root, 'exec-echo'))) process.stderr.write(`ran: ${rest.join(' ')}\nand again: ${rest.slice(1).join(' ')}\n`);
  if (rest.includes('SNAPSHOT')) {
    const n = count('snapshot');
    done(existsSync(join(root, 'snapshot-exit')) ? Number(readFileSync(join(root, 'snapshot-exit'), 'utf8')) : 0, `${NAME} rows: state ${n}\n`);
  }
  if (rest.includes('CAPTURE')) done(0, `${nth('capture-values', count('capture')) ?? 'cap'}\n`);
  done(existsSync(join(root, 'backend-not-ready')) ? 1 : 0);
}
if (cmd === 'logs') {
  const n = existsSync(join(root, 'backend-log-bytes')) ? Number(readFileSync(join(root, 'backend-log-bytes'), 'utf8')) : 0;
  process.stderr.write(`${NAME} backend: setresuid failed: Operation not permitted\n`);
  done(0, n ? `${'L'.repeat(n)}\n` : '');
}
if (cmd === 'inspect') done(0, 'state exited exit 127 oom false error \n');
if (['ps', 'rm', 'create', 'cp'].includes(cmd)) done(0);
if (cmd !== 'run') done(1);

// docker run [options] IMAGE CMD...
const imgAt = rest.findIndex((a, i) => /@sha256:[0-9a-f]{64}$/.test(a) && !['--label', '--name', '--env', '--mount'].includes(rest[i - 1]));
const opts = rest.slice(0, imgAt);
const c = rest.slice(imgAt + 1);
const work = opts.map((a, i) => (opts[i - 1] === '--mount' ? a : null)).filter(Boolean).map((m) => /src=([^,]+),dst=\/work/.exec(m)).find(Boolean)?.[1];
const vol = work ? join(root, 'vols', work) : null;
const inVol = (p) => join(vol, p.replace(/^\/work\/?/, ''));
const script = (c[0] === 'sh' || c[0] === 'bash') && c[1] === '-c' ? c[2] : '';
const volAt = (dst) => opts.map((a, i) => (opts[i - 1] === '--mount' ? a : null)).filter(Boolean).map((m) => new RegExp(`src=([^,]+),dst=${dst}(,|$)`).exec(m)).find(Boolean)?.[1];

if (opts.includes('-d')) done(0, 'fakecontainerid\n');
if (opts.includes('--interactive')) {
  const buf = await stdin();
  if (script.includes('cat > "$1"')) {
    mkdirSync(dirname(inVol(c[4])), { recursive: true });
    writeFileSync(inVol(c[4]), buf);
  }
  done(0);
}
if (script.includes('find . -mindepth 1')) {
  // copy-out: the folder given (`/work/out`, or the evidence volume's root mounted at /work).
  const out = inVol(c[4]);
  if (!existsSync(out)) done(0);
  const t = spawn('tar', ['-C', out, '-cf', '-', '.'], { stdio: ['ignore', 'inherit', 'inherit'] });
  t.on('close', (code) => process.exit(code));
} else if (c[0] === 'node' && c[1] === '/opt/mwsc/_corpus/fetch.mjs') {
  // The set-up fetch helper: prints the sha256 it saw (FAKE root `fetch-sha`, else the pinned one).
  const sha = existsSync(join(root, 'fetch-sha')) ? readFileSync(join(root, 'fetch-sha'), 'utf8').trim() : c[3];
  const code = existsSync(join(root, 'fetch-exit')) ? Number(readFileSync(join(root, 'fetch-exit'), 'utf8')) : 0;
  done(code, code === 0 ? `sha256 ${sha} bytes 10\n` : '');
} else if (c[1] === '/opt/mwsc/_corpus/evidence.mjs') {
  // The evidence helper, for real, between the fake volumes. FAKE root `evidence-tamper`: a moved file
  // is changed afterwards (as if our copy-out were not to be trusted).
  const ev = join(root, 'vols', volAt('/evidence'));
  const res = moveEvidence(inVol(c[2]), ev, c.slice(4));
  if (existsSync(join(root, 'evidence-tamper')) && res.files[0]) writeFileSync(join(ev, res.files[0].path), 'tampered');
  done(0, JSON.stringify(res) + '\n');
} else if (script.includes('--exclude=./out')) {
  // The clean copy of /work (FAKE root `clean-fail`: it fails).
  done(existsSync(join(root, 'clean-fail')) ? 1 : 0);
} else if (script.includes('node -v')) {
  // The version probe (VERSION_PROBE), as the runtime image would answer it.
  done(0, 'node v22.11.0\npython none\n');
} else if (c[0] === 'node' && c[1] === '/opt/mwsc/_corpus/surface.mjs') {
  // The surface probe: what it would print for a two-tool server (FAKE root `surface-fail`: initialize fails).
  // FAKE root `surface-json`: the probe's answer as given.
  if (existsSync(join(root, 'surface-json'))) done(0, `${readFileSync(join(root, 'surface-json'), 'utf8').trim()}\n`);
  if (existsSync(join(root, 'surface-fail'))) done(1, JSON.stringify({ initialize: null, initialize_error: 'the server exited (exit 1 signal null)', tools: null }) + '\n');
  // A hostile answer: an initialize nested deeper than JSON.stringify can follow, and forged fields.
  if (existsSync(join(root, 'surface-deep'))) {
    const n = Number(readFileSync(join(root, 'surface-deep'), 'utf8'));
    done(0, `{"initialize":{"protocolVersion":"x","capabilities":{},"deep":${'['.repeat(n)}${']'.repeat(n)}},"tools":{"tools":[]},"pages":1e300,"captured_at":{"x":1}}\n`);
  }
  done(0, JSON.stringify({
    protocol_offered: c[2], initialize: { protocolVersion: c[2], capabilities: { tools: {}, logging: {} }, serverInfo: { name: NAME, version: '1.0.0' }, instructions: 'Use get first.' },
    tools: { tools: [{ name: 'get', description: 'Read one.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'put', inputSchema: { properties: { id: { type: 'string' } }, type: 'object' }, outputSchema: { type: 'object' } }] },
    pages: 1, initialize_error: null, tools_error: null, transport: { exit: null }, captured_at: '2026-11-17T00:00:00.000Z',
  }) + '\n');
} else if (c[0] === 'node' && c[1] === '/opt/mwsc/_corpus/config-source.mjs') {
  // The config-source helper: one file copied into /work/out/config-source and its listing.
  const body = Buffer.from(`{"name":"${NAME}"}\n`);
  const rel = 'pkg/node_modules/x/package.json';
  mkdirSync(dirname(inVol(join(c[7], rel))), { recursive: true });
  writeFileSync(inVol(join(c[7], rel)), existsSync(join(root, 'config-tamper')) ? 'changed' : body);
  done(0, JSON.stringify({ root: '/work/pkg/node_modules/x', files: [{ path: rel, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, rule: 'manifest' }, { path: '../escape', sha256: 'a'.repeat(64), bytes: 1, rule: 'config' }], skipped: [{ path: 'pkg/big', bytes: 9, rule: 'config', why: 'size limit' }], skipped_more: 0, total_bytes: body.length, why: null }) + '\n');
} else if (c[1] === '/opt/mwsc/dist/src/cli/main.js') {
  const sub = c[2];
  process.stdout.write(`${NAME} violated MWS-ANN-1 ::error::nope\n`);
  process.stderr.write(`${NAME} on stderr\n`);
  if (sub === 'plan') done(0, `plan hash: ${nth('plan-hashes', count('plan')) ?? '0123456789abcdef'}\n`);
  if (sub === 'run') {
    // A full run: a results folder with its write count; FAKE root `run-sleep-ms` holds it past a time limit.
    const n = count('run');
    const sleep = existsSync(join(root, 'run-sleep-ms')) ? Number(readFileSync(join(root, 'run-sleep-ms'), 'utf8')) : 0;
    if (sleep) await new Promise((r) => setTimeout(r, sleep));
    const r = inVol(join(c[c.indexOf('--out') + 1], `run-${n}`));
    mkdirSync(r, { recursive: true });
    writeFileSync(join(r, 'results.json'), JSON.stringify({ format: 'mws-results/1', run: { status: 'complete', writes: 10 + n }, results: [] }));
    const st = inVol(c[c.indexOf('--state') + 1]);
    mkdirSync(st, { recursive: true });
    writeFileSync(join(st, 'ledger.jsonl'), `{"run":${n}}\n`);
    // FAKE root `plant-catalog`: target code in a full repeat rewrites the catalog's result and adds another.
    if (existsSync(join(root, 'plant-catalog'))) {
      mkdirSync(inVol('/work/out/results/catalog-x'), { recursive: true });
      writeFileSync(inVol('/work/out/results/catalog-x/results.json'), JSON.stringify({ run: { status: 'forged' } }));
      mkdirSync(inVol('/work/out/results/catalog-zzz'), { recursive: true });
      writeFileSync(inVol('/work/out/results/catalog-zzz/results.json'), JSON.stringify({ run: { status: 'forged' } }));
    }
    // FAKE root `plant-after-move`: a later repeat's target code plants a forged earlier result.
    if (n > 1 && existsSync(join(root, 'plant-after-move'))) {
      mkdirSync(inVol('/work/out/results/full-1/run-1'), { recursive: true });
      writeFileSync(inVol('/work/out/results/full-1/run-1/results.json'), JSON.stringify({ run: { status: 'complete', writes: 999 } }));
    }
    done(Number(nth('run-exits', n) ?? 0));
  }
  if (sub === 'catalog') {
    // What the stderr-tee would have kept of the server's stderr (it runs inside the real container).
    mkdirSync(inVol('/work/out/server-stderr'), { recursive: true });
    writeFileSync(inVol('/work/out/server-stderr/01-7.log'), `${NAME} server stderr: missing setting\n# server exit 1 signal null\n`);
    const r = inVol(join(c[c.indexOf('--out') + 1], 'catalog-x'));
    mkdirSync(r, { recursive: true });
    const custom = join(root, 'catalog-results');
    writeFileSync(join(r, 'results.json'), existsSync(custom) ? readFileSync(custom) : JSON.stringify({ format: 'mws-results/1', run: { status: 'complete' }, results: [{ requirement: 'MWS-ANN-4', verdict: 'violated' }] }));
    done(Number(readFileSync(join(root, 'cli-exit'), 'utf8')));
  }
  done(4);
} else if (c[0] === 'npm' && c[1] === 'ls') {
  const n = existsSync(join(root, 'deps-bytes')) ? Number(readFileSync(join(root, 'deps-bytes'), 'utf8')) : 0;
  done(0, n ? `${'d'.repeat(n)}\n` : '{"fake":true}\n');
}
else done(0, `${NAME} install output\n`);
