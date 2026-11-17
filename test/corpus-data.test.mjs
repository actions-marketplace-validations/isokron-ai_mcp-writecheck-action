/**
 * Data-capture additions to the corpus driver (DATA-CONTRACT part D): the server surface probe, the
 * config-source copy, and (below) the driver's new fields end to end with the stand-in docker. The
 * in-container helpers (corpus/sandbox/surface.mjs, config-source.mjs) are run here on the host
 * against synthetic fixtures; in a run they only ever run inside the target's sandbox container.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkDropped, checkFull, checkSnapshot, HarnessError, MAX_FULL_TIMEOUT_S, MAX_REPEATS, NEVER_REUSE_SINCE, TARGETS_FORMAT, timeLimits, validateList, validateTarget,
} from '../corpus/run-shard.mjs';
import { CONFIG_MAX, MAX_FILES, MAX_TOTAL, collect } from '../corpus/sandbox/config-source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------------------------------------
// D1: the surface probe against a stand-in MCP server
// ------------------------------------------------------------------------------------------------

const probe = (mode, ms = 5000) => {
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'sandbox', 'surface.mjs'), '2025-11-25', String(ms), '--', process.execPath, join(root, 'test', 'fixtures', 'corpus', 'fake-mcp.mjs'), mode], { encoding: 'utf8', timeout: 30_000 });
  return { r, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
};

test('D1: the probe sends initialize and tools/list only, follows pages, answers a ping, and skips non-JSON lines', () => {
  const { r, out } = probe('ok');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(out.protocol_offered, '2025-11-25');
  assert.deepEqual(out.initialize, { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true }, logging: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' }, instructions: 'Call list_items first.' });
  assert.deepEqual(out.tools.tools.map((t) => t.name), ['list_items', 'update_item']);
  assert.equal(out.tools.nextCursor, undefined, 'the pages are joined into one result');
  assert.equal(out.pages, 2);
  assert.equal(out.transport.non_json_lines, 1);
  assert.equal(out.transport.notifications, 1);
  assert.equal(out.transport.server_requests, 1);
  assert.match(out.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  // What the server received: initialize, our answer to its ping (sent before its initialize result),
  // the initialized notification and two tools/list. Nothing else.
  const got = [...r.stderr.matchAll(/^fake-mcp got (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(got, ['initialize', 'answer srv-1', 'notifications/initialized', 'tools/list', 'tools/list']);
});

test('D1: a server that exits, never answers or refuses initialize gives null with the reason', () => {
  const die = probe('die');
  assert.equal(die.r.status, 1);
  assert.ok(die.out.initialize);
  assert.equal(die.out.tools, null);
  assert.match(die.out.tools_error, /exited \(exit 3/);
  const silent = probe('silent', 800);
  assert.equal(silent.out.initialize, null);
  assert.match(silent.out.initialize_error, /time limit \(800 ms\)/);
  const err = probe('error');
  assert.equal(err.out.initialize, null);
  assert.match(err.out.initialize_error, /JSON-RPC error .*unsupported/);
  const none = spawnSync(process.execPath, [join(root, 'corpus', 'sandbox', 'surface.mjs'), '2025-11-25', '1000', '--', '/nonexistent/server'], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(JSON.parse(none.stdout).initialize_error, /did not start|exited/);
});

// ------------------------------------------------------------------------------------------------
// D4: the config-source copy against synthetic installed packages
// ------------------------------------------------------------------------------------------------

function npmWork() {
  const work = mkdtempSync(join(tmpdir(), 'corpus-cs-'));
  const pkg = join(work, 'pkg', 'node_modules', '@acme', 'srv');
  const w = (rel, body) => { mkdirSync(dirname(join(pkg, rel)), { recursive: true }); writeFileSync(join(pkg, rel), body); };
  w('package.json', '{"name":"@acme/srv","bin":{"srv":"dist/cli.js"}}');
  w('README.md', '# srv');
  w('LICENSE', 'MIT');
  w('docs/readme-extra.txt', 'second readme, deeper');
  w('dist/cli.js', '#!/usr/bin/env node\n');
  w('dist/config.js', 'module.exports = {}');
  w('dist/settings/defaults.json', '{}');
  w('dist/options.big.json', 'x'.repeat(CONFIG_MAX)); // exactly 256 KiB: not "under 256 KiB"
  w('src/plain.js', 'not matched');
  w('node_modules/dep/config.js', 'a dependency, not the package');
  for (let i = 0; i < 60; i++) w(`env/e${String(i).padStart(2, '0')}.json`, `{"i":${i}}`);
  mkdirSync(join(work, 'pkg', 'node_modules', '.bin'), { recursive: true });
  symlinkSync('../@acme/srv/dist/cli.js', join(work, 'pkg', 'node_modules', '.bin', 'srv'));
  symlinkSync('/etc/hosts', join(work, 'pkg', 'node_modules', '.bin', 'outside'));
  symlinkSync('/etc/hosts', join(pkg, 'dist', 'config-link.json'));
  spawnSync('mkfifo', [join(pkg, 'dist', 'env.fifo')]);
  return { work, pkg };
}

test('D4: config source: manifest, README*, LICENSE*, the bin entry point, then config paths; 40 files at most', () => {
  const { work } = npmWork();
  const out = join(work, 'out', 'config-source');
  const res = collect({ work, ecosystem: 'npm', pkg: '@acme/srv', binDir: join(work, 'pkg', 'node_modules', '.bin'), bin: 'srv', outDir: out });
  assert.equal(res.why, null);
  const P = 'pkg/node_modules/@acme/srv/';
  assert.deepEqual(res.files.slice(0, 7).map((f) => [f.path, f.rule]), [
    [`${P}package.json`, 'manifest'], [`${P}README.md`, 'readme'], [`${P}docs/readme-extra.txt`, 'readme'], [`${P}LICENSE`, 'license'],
    [`${P}dist/cli.js`, 'entry'], [`${P}dist/config.js`, 'config'], [`${P}dist/settings/defaults.json`, 'config'],
  ]);
  assert.equal(res.files.length, MAX_FILES);
  assert.ok(res.files.slice(7).every((f) => f.rule === 'config' && f.path.startsWith(`${P}env/`)));
  // Never: a dependency's file, an unmatched path, a symlink, a fifo, a 256 KiB config file.
  const paths = res.files.map((f) => f.path);
  for (const p of ['node_modules/dep/config.js', 'src/plain.js', 'dist/config-link.json', 'dist/env.fifo']) assert.ok(!paths.includes(`${P}${p}`), p);
  assert.ok(res.skipped.some((s) => s.path === `${P}dist/options.big.json` && s.why === 'config file over 256 KiB'));
  assert.ok(res.skipped.some((s) => s.why === 'file limit'));
  // Copies are byte-for-byte, under their path relative to the work folder, and hashed.
  for (const f of res.files) {
    const b = readFileSync(join(out, f.path));
    assert.equal(sha(b), f.sha256);
    assert.equal(b.length, f.bytes);
  }
  assert.equal(res.total_bytes, res.files.reduce((n, f) => n + f.bytes, 0));
  // A bin that resolves outside the work folder is not followed.
  const res2 = collect({ work, ecosystem: 'npm', pkg: '@acme/srv', binDir: join(work, 'pkg', 'node_modules', '.bin'), bin: 'outside', outDir: join(work, 'out2') });
  assert.ok(res2.skipped.some((s) => s.rule === 'entry' && s.why === 'resolves outside the work folder'));
  assert.ok(!res2.files.some((f) => f.rule === 'entry'));
});

test('D4: config source: 4 MiB in total at most; an unknown package gives a reason, not a guess', () => {
  const work = mkdtempSync(join(tmpdir(), 'corpus-cs-big-'));
  const pkg = join(work, 'pkg', 'node_modules', 'big');
  mkdirSync(join(pkg, 'cfg'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{}');
  writeFileSync(join(pkg, 'README'), 'r'.repeat(3 * 1024 * 1024));
  writeFileSync(join(pkg, 'LICENSE.txt'), 'l'.repeat(1024 * 1024)); // would pass 4 MiB with the README
  for (let i = 0; i < 4; i++) writeFileSync(join(pkg, 'cfg', `config-${i}.json`), 'c'.repeat(200 * 1024));
  const res = collect({ work, ecosystem: 'npm', pkg: 'big', binDir: join(work, 'pkg', 'node_modules', '.bin'), bin: '', outDir: join(work, 'out') });
  assert.ok(res.total_bytes <= MAX_TOTAL, String(res.total_bytes));
  assert.ok(res.skipped.some((s) => s.path.endsWith('LICENSE.txt') && s.why === 'size limit'));
  assert.deepEqual(res.files.map((f) => f.rule), ['manifest', 'readme', 'config', 'config', 'config', 'config']);
  const none = collect({ work, ecosystem: 'npm', pkg: 'missing', binDir: '/x', bin: '', outDir: join(work, 'o3') });
  assert.equal(none.files.length, 0);
  assert.match(none.why, /not found/);
});

test('D4: config source for a PyPI package: METADATA, the RECORD\'s files, the console script and its module', () => {
  const work = mkdtempSync(join(tmpdir(), 'corpus-cs-py-'));
  const site = join(work, 'venv', 'lib', 'python3.12', 'site-packages');
  const w = (rel, body) => { mkdirSync(dirname(join(site, rel)), { recursive: true }); writeFileSync(join(site, rel), body); };
  w('mcp_settings_srv-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\nName: mcp-settings-srv\nVersion: 1.0\n');
  w('mcp_settings_srv-1.0.dist-info/licenses/LICENSE', 'MIT');
  w('mcp_settings_srv-1.0.dist-info/entry_points.txt', '[console_scripts]\nmcp-settings-srv = mcp_settings_srv.server:main\n');
  w('mcp_settings_srv/__init__.py', '');
  w('mcp_settings_srv/server.py', 'def main(): pass\n');
  w('mcp_settings_srv/config.py', 'X = 1\n');
  w('other_pkg/config.py', 'not in RECORD');
  w('mcp_settings_srv-1.0.dist-info/RECORD', ['mcp_settings_srv/__init__.py,,', 'mcp_settings_srv/server.py,sha256=x,1', 'mcp_settings_srv/config.py,,',
    'mcp_settings_srv-1.0.dist-info/METADATA,,', 'mcp_settings_srv-1.0.dist-info/licenses/LICENSE,,', '../../../bin/mcp-settings-srv,,', ''].join('\n'));
  mkdirSync(join(work, 'venv', 'bin'), { recursive: true });
  writeFileSync(join(work, 'venv', 'bin', 'mcp-settings-srv'), '#!/work/venv/bin/python\nfrom mcp_settings_srv.server import main\n');
  const res = collect({ work, ecosystem: 'pypi', pkg: 'MCP_Settings.Srv', binDir: join(work, 'venv', 'bin'), bin: 'mcp-settings-srv', outDir: join(work, 'out') });
  const S = 'venv/lib/python3.12/site-packages/';
  assert.deepEqual(res.files.map((f) => [f.path, f.rule]), [
    [`${S}mcp_settings_srv-1.0.dist-info/METADATA`, 'manifest'],
    [`${S}mcp_settings_srv-1.0.dist-info/licenses/LICENSE`, 'license'],
    ['venv/bin/mcp-settings-srv', 'entry'],
    [`${S}mcp_settings_srv/server.py`, 'entry'],
    // The package's own name ("settings") does not make every file a config file; config.py matches on its own.
    [`${S}mcp_settings_srv/config.py`, 'config'],
  ]);
});


// ------------------------------------------------------------------------------------------------
// The target list's checks
// ------------------------------------------------------------------------------------------------

test('D3: backends[].snapshot is { exec: [strings], user? } and is checked at load', () => {
  assert.doesNotThrow(() => checkSnapshot({ exec: ['psql', '-U', 'mwsc', '-c', 'SELECT * FROM mwsc_items ORDER BY id'] }));
  assert.doesNotThrow(() => checkSnapshot({ exec: ['redis-cli', 'KEYS', '*'], user: 'redis' }));
  for (const bad of ['psql', [], {}, { exec: [] }, { exec: 'psql -c x' }, { exec: ['x', 1] }, { exec: ['x'], user: 'a b' }, { exec: ['x'], capture: 'y' }]) {
    assert.throws(() => checkSnapshot(bad), HarnessError, JSON.stringify(bad));
  }
  assert.throws(() => validateTarget({ id: 't01', backends: [{ image: 'x', snapshot: { exec: [] } }] }), /backend 0: snapshot\.exec/);
  assert.doesNotThrow(() => validateTarget({ id: 't01', backends: [{ image: 'x', snapshot: { exec: ['true'] } }] }));
});

test('D5 / D8: full.repeats and full.timeout_s are checked; the time limit grows by repeats x full.timeout_s', () => {
  for (const repeats of [0, 11, 1.5, '3', null]) assert.throws(() => checkFull({ repeats }), /full\.repeats/, String(repeats));
  for (const timeout_s of [0, MAX_FULL_TIMEOUT_S + 1, 2.5, '600']) assert.throws(() => checkFull({ timeout_s }), /full\.timeout_s/, String(timeout_s));
  assert.doesNotThrow(() => checkFull({ repeats: MAX_REPEATS, timeout_s: MAX_FULL_TIMEOUT_S }));
  assert.equal(MAX_REPEATS >= 3, true, 'the complete profile uses 3');
  const full = { plan_hash: '0123456789abcdef', repeats: 3, timeout_s: 1800 };
  assert.deepEqual(timeLimits({ timeout_s: 600, full }), { base_s: 600, full_s: 1800, repeats: 3, total_s: 6000 });
  assert.deepEqual(timeLimits({ full: { ...full, timeout_s: undefined } }, { timeout_s: 900 }), { base_s: 900, full_s: null, repeats: 3, total_s: 900 }, 'without full.timeout_s the repeats share timeout_s');
  assert.deepEqual(timeLimits({ full: { plan_hash: 'x' } }), { base_s: 600, full_s: null, repeats: 1, total_s: 600 });
  assert.equal(timeLimits({ full: { repeats: 3, timeout_s: 60 } }).repeats, 0, 'no accepted plan hash: no full run');
  assert.throws(() => validateTarget({ id: 't01', full: { repeats: 0 } }), /full\.repeats/);
});

test('D6: canary is "good" or "bad"', () => {
  assert.doesNotThrow(() => validateTarget({ id: 't01', canary: 'good' }));
  assert.doesNotThrow(() => validateTarget({ id: 't01', canary: 'bad' }));
  assert.throws(() => validateTarget({ id: 't01', canary: 'ugly' }), /canary/);
});

test('D7: a dropped id is never reused, except t08 (grandfathered: reused on 16 Nov, before the rule)', () => {
  const list = (dropped, ids) => ({ format: TARGETS_FORMAT, dropped, targets: ids.map((id) => ({ id })) });
  const dropped = [
    { id: 't08', dropped_at: '2026-11-16', reason: 'package withdrawn', reused_by_grandfathered: true },
    { id: 't05', dropped_at: '2026-11-17T09:00:00Z', reason: 'licence' },
  ];
  const { invalid } = validateList(list(dropped, ['t05', 't06', 't08']));
  assert.deepEqual([...invalid.keys()], ['t05']);
  assert.match(invalid.get('t05'), /refused at load: id t05 was dropped and is never reused/);
  // t08 dropped a second time (no grandfather on that entry): refused like any other.
  assert.ok(validateList(list([...dropped, { id: 't08', dropped_at: '2026-12-01' }], ['t08'])).invalid.has('t08'));
  // validateTarget alone applies the same rule.
  assert.throws(() => validateTarget({ id: 't05' }, dropped), /never reused/);
  assert.doesNotThrow(() => validateTarget({ id: 't08' }, dropped));
  // The grandfather flag cannot be used for an id dropped on or after the rule's date.
  assert.throws(() => checkDropped([{ id: 't09', dropped_at: NEVER_REUSE_SINCE, reused_by_grandfathered: true }]), /only for an id dropped before/);
  // dropped[] outside its shape refuses the whole list.
  for (const bad of ['t05', [{ id: 't05' }], [{ id: 'T 5', dropped_at: '2026-11-17' }], [{ id: 't05', dropped_at: '17 Nov' }], [{ id: 't05', dropped_at: '2026-11-17', reused_by_grandfathered: 'yes' }], [null]]) {
    assert.throws(() => validateList(list(bad, ['t01'])), HarnessError, JSON.stringify(bad));
  }
  assert.equal(validateList(list(undefined, ['t01'])).invalid.size, 0, 'a list without dropped[] reads as before');
});
