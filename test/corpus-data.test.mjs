/**
 * Data-capture additions to the corpus driver (DATA-CONTRACT part D): the server surface probe, the
 * config-source copy, and (below) the driver's new fields end to end with the stand-in docker. The
 * in-container helpers (corpus/sandbox/surface.mjs, config-source.mjs) are run here on the host
 * against synthetic fixtures; in a run they only ever run inside the target's sandbox container.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Jcs } from '../corpus/jcs.mjs';
import {
  boundAnnotations, checkDropped, checkFull, checkSetupExec, checkShardBudget, checkSnapshot, checkTargetSnapshot, CLEAN_COPY, listCaptures, configSourceMeta, entryBin, envVersions, GRANDFATHERED_IDS, HarnessError, imageParts, LABEL,
  MAX_FULL_TIMEOUT_S, MAX_REPEATS, MAX_TIMEOUT_S, readRunFields, RESTORE_WORK, sandboxRunArgs, SHARD_BUDGET_S, surfaceDoc, surfaceMeta, TARGETS_FORMAT, timeLimits, validateList,
  validateTarget, VERSION_PROBE, checkId, RESERVED_ID, volatileCaptures, redactArgv, SECRET_ENV_NAME, Scrubber,
} from '../corpus/run-shard.mjs';
import { EVIDENCE_PATH, listTree, listingHash, moveEvidence } from '../corpus/sandbox/evidence.mjs';
import { acceptValue, errorText, flagSecrets, isSecretName, LineScrubber, scrubFreeText, scrubStrings } from '../corpus/scrub.mjs';
import { CONFIG_MAX, MAX_FILES, MAX_TOTAL, collect, noLinks } from '../corpus/sandbox/config-source.mjs';

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
// The driver's checks and pure helpers
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

test('File targets: list-level { exec, capture? } set-up and a target-level snapshot { exec } are checked at load', () => {
  assert.doesNotThrow(() => checkSetupExec({ exec: ['node', '-e', 'x', '{{tdir}}/db.sqlite'], capture: 'seed_check' }));
  assert.doesNotThrow(() => checkSetupExec({ exec: ['sh', '-c', 'true'] }));
  for (const bad of [{ exec: [] }, { exec: 'node -e x' }, { exec: ['x', 1] }, { exec: ['x'], capture: '' }, { exec: ['x'], capture: 'a-b' }, { exec: ['x'], capture: 7 },
    { exec: ['x'], capture: 'tdir' }, { exec: ['x'], capture: 'host0' }, { exec: ['x'], capture: 'id' }, { exec: ['x'], capture: 'c'.repeat(65) }, { exec: ['x'], user: 'root' }, { exec: ['x'], capture: 'c', volatile: true }, { exec: ['x'], volatile: false }]) {
    assert.throws(() => checkSetupExec(bad), HarnessError, JSON.stringify(bad));
  }
  assert.throws(() => checkSetupExec({ exec: ['x'], capture: 'c', volatile: true }), /volatile is for backends\[\]\.setup only/);
  assert.doesNotThrow(() => checkTargetSnapshot({ exec: ['node', '-e', 'x', '{{tdir}}/db.sqlite'] }));
  for (const bad of ['dump', [], {}, { exec: [] }, { exec: 'dump' }, { exec: ['x', null] }, { exec: ['x'], user: '10001' }, { exec: ['x'], capture: 'y' }, null]) {
    assert.throws(() => checkTargetSnapshot(bad), HarnessError, JSON.stringify(bad));
  }
  assert.throws(() => checkTargetSnapshot({ exec: ['x'], user: 'root' }), /always runs as the sandbox user/);
  // In validateTarget: the forms, the shell-line and fetch forms still accepted, the whole entry refused otherwise.
  const ok = { id: 't14', setup: ['echo hi', { exec: ['seed'], capture: 'seed_check' }], snapshot: { exec: ['dump', '{{tdir}}/db.sqlite'] }, server: { command: ['{{bin}}/srv', '{{tdir}}/db.sqlite'] } };
  assert.doesNotThrow(() => validateTarget(ok));
  assert.deepEqual(listCaptures(ok), ['seed_check']);
  assert.throws(() => validateTarget({ ...ok, snapshot: { exec: [] } }), /snapshot\.exec/);
  assert.throws(() => validateTarget({ ...ok, setup: [{ exec: ['seed'], capture: 'seed_check', extra: 1 }] }), /set-up 0: an exec step/);
  assert.throws(() => validateTarget({ ...ok, setup: [{ exec: ['x'], fetch: {} }] }), /set-up 0: an exec step/);
  // Captured twice, by the list or by a backend.
  assert.throws(() => validateTarget({ ...ok, setup: [{ exec: ['a'], capture: 'c' }, { exec: ['b'], capture: 'c' }] }), /capture c is captured twice/);
  assert.throws(() => validateTarget({ ...ok, backends: [{ image: 'x', setup: [{ exec: ['a'], capture: 'c' }] }], setup: [{ exec: ['b'], capture: 'c' }] }), /captured twice/);
  // Never set where it is used: server.command and server.env are filled before the list's set-up.
  assert.throws(() => validateTarget({ ...ok, server: { command: ['{{bin}}/srv', '{{seed_check}}'] } }), /seed_check is used in server\.command/);
  assert.throws(() => validateTarget({ ...ok, server: { command: ['srv'], env: { DB: '{{tdir}}/{{seed_check}}' } } }), /seed_check is used in server\.env/);
  // Derived from a volatile backend capture or from a secret-named variable: refused (it would be volatile).
  const vol = { image: 'x', setup: [{ exec: ['mint'], capture: 'tok', volatile: true }] };
  assert.throws(() => validateTarget({ ...ok, backends: [vol], setup: [{ exec: ['echo', '{{tok}}'], capture: 'c' }] }), /derived from a volatile capture/);
  assert.throws(() => validateTarget({ ...ok, setup: [{ exec: ['sh', '-c', 'echo $DB_PASSWORD'], capture: 'c' }] }), /derived from a volatile capture or a secret-named variable/);
  // Without a capture, an exec step may use anything set before it.
  assert.doesNotThrow(() => validateTarget({ ...ok, backends: [vol], setup: [{ exec: ['echo', '{{tok}}'] }] }));
});

test('D5 / D8: full.repeats and full.timeout_s are checked; the time limit grows by repeats x full.timeout_s', () => {
  assert.equal(MAX_REPEATS, 5);
  assert.equal(MAX_FULL_TIMEOUT_S, 7200);
  for (const repeats of [0, 6, 1.5, '3', null]) assert.throws(() => checkFull({ repeats }), /full\.repeats/, String(repeats));
  for (const timeout_s of [0, MAX_FULL_TIMEOUT_S + 1, 2.5, '600']) assert.throws(() => checkFull({ timeout_s }), /full\.timeout_s/, String(timeout_s));
  assert.doesNotThrow(() => checkFull({ repeats: MAX_REPEATS, timeout_s: MAX_FULL_TIMEOUT_S }));
  assert.equal(MAX_REPEATS >= 3, true, 'the complete profile uses 3');
  const full = { plan_hash: '0123456789abcdef', repeats: 3, timeout_s: 1800 };
  assert.deepEqual(timeLimits({ timeout_s: 600, full }), { base_s: 600, full_s: 1800, repeats: 3, total_s: 6000 });
  assert.deepEqual(timeLimits({ full: { ...full, timeout_s: undefined } }, { timeout_s: 900 }), { base_s: 900, full_s: null, repeats: 3, total_s: 900 }, 'without full.timeout_s the repeats share timeout_s');
  assert.deepEqual(timeLimits({ full: { plan_hash: 'x' } }), { base_s: 600, full_s: null, repeats: 1, total_s: 600 });
  assert.equal(timeLimits({ full: { repeats: 3, timeout_s: 60 } }).repeats, 0, 'no accepted plan hash: no full run');
  assert.throws(() => validateTarget({ id: 't01', full: { repeats: 0 } }), /full\.repeats/);
  for (const timeout_s of [0, MAX_TIMEOUT_S + 1, '600', 1.5]) assert.throws(() => validateTarget({ id: 't01', timeout_s }), /timeout_s must be/);
  assert.doesNotThrow(() => validateTarget({ id: 't01', timeout_s: 600 }));
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
  // The grandfather flag is for t08 alone, whatever the date; any other id with it refuses the list.
  assert.deepEqual([...GRANDFATHERED_IDS], ['t08']);
  assert.throws(() => checkDropped([{ id: 't09', dropped_at: '2026-11-01', reused_by_grandfathered: true }]), /reused_by_grandfathered is only for t08/);
  assert.throws(() => validateList(list([{ id: 't13', dropped_at: '2026-11-10', reused_by_grandfathered: true }], ['t13'])), /only for t08/);
  assert.doesNotThrow(() => checkDropped([{ id: 't08', dropped_at: '2026-12-01', reused_by_grandfathered: true }]));
  assert.doesNotThrow(() => checkDropped([{ id: 't09', dropped_at: '2026-11-01', reused_by_grandfathered: false }]));
  // dropped[] outside its shape refuses the whole list.
  for (const bad of ['t05', [{ id: 't05' }], [{ id: 'T 5', dropped_at: '2026-11-17' }], [{ id: 't05', dropped_at: '17 Nov' }], [{ id: 't05', dropped_at: '2026-11-17', reused_by_grandfathered: 'yes' }], [null]]) {
    assert.throws(() => validateList(list(bad, ['t01'])), HarnessError, JSON.stringify(bad));
  }
  assert.equal(validateList(list(undefined, ['t01'])).invalid.size, 0, 'a list without dropped[] reads as before');
});

test('D1: surfaceMeta: JCS hash of { initialize, tools }, server info, capability keys, per-tool digests; null with a reason', () => {
  const initialize = { protocolVersion: '2025-11-25', capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'srv', version: '1.2.3' }, instructions: 'Read first.' };
  const tools = { tools: [
    { name: 'get', description: 'Read one.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'put', inputSchema: { properties: { id: { type: 'string' } }, type: 'object' }, outputSchema: { type: 'object' } },
  ] };
  const { surface } = surfaceMeta({ initialize, tools, pages: 1 });
  assert.equal(surface.file, 'surface.json');
  assert.equal(surface.sha256_jcs, sha256Jcs({ initialize, tools }));
  // Member order does not change it.
  const reordered = JSON.parse(JSON.stringify({ tools, initialize }, ['tools', 'initialize', 'name', 'description', 'inputSchema', 'outputSchema', 'annotations', 'readOnlyHint', 'properties', 'id', 'type', 'serverInfo', 'version', 'protocolVersion', 'capabilities', 'logging', 'instructions']));
  assert.equal(surfaceMeta(reordered).surface.sha256_jcs, surface.sha256_jcs);
  assert.equal(surface.protocol_version, '2025-11-25');
  assert.deepEqual(surface.server_info, { name: 'srv', version: '1.2.3' });
  assert.deepEqual(surface.capabilities_keys, ['logging', 'tools']);
  assert.equal(surface.instructions_sha256, sha('Read first.'));
  assert.equal(surface.tool_count, 2);
  assert.deepEqual(surface.tools[0], { name: 'get', description_sha256: sha('Read one.'), input_schema_sha256_jcs: sha256Jcs(tools.tools[0].inputSchema), output_schema_sha256_jcs: null, output_schema_sha256_jcs_why: 'absent', annotations: { readOnlyHint: true } });
  assert.equal(surface.tools[1].description_sha256, null);
  assert.equal(surface.tools[1].description_sha256_why, 'absent');
  assert.equal(surface.tools[1].annotations, null);
  assert.equal(surface.tools[1].annotations_why, 'absent');
  assert.equal(surface.tools[1].input_schema_sha256_jcs, surface.tools[0].input_schema_sha256_jcs, 'same schema, other key order: same digest');
  assert.equal(surface.tools[1].output_schema_sha256_jcs, sha256Jcs({ type: 'object' }));
  assert.equal(surface.tools_pages, 1);
  // No instructions; no tools/list answer; no initialize answer.
  const bare = surfaceMeta({ initialize: { protocolVersion: 'x', capabilities: {} }, tools: null, tools_error: 'the server exited' }).surface;
  assert.equal(bare.instructions_sha256, null);
  assert.equal(bare.instructions_sha256_why, 'the server gave no instructions');
  assert.equal(bare.server_info, null);
  assert.ok(bare.server_info_why);
  assert.equal(bare.sha256_jcs, null);
  assert.match(bare.sha256_jcs_why, /tools\/list did not answer: the server exited/);
  assert.equal(bare.tool_count, null);
  assert.ok(bare.tool_count_why);
  assert.deepEqual(surfaceMeta({ initialize: null, initialize_error: 'time limit (60000 ms)' }), { surface: null, surface_why: 'initialize: time limit (60000 ms)' });
  // A lone surrogate cannot be hashed: null with the reason, never a made-up value.
  const odd = surfaceMeta({ initialize, tools: { tools: [{ name: 'x', inputSchema: { d: '\ud800' } }] } }).surface;
  assert.equal(odd.sha256_jcs, null);
  assert.match(odd.sha256_jcs_why, /lone surrogate/);
  assert.equal(odd.tools[0].input_schema_sha256_jcs, null);
  assert.match(odd.tools[0].input_schema_sha256_jcs_why, /lone surrogate/);
});

test('D1: the probe\'s output is untrusted: surfaceDoc and surfaceMeta type-check and bound every field', () => {
  // A forged probe line: wrong types, huge numbers, a non-ISO time, extra keys.
  const doc = surfaceDoc({ initialize: ['x'], tools: { tools: 'no' }, captured_at: { x: 1 }, pages: 1e300, initialize_error: 'e'.repeat(5000), transport: { exit: 'x'.repeat(100), evil: 1, over_cap: true } });
  assert.equal(doc.initialize, null);
  assert.equal(doc.tools, null);
  assert.match(doc.captured_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(doc.pages, null);
  assert.equal(doc.initialize_error.length, 500);
  assert.deepEqual(doc.transport, { exit: 'x'.repeat(16), over_cap: true });
  assert.equal(doc.protocol_offered, '2025-11-25');
  // Pages, names, annotations, server info: bounded, else null with a reason.
  const init = { protocolVersion: 'p'.repeat(65), capabilities: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, {}])), serverInfo: { name: 'n'.repeat(257), version: 3 } };
  const many = Array.from({ length: 1005 }, (_, i) => ({ name: i === 0 ? 'x'.repeat(300) : `t${i}`, description: 7, annotations: { readOnlyHint: true, title: 'T', destructiveHint: 'yes', evil: { deep: 1 }, openWorldHint: false } }));
  const m = surfaceMeta({ initialize: init, tools: { tools: many }, pages: 101 }).surface;
  assert.equal(m.protocol_version, null);
  assert.match(m.protocol_version_why, /over 64 characters/);
  assert.equal(m.capabilities_keys, null);
  assert.ok(m.capabilities_keys_why);
  assert.deepEqual(m.server_info, { name: null, version: null, name_why: 'over 256 characters', version_why: 'not a string' });
  assert.equal(m.tool_count, 1005);
  assert.equal(m.tools.length, 1000);
  assert.equal(m.tools_omitted, 5);
  assert.equal(m.tools[0].name, null);
  assert.equal(m.tools[0].name_why, 'over 256 characters');
  assert.equal(m.tools[1].description_sha256, null);
  assert.equal(m.tools[1].description_sha256_why, 'not a string');
  assert.deepEqual(m.tools[1].annotations, { readOnlyHint: true, title: 'T', openWorldHint: false });
  assert.equal(m.tools[1].annotations_dropped, 2);
  assert.equal(m.tools_pages, null);
  assert.ok(m.tools_pages_why);
  assert.equal(surfaceMeta({ initialize: { capabilities: {} }, tools: { tools: [] }, pages: 3 }).surface.tools_pages, 3);
  assert.deepEqual(boundAnnotations([1]), { annotations: null, annotations_why: 'not an object' });
  assert.deepEqual(boundAnnotations({ title: 't'.repeat(257) }), { annotations: {}, annotations_dropped: 1 });
});

test('D4: the config-source listing is untrusted: entries are type-checked and bounded', () => {
  const ok = { path: 'pkg/node_modules/x/package.json', sha256: 'a'.repeat(64), bytes: 3, rule: 'manifest' };
  const m = configSourceMeta({ files: [ok, { ...ok, path: '../x' }, { ...ok, path: '/etc/x' }, { ...ok, rule: 'evil' }, { ...ok, bytes: -1 }, { ...ok, sha256: 'z' }, null, ...Array(50).fill(ok)],
    skipped: [{ path: 'p', bytes: 'x', rule: 'config', why: 'w'.repeat(100) }, 'junk'], skipped_more: 1e300 });
  assert.deepEqual(m.config_source[0], { ...ok, file: 'sandbox/config-source/pkg/node_modules/x/package.json' });
  assert.ok(m.config_source.length <= 40);
  assert.ok(m.config_source.every((f) => f.path === ok.path));
  assert.deepEqual(m.config_source_skipped, [{ path: 'p', bytes: null, rule: 'config', why: 'w'.repeat(64) }]);
  assert.equal(m.config_source_skipped_more, undefined);
  assert.deepEqual(configSourceMeta(null, { exit: 1 }), { config_source: null, config_source_why: 'the config-source helper gave no listing (exit 1)' });
  assert.equal(configSourceMeta({ files: [], why: 'not found' }).config_source_why, 'not found');
});

test('D1 / D5: results.json: only run.status (a short string) and run.writes (a finite number) are kept; a large file is not read', () => {
  const d = mkdtempSync(join(tmpdir(), 'corpus-rf-'));
  const f = (name, body) => { writeFileSync(join(d, name), body); return join(d, name); };
  assert.deepEqual(readRunFields(f('a', JSON.stringify({ run: { status: 'complete', writes: 12 } }))), { too_large: false, status: 'complete', writes: 12 });
  const bad = readRunFields(f('b', JSON.stringify({ run: { status: { nested: [1, 2] }, writes: '12' } })));
  assert.equal(bad.status, null);
  assert.ok(bad.status_why);
  assert.equal(bad.writes, null);
  assert.ok(bad.writes_why);
  assert.equal(readRunFields(f('c', JSON.stringify({ run: { status: 's'.repeat(65), writes: 1 } }))).status, null);
  assert.equal(readRunFields(f('d', 'not json')).why, 'no run object (not JSON, or no run)');
  // The default read cap is 4 MiB (parsing 32 MiB of nested arrays costs about 1 GB of heap).
  assert.equal(readRunFields(f('big', `{"run":{"status":"complete"},"pad":"${'x'.repeat(4 * 1024 * 1024)}"}`)).too_large, true);
  assert.equal(readRunFields(f('fits', `{"run":{"status":"complete"},"pad":"${'x'.repeat(4 * 1024 * 1024 - 64)}"}`)).status, 'complete');
  const big = readRunFields(f('e', JSON.stringify({ run: { status: 'complete' }, pad: 'x'.repeat(2000) })), 1000);
  assert.deepEqual(big, { too_large: true, status: null, writes: null, why: 'over 1000 bytes: not read' });
});

test('D8: the shard\'s planned time must fit one job; the error names the target', () => {
  assert.equal(SHARD_BUDGET_S, 330 * 60);
  const full = { plan_hash: 'x', repeats: 3, timeout_s: 3600 };
  assert.equal(checkShardBudget([{ id: 't01', timeout_s: 600, full }]), 600 + 3 * 3600);
  assert.throws(() => checkShardBudget([{ id: 't01', timeout_s: 600, full }, { id: 't02', timeout_s: 600, full }]), /shard time budget: with t02 this shard plans 22800 s, over the 19800 s/);
  assert.equal(checkShardBudget([{ id: 't01', full }, { id: 't02', full }], {}, new Map([['t02', 'refused']])), 11400, 'a refused target costs nothing');
  assert.throws(() => checkShardBudget([{ id: 't01' }, { id: 't02' }], { timeout_s: 700 }, new Map(), 1000), /with t02/);
});

test('D5: the clean copy of /work is for our helpers only; its scripts keep links and special files as entries', () => {
  assert.throws(() => sandboxRunArgs({ name: 'n', image: IMG, network: 'none', mounts: [{ src: 'corpus-x-clean', dst: '/clean' }], cmd: ['true'] }), /never mounts the clean copy/);
  assert.match(CLEAN_COPY, /--exclude=\.\/out/);
  // Success is the helper's exit status (bash pipefail), never a status file a target could plant or block.
  for (const sc of [CLEAN_COPY, RESTORE_WORK]) {
    assert.ok(sc.startsWith('set -o pipefail; '), sc);
    assert.doesNotMatch(sc, /status|echo \$\?|>(?!\/dev\/null)/, 'no file written but /dev/null');
  }
  assert.match(RESTORE_WORK, /\[ "\$e" = \/work\/out \] && continue/);
  // tar without -h / --dereference stores a symlink as a link entry; nothing it points to is read.
  for (const sc of [CLEAN_COPY, RESTORE_WORK]) for (const cmd of sc.match(/tar [^|;&]*/g)) assert.ok(!/(^| )(-[a-zA-Z]*h[a-zA-Z]*|--dereference)( |$)/.test(cmd), cmd);
});

test('D2: versions from inside the target container, image references, the entry bin', () => {
  assert.deepEqual(envVersions({ exit: 0, stdout: 'node v22.11.0\npython Python 3.12.7\n' }), { node_version: 'v22.11.0', python_version: '3.12.7' });
  assert.deepEqual(envVersions({ exit: 0, stdout: 'node v22.11.0\npython none\n' }), { node_version: 'v22.11.0', python_version: null, python_version_why: "python3 is not on the target container's PATH" });
  const failed = envVersions({ exit: 125, stdout: '' });
  assert.equal(failed.node_version, null);
  assert.match(failed.node_version_why, /did not run \(exit 125\)/);
  assert.match(envVersions({ exit: 0, stdout: 'node -\npython -\n' }).python_version_why, /python3 -V failed/);
  // The probe's output can be forged by target code: only version-shaped strings of 64 characters at most.
  for (const v of ['v22;rm', `v${'1'.repeat(64)}`, 'vX', '$(id)']) {
    const r = envVersions({ exit: 0, stdout: `node ${v}\npython Python ${v.replace(/^v/, '')}\n` });
    assert.equal(r.node_version, null, v);
    assert.match(r.node_version_why, /nothing recognisable as a version/);
    assert.equal(r.python_version, null, v);
  }
  assert.equal(envVersions({ exit: 0, stdout: `node v${'1'.repeat(63)}\n` }).node_version.length, 64);
  assert.equal(envVersions({ exit: 0, stdout: 'python Python 3.13.0rc1+local\n' }).python_version, '3.13.0rc1+local');
  assert.match(VERSION_PROBE, /node -v/);
  assert.deepEqual(imageParts(`docker.io/library/postgres:17@sha256:${'c'.repeat(64)}`), { image_tag: 'docker.io/library/postgres:17', image_digest: `sha256:${'c'.repeat(64)}` });
  assert.deepEqual(imageParts('postgres:16'), { image_tag: 'postgres:16', image_digest: null });
  assert.deepEqual(entryBin({ bins: ['srv-mcp'] }, '/work/bin', '/work/bin/other'), { bin: 'srv-mcp', from: 'bins[0]' });
  assert.deepEqual(entryBin({ bins: ['../x'] }, '/work/bin', '/work/bin/srv'), { bin: 'srv', from: 'server.command[0]' });
  assert.equal(entryBin({}, '/work/bin', 'node').bin, null);
});

// ------------------------------------------------------------------------------------------------
// The driver end to end, with the stand-in docker (test/fixtures/corpus/fake-docker.mjs)
// ------------------------------------------------------------------------------------------------

const NAME = 'zz-secret-target-name';
const IMG = `docker.io/library/node:22-bookworm-slim@sha256:${'a'.repeat(64)}`;
const HASH = '0123456789abcdef'; // the stand-in CLI's plan hash

function stand(targets, { dropped } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'corpus-d-'));
  const cli = join(d, 'cli');
  mkdirSync(join(cli, 'dist', 'src', 'cli'), { recursive: true });
  writeFileSync(join(cli, 'dist', 'src', 'cli', 'main.js'), `
    const [cmd] = process.argv.slice(2);
    if (cmd === 'version') { console.log('mcp-writecheck 0.0.0-test (MWS 0.9)'); process.exit(0); }
    if (cmd === 'requirements') { console.log('MWS-ANN-4\\tSHOULD\\tx'); process.exit(0); }
    process.exit(9);
  `.replace(/^\s+/gm, ''));
  writeFileSync(join(cli, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(cli, 'dist', 'src', 'requirements.js'), "export const SPEC_TEXT = 'spec/0.9-review@0000000';\n");
  mkdirSync(join(d, 'spec'));
  writeFileSync(join(d, 'spec', 'mws.md'), '# MWS (test)\n');
  const bin = join(d, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nFAKE_DOCKER_SEEN_ENV=$("${process.execPath}" -e 'console.log(JSON.stringify(Object.keys(process.env).sort()))')\nexport FAKE_DOCKER_SEEN_ENV\nFAKE_DOCKER_ROOT="${join(d, 'fake')}" exec "${process.execPath}" "${join(root, 'test', 'fixtures', 'corpus', 'fake-docker.mjs')}" "$@"\n`);
  spawnSync('chmod', ['755', join(bin, 'docker')]);
  mkdirSync(join(d, 'fake'));
  writeFileSync(join(d, 'fake', 'cli-exit'), '0');
  writeFileSync(join(d, 'images.json'), JSON.stringify({ runtime: IMG, uv: `ghcr.io/astral-sh/uv:0@sha256:${'b'.repeat(64)}` }));
  const art = join(d, 'srv.tgz');
  mkdirSync(join(d, 'srvsrc'));
  writeFileSync(join(d, 'srvsrc', 'srv'), '#!/bin/sh\n');
  spawnSync('tar', ['-czf', art, '-C', join(d, 'srvsrc'), 'srv']);
  const a = { url: pathToFileURL(art).href, file: 'srv.tgz', sha256: sha(readFileSync(art)) };
  const list = { format: TARGETS_FORMAT, ...(dropped ? { dropped } : {}), targets: targets.map((t) => ({ lane: 'ci', name: NAME, ecosystem: 'binary', package: NAME, version: '1',
    artifact: { 'linux-x64': a, 'linux-arm64': a }, server: { command: ['{{bin}}/srv'] }, init: false, ...t })) };
  writeFileSync(join(d, 'targets.json'), JSON.stringify(list));
  return d;
}

function drive(d, { only, fake = {}, env = {} } = {}) {
  for (const [k, v] of Object.entries(fake)) writeFileSync(join(d, 'fake', k), v);
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', join(d, 'cli'), '--cli-commit', 'f'.repeat(40),
    '--out', join(d, 'out'), '--images', join(d, 'images.json'), '--spec', join(d, 'spec', 'mws.md'), ...(only ? ['--only', only] : [])], {
    encoding: 'utf8', env: { ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH}`, CORPUS_ORDER_SEED: '00', ...env },
  });
  const log = join(d, 'fake', 'calls.jsonl');
  const records = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const calls = records.map((x) => x.argv);
  const meta = (id) => JSON.parse(readFileSync(join(d, 'out', id, 'meta.json'), 'utf8'));
  return { r, calls, records, meta, file: (id, f) => readFileSync(join(d, 'out', id, f), 'utf8') };
}

const MANIFEST = 'mws: "0.9"\nserver:\n  stdio: ["{{bin}}/srv"]\nresources: []\n';
const fullOf = (extra = {}) => ({ manifest: MANIFEST, confirm: 'mwsv-x', plan_hash: HASH, ...extra });
const pg = (extra = {}) => ({ image: IMG, port: 5432, setup: [{ exec: ['seed'] }], snapshot: { exec: ['dump', 'SNAPSHOT'] }, ...extra });

test('D1 / D2 / D4 / D6: a catalog run records format /3, env, the surface, the config source and the canary; public output unchanged', () => {
  const d = stand([{ id: 't01', canary: 'good' }]);
  const { r, meta, file } = drive(d);
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  assert.equal(r.stderr, '');
  const m = meta('t01');
  assert.equal(m.format, 'isokron-corpus-run/3');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.equal(m.canary, 'good');
  // D2
  assert.equal(m.env.node_version, 'v22.11.0');
  assert.equal(m.env.python_version, null);
  assert.match(m.env.python_version_why, /not on the target container's PATH/);
  assert.equal(m.env.docker_server_version, '29.0.0-fake');
  assert.ok(m.env.runner_image === null ? /not a GitHub-hosted runner/.test(m.env.runner_image_why) : typeof m.env.runner_image === 'string');
  assert.equal(m.env.cli_commit, 'f'.repeat(40));
  assert.equal(m.env.cli_version, '0.0.0-test');
  assert.equal(m.env.spec_sha256, sha('# MWS (test)\n'));
  assert.equal(m.env.spec_ref, 'spec/0.9-review@0000000');
  assert.deepEqual(m.env.backends, []);
  assert.deepEqual(m.env.images, [{ role: 'runtime', image_tag: 'docker.io/library/node:22-bookworm-slim', image_digest: `sha256:${'a'.repeat(64)}` }]);
  // D1: surface.json is the probe's answer; meta.surface is computed from it.
  const surface = JSON.parse(file('t01', 'surface.json'));
  assert.deepEqual(Object.keys(surface).slice(0, 3), ['initialize', 'tools', 'captured_at']);
  assert.equal(m.surface.file, 'surface.json');
  assert.equal(m.surface.sha256_jcs, sha256Jcs({ initialize: surface.initialize, tools: surface.tools }));
  assert.equal(m.surface.tool_count, 2);
  assert.deepEqual(m.surface.server_info, { name: NAME, version: '1.0.0' });
  assert.equal(m.surface.step.exit, 0);
  assert.equal(m.surface_why, undefined);
  // D4: entries that would leave the folder are dropped; the copy came back unchanged.
  assert.deepEqual(m.config_source, [{ path: 'pkg/node_modules/x/package.json', sha256: sha(`{"name":"${NAME}"}\n`), bytes: NAME.length + 12, rule: 'manifest', file: 'sandbox/config-source/pkg/node_modules/x/package.json' }]);
  assert.deepEqual(m.config_source_entry, { bin: 'srv', from: 'server.command[0]' });
  assert.equal(m.config_source_skipped[0].why, 'size limit');
  assert.deepEqual(m.full_runs, []);
  assert.deepEqual(m.backend_state, []);
  // The probe's output went to surface.json only, not into a log.
  assert.doesNotMatch(file('t01', 'logs/surface.log'), /protocolVersion/);
  assert.match(file('t01', 'logs/surface.log'), /bytes of stdout captured, not logged/);
});

test('D1 / D2 / D4: the probes run in the target\'s hardened sandbox: user 10001, no capability, read-only root; versions and config source with no network', () => {
  const d = stand([{ id: 't01' }]);
  const { calls } = drive(d);
  const runOf = (pred) => calls.filter((a) => a[0] === 'run' && pred(a.slice(a.indexOf(IMG) + 1)));
  const probes = [
    ...runOf((c) => c[0] === 'sh' && /node -v/.test(c[2] ?? '')),
    ...runOf((c) => c[1] === '/opt/mwsc/_corpus/config-source.mjs'),
    ...runOf((c) => c[1] === '/opt/mwsc/_corpus/surface.mjs'),
  ];
  assert.equal(probes.length, 3);
  for (const a of probes) {
    assert.equal(a[a.indexOf('--user') + 1], '10001:10001');
    assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
    assert.ok(a.includes('--read-only') && !a.includes('--cap-add') && !a.includes('--privileged'));
    assert.ok(!a.some((x) => x.startsWith('type=bind') || x.includes(d)), a.join(' '));
  }
  const net = (a) => a[a.indexOf('--network') + 1];
  assert.equal(net(probes[0]), 'none');
  assert.equal(net(probes[1]), 'none');
  assert.match(net(probes[2]), /-run$/, 'the surface probe starts the server on the internal network, like the CLI');
  const surface = probes[2];
  assert.deepEqual(surface.slice(surface.indexOf(IMG) + 1), ['node', '/opt/mwsc/_corpus/surface.mjs', '2025-11-25', '60000', '--', '/work/bin/srv']);
});

test('D3 / D5: three repeats against fresh backends; results/full-<i>/; snapshots before the first and after the last (and each repeat)', () => {
  const d = stand([{ id: 't01', backends: [pg()], setup: ['touch {{tdir}}/seeded'], full: fullOf({ repeats: 3 }) }]);
  const { r, calls, meta, file } = drive(d);
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  const m = meta('t01');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.deepEqual(m.steps.map((s) => s.step), ['plan', 'catalog', 'full', 'plan-2', 'full-2', 'plan-3', 'full-3']);
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.results_dir, f.status, f.cli_exit, f.plan_hash, f.writes, f.run_status]), [
    [1, 'sandbox/results/full-1', 'completed', 0, HASH, 11, 'complete'],
    [2, 'sandbox/results/full-2', 'completed', 0, HASH, 12, 'complete'],
    [3, 'sandbox/results/full-3', 'completed', 0, HASH, 13, 'complete'],
  ]);
  assert.equal(m.full_runs[1].reset, '/work restored from its clean copy; backends started again from their images and seeded; set-up run again');
  assert.deepEqual(m.full_runs.map((f) => f.fresh_state), [true, true, true]);
  assert.equal(m.backends[0].resets, 2);
  // /work: one clean copy after install, restored before repeats 2 and 3; the list's set-up ran three times.
  const sh = (a) => a[a.length - 1];
  assert.equal(calls.filter((a) => a[0] === 'run' && sh(a) === CLEAN_COPY).length, 1);
  const restores = calls.filter((a) => a[0] === 'run' && sh(a) === RESTORE_WORK);
  assert.equal(restores.length, 2);
  assert.equal(calls.find((a) => a[0] === 'run' && sh(a) === CLEAN_COPY).at(-3), 'bash');
  for (const a of restores) {
    assert.equal(a.at(-3), 'bash');
    assert.equal(a[a.indexOf('--memory') + 1], '2g');
    assert.equal(a[a.indexOf('--pids-limit') + 1], '256');
    assert.equal(a[a.indexOf('--user') + 1], '10001:10001');
    assert.equal(a[a.indexOf('--network') + 1], 'none');
    assert.ok(a.some((x) => /dst=\/clean,readonly$/.test(x)), a.join(' '));
  }
  assert.equal(calls.filter((a) => a[0] === 'run' && a.includes('touch /work/seeded')).length, 3);
  // No target container ever mounts the clean copy.
  for (const a of calls.filter((x) => x[0] === 'run' && x.includes('isokron.corpus.target=t01') && !/-h\d+$/.test(x[x.indexOf('--name') + 1]))) assert.ok(!a.some((x) => x.includes('dst=/clean')), a.join(' '));
  assert.ok(m.results.some((x) => x.folder === 'sandbox/results/full-2/run-2'));
  // Each repeat has its own results and state folders.
  const runs = calls.filter((a) => a[0] === 'run' && a.includes('/opt/mwsc/dist/src/cli/main.js') && a.includes('--plan-hash'));
  assert.deepEqual(runs.map((a) => [a[a.indexOf('--out') + 1], a[a.indexOf('--state') + 1]]), [1, 2, 3].map((i) => [`/work/out/results/full-${i}`, `/work/out/state/full-${i}`]));
  // Between repeats each backend is removed with its volumes, started again and seeded again.
  assert.equal(calls.filter((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === '-v' && /-t01-b0$/.test(a[3])).length, 2);
  assert.equal(calls.filter((a) => a[0] === 'run' && a.includes('-d')).length, 3);
  assert.equal(calls.filter((a) => a[0] === 'exec' && a.includes('seed')).length, 3);
  // D3: backend-0-before.txt is before full 1, backend-0-after.txt after full 3; each repeat has its own pair.
  const st = m.backend_state[0];
  assert.equal(st.backend, 0);
  assert.equal(st.before.file, 'backend-0-before.txt');
  assert.equal(file('t01', 'backend-0-before.txt'), `${NAME} rows: state 1\n`);
  assert.equal(st.before.sha256, sha(`${NAME} rows: state 1\n`));
  assert.equal(st.after.file, 'backend-0-after.txt');
  assert.equal(file('t01', 'backend-0-after.txt'), `${NAME} rows: state 6\n`);
  assert.deepEqual(st.repeats.map((x) => [x.i, x.before.file, x.after.file]), [1, 2, 3].map((i) => [i, `backend-0-full-${i}-before.txt`, `backend-0-full-${i}-after.txt`]));
  assert.equal(file('t01', 'backend-0-full-2-before.txt'), `${NAME} rows: state 3\n`);
  // The snapshot text is in its files only: not in the backend's log, not in the public output.
  assert.doesNotMatch(file('t01', 'logs/backend-0.log'), /rows: state/);
  assert.ok(!r.stdout.includes(NAME));
  assert.deepEqual(m.env.backends, [{ image_tag: 'docker.io/library/node:22-bookworm-slim', image_digest: `sha256:${'a'.repeat(64)}` }]);
});

const fileTarget = (extra = {}) => ({ id: 't14', setup: [{ exec: ['seed', 'CAPTURE', '{{tdir}}/db.sqlite'], capture: 'seed_check' }], snapshot: { exec: ['dump', 'SNAPSHOT', '{{tdir}}/db.sqlite', '{{seed_check}}'] },
  full: fullOf({ manifest: `${MANIFEST}# fixture {{seed_check}}\n`, repeats: 2 }), ...extra });

test('File targets: list-level capture and a target snapshot in the sandbox, before the first full run and after the last (and each repeat)', () => {
  const d = stand([fileTarget()]);
  const { r, calls, meta, file } = drive(d);
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  const m = meta('t14');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status, f.fresh_state]), [[1, 'completed', true], [2, 'completed', true]]);
  // The capture: the last line of stdout, recorded by name, filled into the manifest; its output is in the set-up log.
  assert.deepEqual(m.setup_captures, [{ step: 0, capture: 'seed_check' }]);
  assert.match(file('t14', 'writecheck.yaml'), /# fixture seed_check 1\n/);
  assert.match(file('t14', 'logs/setup.log'), /seed_check 1/);
  const seeds = calls.filter((a) => a[0] === 'run' && a.includes('CAPTURE'));
  assert.equal(seeds.length, 2, 'the set-up ran again before repeat 2');
  for (const a of seeds) {
    assert.deepEqual(a.slice(a.indexOf(IMG) + 1), ['seed', 'CAPTURE', '/work/db.sqlite'], 'argv as given, no sh -c');
    assert.match(a[a.indexOf('--network') + 1], /-run$/, 'like a shell line: the internal network');
    assert.ok(a.includes('TDIR=/work'));
  }
  // The snapshot: in the target's hardened sandbox, no network, never a backend exec.
  const snaps = calls.filter((a) => a.includes('SNAPSHOT'));
  assert.equal(snaps.length, 4);
  for (const a of snaps) {
    assert.equal(a[0], 'run');
    assert.deepEqual(a.slice(a.indexOf(IMG) + 1), ['dump', 'SNAPSHOT', '/work/db.sqlite', 'seed_check 1']);
    assert.equal(a[a.indexOf('--user') + 1], '10001:10001');
    assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(a[a.indexOf('--network') + 1], 'none');
    assert.ok(a.includes('--read-only') && !a.includes('--cap-add') && !a.includes('--privileged'));
    assert.ok(a.some((x) => /^type=volume,src=corpus-[a-z0-9-]+-t14,dst=\/work,readonly$/.test(x)), a.join(' '));
    assert.ok(!a.some((x) => x.startsWith('type=bind') || x.includes('dst=/clean') || x.includes('dst=/evidence')), a.join(' '));
  }
  // Before each full run, after each; the after snapshot only once the repeat's results were moved out of /work.
  const idx = (pred, from = 0) => calls.findIndex((a, k) => k >= from && pred(a));
  const full1 = idx((a) => a.includes('--plan-hash'));
  const ev1 = idx((a) => a.includes('/opt/mwsc/_corpus/evidence.mjs') && a.includes('results/full-1'));
  assert.ok(idx((a) => a.includes('SNAPSHOT')) < full1);
  assert.ok(ev1 > full1 && idx((a) => a.includes('SNAPSHOT'), full1) > ev1, 'after snapshot after the evidence move');
  const st = m.backend_state;
  assert.equal(st.length, 1);
  assert.equal(st[0].backend, 'target');
  assert.deepEqual([st[0].before.file, st[0].after.file], ['target-before.txt', 'target-after.txt']);
  assert.equal(file('t14', 'target-before.txt'), `${NAME} file rows: state 1\n`);
  assert.equal(file('t14', 'target-after.txt'), `${NAME} file rows: state 4\n`);
  assert.equal(st[0].after.sha256, sha(`${NAME} file rows: state 4\n`));
  assert.deepEqual(st[0].repeats.map((x) => [x.i, x.before.file, x.after.file]), [1, 2].map((i) => [i, `target-full-${i}-before.txt`, `target-full-${i}-after.txt`]));
  // Never logged: not in any log, not in the public output.
  for (const f of readdirSync(join(d, 'out', 't14', 'logs'))) assert.doesNotMatch(file('t14', `logs/${f}`), /file rows: state/, f);
  assert.match(file('t14', 'logs/snapshot.log'), /bytes of stdout captured, not logged/);
  assert.ok(!r.stdout.includes(NAME));
});

test('File targets: a list-level capture that changes refuses the repeat; a failed snapshot is null with its reason; a bad entry is refused at load', () => {
  const d = stand([fileTarget()]);
  const m = drive(d, { fake: { 'list-capture-values': 'seed_check 1\nseed_check 2\n' } }).meta('t14');
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status, f.fresh_state]), [[1, 'completed', true], [2, 'not_started', false]]);
  assert.match(m.full_runs[1].why, /set-up capture changed after the reset \(seed_check\)/);
  assert.equal(m.backend_state[0].after.file, 'target-after.txt', 'after the last repeat that ran');
  const d2 = stand([fileTarget({ full: fullOf() })]);
  const m2 = drive(d2, { fake: { 'tsnapshot-exit': '3' } }).meta('t14');
  assert.equal(m2.status, 'completed', m2.harness_error);
  assert.deepEqual(m2.backend_state, [{ backend: 'target', before: null, before_why: 'snapshot exec: exit 3', after: null, after_why: 'snapshot exec: exit 3' }]);
  assert.ok(!existsSync(join(d2, 'out', 't14', 'target-before.txt')));
  // No full run: the record says so.
  const d3 = stand([fileTarget({ full: undefined })]);
  assert.deepEqual(drive(d3).meta('t14').backend_state, [{ backend: 'target', before: null, before_why: 'no CLI step that writes ran', after: null, after_why: 'no CLI step that writes ran' }]);
  const d4 = stand([fileTarget({ snapshot: { exec: ['dump'], user: 'root' } }), { id: 't15', setup: [{ exec: ['seed'], capture: 'c', volatile: true }] }]);
  const { calls, meta } = drive(d4);
  assert.match(meta('t14').harness_error, /refused at load: snapshot: a target snapshot always runs as the sandbox user/);
  assert.match(meta('t15').harness_error, /refused at load: set-up 0: volatile is for backends/);
  assert.ok(!calls.some((a) => a[0] === 'run' && (a.includes('dump') || a.includes('seed'))), 'nothing of a refused entry runs');
});

test('File targets: the target snapshot mounts /work read-only and gets the base sandbox env and TDIR, never server.env', () => {
  const d = stand([fileTarget({ full: fullOf(), server: { command: ['{{bin}}/srv'], env: { MODE: 'zz-mode', API_TOKEN: 'zz-token-value' } } })]);
  const { records, meta } = drive(d);
  assert.equal(meta('t14').status, 'completed', meta('t14').harness_error);
  const snaps = records.filter((x) => x.argv.includes('SNAPSHOT'));
  assert.equal(snaps.length, 2);
  for (const { argv: a, env, secrets } of snaps) {
    const mounts = a.filter((x, k) => a[k - 1] === '--mount');
    assert.ok(mounts.some((x) => /^type=volume,src=corpus-[a-z0-9-]+-t14,dst=\/work,readonly$/.test(x)), mounts.join(' '));
    assert.ok(mounts.every((x) => x.endsWith(',readonly')), `every volume read-only: ${mounts.join(' ')}`);
    assert.ok(a.includes('TDIR=/work') && a.includes('HOME=/work/home') && a.includes('CORPUS_SANDBOX=1'), a.join(' '));
    assert.ok(!a.some((x) => /^(MODE|API_TOKEN)(=|$)/.test(x)), a.join(' '));
    assert.ok(!env.includes('API_TOKEN') && !('API_TOKEN' in secrets), 'not passed through the client env either');
  }
  // The set-up still gets server.env (as before).
  const seed = records.find((x) => x.argv.includes('CAPTURE')).argv;
  assert.ok(seed.includes('MODE=zz-mode'), seed.join(' '));
});

test('Snapshots: an after snapshot has its own time limit, so a repeat that used all of full.timeout_s still gets one', () => {
  const d = stand([fileTarget({ timeout_s: 300, backends: [pg()], full: fullOf({ timeout_s: 1 }) })]);
  // The CLI step runs past the repeat's 1 s; each after snapshot (the second of each kind) then takes 1.5 s.
  const m = drive(d, { fake: { 'run-sleep-ms': '20000', 'tsnapshot-sleep-ms': '0\n1500\n', 'snapshot-sleep-ms': '0\n1500\n' } }).meta('t14');
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status]), [[1, 'timeout']]);
  const [b0, tg] = m.backend_state;
  assert.equal(b0.backend, 0);
  assert.equal(b0.after?.file, 'backend-0-after.txt', JSON.stringify(b0));
  assert.equal(tg.backend, 'target');
  assert.equal(tg.after?.file, 'target-after.txt', JSON.stringify(tg));
  assert.equal(tg.after_why, undefined);
});

test('File targets: a repeat whose evidence was not moved gets no target after snapshot; a backend\'s still runs', () => {
  const d = stand([fileTarget({ backends: [pg()] })]);
  const { calls, meta } = drive(d, { fake: { 'evidence-fail': 'results/full-2' } });
  const m = meta('t14');
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status, f.evidence.moved]), [[1, 'completed', true], [2, 'completed', false]]);
  // Target: before 1, after 1, before 2; no after 2.
  assert.equal(calls.filter((a) => a[0] === 'run' && a.includes('SNAPSHOT')).length, 3);
  const [b0, tg] = m.backend_state;
  assert.equal(tg.after, null);
  assert.equal(tg.after_why, 'evidence not moved');
  assert.deepEqual(tg.repeats.map((x) => [x.i, x.after?.file ?? null, x.after_why ?? null]), [[1, 'target-full-1-after.txt', null], [2, null, 'evidence not moved']]);
  assert.ok(!existsSync(join(d, 'out', 't14', 'target-after.txt')));
  assert.equal(b0.after.file, 'backend-0-after.txt');
  assert.deepEqual(b0.repeats.map((x) => x.after?.file), ['backend-0-full-1-after.txt', 'backend-0-full-2-after.txt']);
});

test('Load checks: a list-level capture in a backend\'s env, args, wait or set-up or in a fetch step; a volatile capture in a snapshot', () => {
  const ok = { id: 't14', setup: [{ exec: ['seed'], capture: 'seed_check' }], server: { command: ['{{bin}}/srv'] } };
  assert.doesNotThrow(() => validateTarget({ ...ok, backends: [{ image: 'x', snapshot: { exec: ['dump', '{{seed_check}}'] } }] }), 'a backend snapshot runs after the list set-up');
  for (const [b, field] of [[{ env: { X: 'a{{seed_check}}' } }, 'backends\\[0\\]\\.env'], [{ args: ['--x={{seed_check}}'] }, 'backends\\[0\\]\\.args'],
    [{ wait: ['probe', '{{seed_check}}'] }, 'backends\\[0\\]\\.wait'], [{ setup: [{ exec: ['echo', '{{seed_check}}'] }] }, 'backends\\[0\\]\\.setup']]) {
    assert.throws(() => validateTarget({ ...ok, backends: [{ image: 'x', ...b }] }), new RegExp(`list-level capture seed_check is used in ${field}`), JSON.stringify(b));
  }
  const fetch = { fetch: { url: 'https://example.com/{{seed_check}}.tgz', sha256: 'a'.repeat(64) } };
  assert.throws(() => listCaptures({ ...ok, setup: [...ok.setup, fetch] }), /seed_check is used in set-up 1 fetch/);
  // Volatile: refused in a target or a backend snapshot (its output is kept unscrubbed), as in server.command.
  const vol = { image: 'x', setup: [{ exec: ['mint'], capture: 'tok', volatile: true }] };
  assert.throws(() => validateTarget({ id: 't14', server: { command: ['srv'] }, backends: [vol], snapshot: { exec: ['dump', '{{tok}}'] } }), /volatile capture tok is used in snapshot\.exec/);
  assert.throws(() => validateTarget({ id: 't14', server: { command: ['srv'] }, backends: [{ ...vol, snapshot: { exec: ['dump', '--auth={{tok}}'] } }] }), /volatile capture tok is used in backends\[0\]\.snapshot\.exec/);
  assert.doesNotThrow(() => validateTarget({ id: 't14', server: { command: ['srv'], env: { T: '{{tok}}' } }, backends: [{ ...vol, snapshot: { exec: ['dump'] } }] }));
});

test('D5: a repeat whose plan hash is not the accepted one is refused, and no later repeat runs', () => {
  const d = stand([{ id: 't01', backends: [pg()], full: fullOf({ repeats: 3 }) }]);
  const { r, calls, meta } = drive(d, { fake: { 'plan-hashes': `${HASH}\nffffffffffffffff\n` } });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  const m = meta('t01');
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status, f.plan_hash]), [[1, 'completed', HASH], [2, 'not_started', 'ffffffffffffffff']]);
  assert.match(m.full_runs[1].why, /not the accepted one/);
  assert.deepEqual(m.plan_drift_repeat, { i: 2, accepted: HASH, seen: 'ffffffffffffffff' });
  assert.equal(calls.filter((a) => a.includes('/opt/mwsc/dist/src/cli/main.js') && a.includes('--plan-hash')).length, 1, 'only the first repeat ran');
  assert.equal(m.backend_state[0].after.file, 'backend-0-after.txt', 'after the last repeat that ran');
  // The first plan drifting: no repeat at all, as before (plan_drift), and no snapshot.
  const d2 = stand([{ id: 't02', backends: [pg()], full: fullOf({ repeats: 3 }) }]);
  const m2 = drive(d2, { fake: { 'plan-hashes': 'ffffffffffffffff\n' } }).meta('t02');
  assert.deepEqual(m2.full_runs, []);
  assert.ok(m2.plan_drift);
  assert.deepEqual(m2.backend_state, [{ backend: 0, before: null, before_why: 'no CLI step that writes ran', after: null, after_why: 'no CLI step that writes ran', repeats: [] }]);
});

test('D5: a seed whose capture changes after the reset refuses the repeat (the manifest was filled with the first value)', () => {
  const d = stand([{ id: 't01', backends: [pg({ setup: [{ exec: ['seed', 'CAPTURE'], capture: 'seed_id' }] })], full: fullOf({ repeats: 2 }) }]);
  const m = drive(d, { fake: { 'capture-values': 'id-1\nid-2\n' } }).meta('t01');
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status]), [[1, 'completed'], [2, 'not_started']]);
  assert.match(m.full_runs[1].why, /set-up capture changed after the reset \(seed_id\)/);
  // The same value after the reset: the repeat runs.
  const d2 = stand([{ id: 't01', backends: [pg({ setup: [{ exec: ['seed', 'CAPTURE'], capture: 'seed_id' }] })], full: fullOf({ repeats: 2 }) }]);
  assert.deepEqual(drive(d2, { fake: { 'capture-values': 'id-1\n' } }).meta('t01').full_runs.map((f) => f.status), ['completed', 'completed']);
});

test('D8: full.timeout_s gives each repeat its own time limit; the target\'s limit is timeout_s + repeats x full.timeout_s', () => {
  const d = stand([{ id: 't01', timeout_s: 300, full: fullOf({ repeats: 2, timeout_s: 1 }) }]);
  const t0 = Date.now();
  const { r, meta } = drive(d, { fake: { 'run-sleep-ms': '20000' } });
  assert.ok(Date.now() - t0 < 30_000, 'each repeat stopped at its own limit');
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 124\n`);
  const m = meta('t01');
  assert.equal(m.status, 'timeout');
  assert.equal(m.timeout_s, 302);
  assert.deepEqual(m.time_limits, { base_s: 300, full_s: 1, repeats: 2, total_s: 302 });
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status]), [[1, 'timeout'], [2, 'timeout']], 'the second repeat had its own budget');
  assert.deepEqual(m.steps.filter((s) => s.timed_out).map((s) => s.step), ['full', 'full-2']);
});

test('D1 / D4 / D7: a failed probe, a config file changed after the copy, a dropped id, a bad snapshot: recorded, not hidden', () => {
  const d = stand([
    { id: 't01' },
    { id: 't05' },
    { id: 't06', backends: [{ image: IMG, port: 1, snapshot: { exec: 'dump' } }] },
    { id: 't07', full: fullOf({ repeats: 0 }) },
  ], { dropped: [{ id: 't05', dropped_at: '2026-11-17', reason: 'withdrawn' }] });
  const { r, meta, file } = drive(d, { fake: { 'surface-fail': '1', 'config-tamper': '1' } });
  assert.equal(r.stdout.split('\n')[0], LABEL);
  assert.deepEqual(r.stdout.split('\n').slice(1).filter(Boolean).sort(), ['run finished, exit 0', 'run finished, exit 125', 'run finished, exit 125', 'run finished, exit 125']);
  const m = meta('t01');
  assert.equal(m.status, 'completed', 'a failed probe does not decide the status');
  assert.equal(m.surface, null);
  assert.match(m.surface_why, /^initialize: the server exited/);
  assert.equal(JSON.parse(file('t01', 'surface.json')).initialize, null);
  assert.equal(m.config_source[0].changed_after_copy, true);
  assert.equal(m.config_source[0].sha256_in_bundle, sha('changed'));
  assert.match(meta('t05').harness_error, /refused at load: id t05 was dropped and is never reused/);
  assert.match(meta('t06').harness_error, /refused at load: backend 0: snapshot\.exec/);
  assert.match(meta('t07').harness_error, /refused at load: full\.repeats/);
  // A refused target still has the new fields, null with a reason.
  assert.equal(meta('t05').surface, null);
  assert.ok(meta('t05').surface_why);
  assert.equal(meta('t05').env.node_version, null);
  assert.ok(meta('t05').env.node_version_why);
  // A dropped[] the driver cannot read refuses the whole list (the never-reuse rule needs it).
  const d2 = stand([{ id: 't01' }], { dropped: [{ id: 't05' }] });
  const r2 = drive(d2).r;
  assert.equal(r2.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(readFileSync(join(d2, 'out', '_shard', 'harness-error.txt'), 'utf8'), /dropped 0 \(t05\): dropped_at/);
});

test('D5: without a clean copy of /work a repeat runs, recorded as fresh_state: false with the reason', () => {
  const d = stand([{ id: 't01', setup: ['touch {{tdir}}/seeded'], full: fullOf({ repeats: 2 }) }]);
  const m = drive(d, { fake: { 'clean-fail': '1' } }).meta('t01');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status, f.fresh_state]), [[1, 'completed', true], [2, 'completed', false]]);
  assert.match(m.full_runs[1].fresh_state_why, /no clean copy of \/work: clean copy: exit 1/);
  assert.equal(m.full_runs[1].reset, 'set-up run again');
});

test('D1 / D5: hostile answers cannot stop a target or the shard: a too-deep initialize, a results.json with an object status', () => {
  const d = stand([{ id: 't01' }, { id: 't02' }]);
  // why: built as text, not with JSON.stringify of a nested value, which overflows the smaller stack of Node 22 (CI).
  const deepStatus = `{"run":{"status":${'['.repeat(100000)}${']'.repeat(100000)},"writes":1e400}}`;
  const { r, meta } = drive(d, { fake: { 'surface-deep': '100000', 'catalog-results': deepStatus } });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\nrun finished, exit 0\n`);
  for (const id of ['t01', 't02']) {
    const m = meta(id);
    assert.equal(m.status, 'completed', m.harness_error);
    assert.equal(m.surface, null);
    assert.match(m.surface_why, /could not be recorded|gave no answer/);
    assert.equal(m.results[0].status, null);
  }
});

test('D8: a list that plans more than one job allows is refused at load, naming the target', () => {
  const d = stand([{ id: 't01', timeout_s: 600 }, { id: 't02', timeout_s: 600 }]);
  const { r } = drive(d, { env: { CORPUS_SHARD_BUDGET_S: '1000' } });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(readFileSync(join(d, 'out', '_shard', 'harness-error.txt'), 'utf8'), /shard time budget: with t02 this shard plans 1200 s, over the 1000 s/);
});

test('D4: config source: nothing is read through a symlink anywhere on its path; a linked package root is refused', () => {
  const work = mkdtempSync(join(tmpdir(), 'corpus-cs-ln-'));
  const real = join(work, 'elsewhere');
  mkdirSync(join(real, 'lib'), { recursive: true });
  writeFileSync(join(real, 'package.json'), '{}');
  writeFileSync(join(real, 'lib', 'config.js'), 'x');
  mkdirSync(join(work, 'pkg', 'node_modules'), { recursive: true });
  symlinkSync(real, join(work, 'pkg', 'node_modules', 'linked'));
  const r1 = collect({ work, ecosystem: 'npm', pkg: 'linked', binDir: join(work, 'bin'), bin: '', outDir: join(work, 'o1') });
  assert.deepEqual(r1.files, []);
  assert.match(r1.why, /symlink/);
  // A symlinked folder above the package (pkg/node_modules itself).
  const w2 = mkdtempSync(join(tmpdir(), 'corpus-cs-ln2-'));
  mkdirSync(join(w2, 'real-nm', 'p'), { recursive: true });
  writeFileSync(join(w2, 'real-nm', 'p', 'package.json'), '{}');
  mkdirSync(join(w2, 'pkg'));
  symlinkSync(join(w2, 'real-nm'), join(w2, 'pkg', 'node_modules'));
  assert.match(collect({ work: w2, ecosystem: 'npm', pkg: 'p', binDir: join(w2, 'bin'), bin: '', outDir: join(w2, 'o') }).why, /symlink/);
  // A PyPI RECORD path through a symlinked folder inside site-packages is skipped, not followed.
  const w3 = mkdtempSync(join(tmpdir(), 'corpus-cs-ln3-'));
  const site = join(w3, 'venv', 'lib', 'python3.12', 'site-packages');
  mkdirSync(join(site, 'p-1.0.dist-info'), { recursive: true });
  mkdirSync(join(w3, 'outside'));
  writeFileSync(join(w3, 'outside', 'config.py'), 'secret');
  symlinkSync(join(w3, 'outside'), join(site, 'p'));
  writeFileSync(join(site, 'p-1.0.dist-info', 'METADATA'), 'Name: p\n');
  writeFileSync(join(site, 'p-1.0.dist-info', 'RECORD'), 'p/config.py,,\np-1.0.dist-info/METADATA,,\n');
  const r3 = collect({ work: w3, ecosystem: 'pypi', pkg: 'p', binDir: join(w3, 'venv', 'bin'), bin: '', outDir: join(w3, 'o') });
  assert.deepEqual(r3.files.map((f) => f.rule), ['manifest']);
  assert.ok(!r3.files.some((f) => f.path.endsWith('config.py')));
  assert.equal(noLinks(w3, join(site, 'p', 'config.py')), false);
  assert.equal(noLinks(w3, join(site, 'p-1.0.dist-info', 'METADATA')), true);
  assert.equal(noLinks(w3, '/etc/hosts'), false);
});

test('D7: ids that would name the driver\'s own Docker objects are reserved; the list is refused at load', () => {
  for (const id of ['cli', 'tools', 'uvsrc', 'shard', 't01-clean', 't01-evidence', 't01-egress', 't01-run', 't01-b0', 't01-h12', 't01-3']) {
    assert.throws(() => checkId(id), /is reserved/, id);
  }
  for (const id of ['t01', 't999', 'clean', 'tools-x', 'run-t01', 'b0']) assert.doesNotThrow(() => checkId(id), id);
  assert.ok(RESERVED_ID.test('cli'));
  const d = stand([{ id: 't01' }, { id: 't01-clean' }]);
  const { r } = drive(d);
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(readFileSync(join(d, 'out', '_shard', 'harness-error.txt'), 'utf8'), /target id t01-clean is reserved/);
});

test('D5: a volume that exists already is never used as a fresh one (the CLI\'s, the tools\' or a target\'s)', () => {
  const d = stand([{ id: 't01' }, { id: 't02' }]);
  const { r, calls, meta } = drive(d, { fake: { 'volume-exists': '-t01\n' } });
  assert.deepEqual(r.stdout.split('\n').slice(1).filter(Boolean).sort(), ['run finished, exit 0', 'run finished, exit 125']);
  assert.match(meta('t01').harness_error, /volume corpus-\w+-t01 exists already/);
  assert.equal(meta('t02').status, 'completed', meta('t02').harness_error);
  assert.ok(!calls.some((a) => a[0] === 'volume' && a[1] === 'create' && a.at(-1).endsWith('-t01')), 'never created (reused)');
  const d2 = stand([{ id: 't01' }]);
  const r2 = drive(d2, { fake: { 'volume-exists': '-cli\n' } });
  assert.equal(r2.r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(readFileSync(join(d2, 'out', '_shard', 'harness-error.txt'), 'utf8'), /volume corpus-\w+-cli exists already/);
});

test('D5 evidence: moveEvidence moves regular files and folders only, removes the originals, and lists what it moved', () => {
  const w = mkdtempSync(join(tmpdir(), 'corpus-ev-'));
  const from = join(w, 'out');
  const to = join(w, 'evidence');
  mkdirSync(join(from, 'results', 'full-1', 'r'), { recursive: true });
  mkdirSync(to);
  writeFileSync(join(from, 'results', 'full-1', 'r', 'results.json'), '{"run":{}}');
  writeFileSync(join(from, 'results', 'full-1', 'r', 'report.md'), '# r');
  symlinkSync('/etc/hosts', join(from, 'results', 'full-1', 'r', 'link'));
  spawnSync('mkfifo', [join(from, 'results', 'full-1', 'fifo')]);
  const res = moveEvidence(from, to, ['results/full-1', 'state/full-1']);
  assert.deepEqual(res.files.map((f) => f.path), ['results/full-1/r/report.md', 'results/full-1/r/results.json']);
  assert.equal(res.files[1].sha256, sha('{"run":{}}'));
  assert.equal(res.skipped, 2, 'the symlink and the fifo');
  assert.deepEqual(res.missing, ['state/full-1']);
  assert.ok(!existsSync(join(from, 'results', 'full-1')), 'the original is gone');
  assert.equal(res.sha256, listingHash(res.files));
  assert.equal(listTree(to, ['results/full-1']).sha256, res.sha256);
  writeFileSync(join(to, 'results', 'full-1', 'r', 'report.md'), '# changed');
  assert.notEqual(listTree(to, ['results/full-1']).sha256, res.sha256);
  // results/catalog-* is every catalog folder; a single file moves too; only the listed paths are accepted.
  mkdirSync(join(from, 'results', 'catalog-a'), { recursive: true });
  mkdirSync(join(from, 'results', 'other'));
  writeFileSync(join(from, 'results', 'catalog-a', 'catalog.json'), '{}');
  writeFileSync(join(from, 'init-draft.yaml'), 'mws: "0.9"');
  const r2 = moveEvidence(from, to, ['results/catalog-*', 'init-draft.yaml']);
  assert.deepEqual(r2.moved, ['results/catalog-a', 'init-draft.yaml']);
  assert.deepEqual(r2.files.map((f) => f.path), ['init-draft.yaml', 'results/catalog-a/catalog.json']);
  assert.ok(existsSync(join(from, 'results', 'other')) && !existsSync(join(from, 'init-draft.yaml')));
  for (const ok of ['config-source', 'init-draft.yaml', 'results/catalog-*', 'results/full-3', 'state/full-10']) assert.ok(EVIDENCE_PATH.test(ok), ok);
  for (const bad of ['results', '../x', 'results/catalog-a', 'state/full-1/x', 'out']) assert.ok(!EVIDENCE_PATH.test(bad), bad);
});

test('D5 evidence: each finished repeat is moved out of /work, hashed, and checked again at copy-out', () => {
  const d = stand([{ id: 't01', full: fullOf({ repeats: 2 }) }]);
  const { calls, meta, file } = drive(d, { fake: { 'plant-after-move': '1' } });
  const m = meta('t01');
  assert.equal(m.status, 'completed', m.harness_error);
  for (const fr of m.full_runs) {
    assert.match(fr.results_sha256, /^[0-9a-f]{64}$/);
    assert.equal(fr.results_tampered, false);
    assert.equal(fr.evidence.moved, true);
    const side = JSON.parse(file('t01', fr.results_files));
    assert.deepEqual(side.files.map((x) => x.path), [`results/full-${fr.i}/run-${fr.i}/results.json`, `state/full-${fr.i}/ledger.jsonl`]);
    assert.equal(side.sha256, fr.results_sha256);
  }
  // Repeat 2's target code planted a forged repeat-1 result in /work/out: removed, recorded, and the
  // moved original is what the bundle holds.
  assert.equal(m.full_runs[0].planted_after_move, true);
  assert.equal(m.full_runs[0].writes, 11);
  assert.equal(JSON.parse(file('t01', 'sandbox/results/full-1/run-1/results.json')).run.writes, 11);
  // The evidence helper: ours, as 10001, no network, bounded; the evidence volume is mounted by helpers only.
  const ev = calls.filter((a) => a[0] === 'run' && a.includes('/opt/mwsc/_corpus/evidence.mjs'));
  assert.deepEqual(ev.map((a) => a.slice(a.indexOf('/evidence', a.indexOf('/opt/mwsc/_corpus/evidence.mjs') + 1) + 1)), [['config-source'], ['results/catalog-*'], ['results/full-1', 'state/full-1'], ['results/full-2', 'state/full-2']]);
  for (const a of ev) {
    assert.equal(a[a.indexOf('--user') + 1], '10001:10001');
    assert.equal(a[a.indexOf('--network') + 1], 'none');
    assert.equal(a[a.indexOf('--memory') + 1], '2g');
  }
  for (const a of calls.filter((x) => x[0] === 'run' && !/-h\d+$/.test(x[x.indexOf('--name') + 1] ?? ''))) assert.ok(!a.some((x) => x.includes('dst=/evidence')), a.join(' '));
  assert.throws(() => sandboxRunArgs({ name: 'n', image: IMG, network: 'none', mounts: [{ src: 'corpus-x-evidence', dst: '/evidence' }], cmd: ['true'] }), /never mounts the evidence/);
  // A change between the listing and the bundle shows as results_tampered.
  const d2 = stand([{ id: 't01', full: fullOf() }]);
  const m2 = drive(d2, { fake: { 'evidence-tamper': '1' } }).meta('t01');
  assert.equal(m2.full_runs[0].results_tampered, true);
  assert.match(m2.full_runs[0].results_sha256_in_bundle, /^[0-9a-f]{64}$/);
});

test('evidence before the repeats: config source, init draft and catalog results are moved right after their step and checked at copy-out', () => {
  const d = stand([{ id: 't01', full: fullOf({ repeats: 2 }) }]);
  const { calls, meta, file } = drive(d, { fake: { 'plant-catalog': '1' } });
  const m = meta('t01');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.deepEqual(m.evidence.map((e) => [e.step, e.moved, e.tampered]), [['config-source', true, false], ['catalog', true, false]]);
  const cat = m.evidence.find((e) => e.step === 'catalog');
  assert.deepEqual(cat.moved_paths, ['results/catalog-x']);
  assert.match(cat.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(file('t01', cat.files)).files.map((f) => f.path), ['results/catalog-x/results.json']);
  // A full repeat's target code rewrote the catalog result and added another catalog folder in /work/out:
  // both are detected and removed; the bundle holds the catalog's own result.
  assert.equal(cat.planted_after_move, true);
  assert.equal(JSON.parse(file('t01', 'sandbox/results/catalog-x/results.json')).run.status, 'complete');
  assert.ok(!existsSync(join(d, 'out', 't01', 'sandbox', 'results', 'catalog-zzz')));
  assert.deepEqual(m.results.filter((r) => r.folder.includes('catalog-')).map((r) => [r.folder, r.status]), [['sandbox/results/catalog-x', 'complete']]);
  // The catalog's move ran after the catalog step and before the first full run.
  const order = calls.filter((a) => a[0] === 'run').map((a) => (a.includes('results/catalog-*') ? 'move' : a.includes('catalog') && a.includes('/opt/mwsc/dist/src/cli/main.js') ? 'catalog' : a.includes('--plan-hash') ? 'full' : null)).filter(Boolean);
  assert.deepEqual(order.slice(0, 3), ['catalog', 'move', 'full']);
  // A change between the listing and the bundle shows as tampered for that step.
  const d2 = stand([{ id: 't01' }]);
  const m2 = drive(d2, { fake: { 'evidence-tamper': '1' } }).meta('t01');
  assert.deepEqual(m2.evidence.map((e) => [e.step, e.tampered]), [['config-source', true], ['catalog', true]]);
  // The init draft, when init runs, is moved right after it (init exits 4 in the stand-in: nothing to move).
  const d3 = stand([{ id: 't01', init: true }]);
  const m3 = drive(d3).meta('t01');
  assert.deepEqual(m3.evidence.map((e) => e.step), ['config-source', 'init', 'catalog']);
  assert.deepEqual(m3.evidence[1].missing, ['init-draft.yaml']);
});

// ------------------------------------------------------------------------------------------------
// Volatile set-up captures (a backend that mints a new token on every start)
// ------------------------------------------------------------------------------------------------

const mint = (extra = {}) => ({ exec: ['mint', 'CAPTURE'], capture: 'tok', volatile: true, ...extra });

test('volatile: only on a step with capture; its name may reach server.env only, never server.command or full.manifest', () => {
  const tgt = (setup, more = {}) => ({ id: 't23', backends: [{ image: IMG, port: 3000, setup }], server: { command: ['{{bin}}/srv'], env: { GIT_TOKEN: '{{tok}}' } }, ...more });
  assert.deepEqual([...volatileCaptures(tgt([{ exec: ['seed'] }, mint()]))], ['tok']);
  assert.doesNotThrow(() => validateTarget(tgt([mint()])));
  assert.doesNotThrow(() => validateTarget(tgt([mint({ volatile: false })])));
  assert.throws(() => validateTarget(tgt([{ exec: ['mint'], volatile: true }])), /backend 0 set-up 0: volatile is only for a step with capture/);
  assert.throws(() => validateTarget(tgt([mint({ volatile: 'yes' })])), /volatile must be true or false/);
  assert.throws(() => validateTarget(tgt([mint(), { exec: ['x'], capture: 'tok' }])), /capture tok is volatile in one set-up step and not in another/);
  // In server.command or full.manifest it would change the manifest (and the plan hash) on every repeat.
  assert.throws(() => validateTarget(tgt([mint()], { server: { command: ['{{bin}}/srv', '--token={{tok}}'] } })), /volatile capture tok is used in server\.command: a volatile value may reach server\.env only, so that the manifest and its plan hash stay the same on every repeat/);
  assert.throws(() => validateTarget(tgt([mint()], { full: { manifest: 'server:\n  env: { T: "{{tok}}" }\n', plan_hash: HASH, confirm: 'x' } })), /volatile capture tok is used in full\.manifest/);
  // A non-volatile capture may still be used anywhere, as before.
  assert.doesNotThrow(() => validateTarget(tgt([{ exec: ['seed'], capture: 'tok' }], { full: { manifest: 'x: "{{tok}}"', plan_hash: HASH, confirm: 'x' } })));
  // Refused at load: nothing of the target runs, the others do.
  const { invalid } = validateList({ format: TARGETS_FORMAT, targets: [tgt([{ exec: ['mint'], volatile: true }]), { id: 't01' }] });
  assert.deepEqual([...invalid.keys()], ['t23']);
});

test('volatile: a token minted again on every reset refreshes the server env; 3 repeats complete; the values are never in meta', () => {
  const d = stand([{ id: 't23', backends: [pg({ setup: [{ exec: ['seed'] }, mint()] })], server: { command: ['{{bin}}/srv'], env: { GIT_TOKEN: '{{tok}}' } }, full: fullOf({ repeats: 3 }) }]);
  const { r, calls, records, meta, file } = drive(d, { fake: { 'capture-values': 'tok-AAA1\ntok-BBB2\ntok-CCC3\n' } });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  const m = meta('t23');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.deepEqual(m.full_runs.map((f) => [f.i, f.status, f.plan_hash]), [[1, 'completed', HASH], [2, 'completed', HASH], [3, 'completed', HASH]]);
  assert.deepEqual(m.full_runs.map((f) => f.volatile_refreshed ?? null), [null, ['tok'], ['tok']]);
  // Each repeat's plan and run get that repeat's token in the server env.
  // The token is given to Docker through the client's environment (`--env GIT_TOKEN`, no value on the argv).
  const cli = (sub) => records.filter((x) => x.argv[0] === 'run' && x.argv.includes('/opt/mwsc/dist/src/cli/main.js') && x.argv.includes(sub));
  for (const x of cli('--plan-hash')) assert.ok(x.argv.includes('GIT_TOKEN') && !x.argv.some((a) => a.startsWith('GIT_TOKEN=')), x.argv.join(' '));
  assert.deepEqual(cli('--plan-hash').map((x) => x.secrets.GIT_TOKEN), ['tok-AAA1', 'tok-BBB2', 'tok-CCC3']);
  assert.deepEqual(cli('plan').map((x) => x.secrets.GIT_TOKEN), ['tok-AAA1', 'tok-BBB2', 'tok-CCC3']);
  // The manifest is the same on every repeat (written again from the same text).
  const manifests = calls.filter((a) => a[0] === 'run' && a.join(' ').includes('cat > "$1"') && a.at(-1) === '/work/writecheck.yaml');
  assert.equal(manifests.length, 3);
  // Names only: no value in meta.json, and the capture's output is not copied into the backend's log.
  const text = file('t23', 'meta.json');
  for (const v of ['tok-AAA1', 'tok-BBB2', 'tok-CCC3']) assert.ok(!text.includes(v), v);
  assert.doesNotMatch(file('t23', 'logs/backend-0.log').replace(/GIT_TOKEN=\S+/g, ''), /tok-(AAA1|BBB2|CCC3)/);
  // A non-volatile capture that changes still refuses the repeat, as before.
  const d2 = stand([{ id: 't23', backends: [pg({ setup: [mint({ volatile: false })] })], server: { command: ['{{bin}}/srv'], env: { GIT_TOKEN: '{{tok}}' } }, full: fullOf({ repeats: 3 }) }]);
  const m2 = drive(d2, { fake: { 'capture-values': 'a\nb\n' } }).meta('t23');
  assert.deepEqual(m2.full_runs.map((f) => f.status), ['completed', 'not_started']);
  assert.match(m2.full_runs[1].why, /set-up capture changed after the reset \(tok\)/);
});

// ------------------------------------------------------------------------------------------------
// Logged command lines: secrets redacted, the real argv unchanged
// ------------------------------------------------------------------------------------------------

test('redactArgv: volatile values, secret-like env names, URL user info; the argv itself is not changed', () => {
  const argv = ['run', '--env', 'GIT_TOKEN=tok-AAA1', '--env', 'DATABASE_URL=postgres://mwsc:pw-123@b0:5432/db', '--env', 'REDIS_URL=redis://b0:6379/0',
    '--env', 'API_URL=https://h/x?key=k1', '--env', 'PG_DSN=host=b0 password=pw', '--env', 'POSTGRES_PASSWORD=pw', '--env', 'HOME=/work/home', '--env', 'PATH=/usr/bin',
    '--env', 'SHORTV=a1b', IMG, 'sh', '-c', 'git clone https://u:sekret@h/r && echo tok-AAA1 && curl http://h/no-userinfo'];
  const before = [...argv];
  const out = redactArgv(argv, new Map([['tok', new Set(['tok-AAA1'])], ['shortv', new Set(['a1b'])]]));
  assert.deepEqual(argv, before, 'the argv given to Docker is unchanged');
  const env = (n) => out[out.findIndex((x) => x.startsWith(`${n}=`))];
  assert.match(env('GIT_TOKEN'), /^GIT_TOKEN=<redacted:(tok|GIT_TOKEN)>$/);
  assert.equal(env('DATABASE_URL'), 'DATABASE_URL=postgres://mwsc:<redacted:password>@b0:5432/db', 'a plain URL: only its password');
  assert.equal(env('REDIS_URL'), 'REDIS_URL=redis://b0:6379/0', 'no user info: nothing to hide');
  assert.equal(env('API_URL'), 'API_URL=https://h/x?key=<redacted:key>', 'a URL: its secret query parameters');
  assert.equal(env('PG_DSN'), 'PG_DSN=host=b0 password=<redacted:password>', 'a DSN: only its password part');
  assert.equal(env('POSTGRES_PASSWORD'), 'POSTGRES_PASSWORD=<redacted:POSTGRES_PASSWORD>');
  assert.equal(env('HOME'), 'HOME=/work/home');
  assert.equal(env('PATH'), 'PATH=/usr/bin');
  assert.equal(env('SHORTV'), 'SHORTV=<redacted:shortv>', 'a short volatile value: where it is the whole value');
  assert.equal(out.at(-1), 'git clone https://u:<redacted:password>@h/r && echo <redacted:tok> && curl http://h/no-userinfo');
  assert.equal(out[out.indexOf(IMG)], IMG);
  for (const n of ['GITHUB_TOKEN', 'aws_secret_key', 'SESSION_SECRET', 'X_AUTH', 'MONGO_URI', 'PGPASSWD', 'PGPASSWORD', 'DB_PASS', 'REDIS_PW', 'GITHUB_PAT', 'CREDS', 'OPENAI_API_KEY', 'JWT_PRIVATE_KEY', 'MYSQL_PWD', 'password']) assert.ok(SECRET_ENV_NAME.test(n), n);
  // Whole tokens only: these are settings, not secrets.
  for (const n of ['AUTH_ENABLED', 'AUTH_PROVIDER', 'SESSION_STORE', 'SESSION_ID', 'PWD', 'OLDPWD', 'author', 'monkey', 'keyboard', 'KEY_PREFIX', 'TOKENIZER', 'PASSTHROUGH']) assert.ok(!SECRET_ENV_NAME.test(n), n);
  for (const n of ['HOME', 'PATH', 'TMPDIR', 'NO_COLOR', 'UV_CACHE_DIR', 'TDIR']) assert.ok(!SECRET_ENV_NAME.test(n), n);
});

test('scrub: every case of the review probe is hidden in the logged form', () => {
  const sec = new Map([['tok', new Set(['abcdEFGH1234'])], ['sh', new Set(['x9y'])]]);
  const cases = [
    [['--env', 'API_TOKEN=plain'], 'plain'], [['--env=API_TOKEN=plain'], 'plain'], [['-e', 'API_TOKEN=plain'], 'plain'],
    [['--env', 'PASSWORD=a=b=c'], 'a=b=c'], [['--env', 'NEO4J_AUTH=neo4j/s3cretpass'], 's3cretpass'], [['--env', 'MYSQL_ROOT_PASSWORD=pw'], '=pw'],
    [['--env', 'DATABASE_URL=postgres://u:p@b0/db'], ':p@'], [['--env', 'DATABASE_URL=postgres://u:p@ss@b0/db'], 'p@ss'],
    [['--env', 'RABBITMQ_DEFAULT_PASS=hunter22'], 'hunter22'], [['--env', 'DB_PASS=hunter22'], 'hunter22'], [['--env', 'REDIS_PW=hunter22'], 'hunter22'],
    [['--env', 'MONGO_INITDB_ROOT_PASSWORD=x1'], '=x1'], [['--env', 'X=x9y'], '=x9y'], [['--env', 'X=prefix-abcdEFGH1234-suffix'], 'abcdEFGH1234'],
    [['--env', 'GITHUB_PAT=ghp_xxx'], 'ghp_xxx'], [['--env', 'CREDS=xxx'], '=xxx'], [['--env', 'HOST_URL=http://h/x?token=abc'], 'token=abc'],
    [['redis-server', '--requirepass', 'hunter22'], 'hunter22'], [['mysql', '-uroot', '-phunter22'], 'hunter22'], [['env', 'PGPASSWORD=hunter22', 'psql'], 'hunter22'],
    [['psql', '-c', "ALTER USER u PASSWORD 'hunter22'"], 'hunter22'],
    [['sh', '-c', 'curl -H "Authorization: Bearer abcdEFGH1234" http://b0 -u admin:hunter22'], 'hunter22'],
    [['sh', '-c', 'curl -H "Authorization: Bearer zzzzYYYY9999" http://b0'], 'zzzzYYYY9999'],
    [['x', 'postgres://u:p/w@b0/db'], 'p/w'], [['x', 'jdbc:postgresql://b0/db?user=u&password=hunter22'], 'hunter22'], [['x', 'https://h/a?pass=hunter22&pwd=hunter22'], 'hunter22'],
  ];
  for (const [argv, secret] of cases) {
    const out = redactArgv(argv, sec).join(' ');
    assert.ok(!out.includes(secret), `${JSON.stringify(argv)} => ${out}`);
    assert.match(out, /<redacted:/, out);
  }
  // Not secrets: docker's own --user, a port, plain settings, a short value inside a longer word.
  assert.deepEqual(redactArgv(['run', '--user', '10001:10001', '-p', '8080', '--env', 'HOME=/work', 'xyz'], sec), ['run', '--user', '10001:10001', '-p', '8080', '--env', 'HOME=/work', 'xyz']);
  assert.deepEqual(redactArgv(['mysql', '-p', 'x']), ['mysql', '-p', 'x'], '-p alone is a port flag elsewhere; only -p<value> is a password');
  assert.equal(redactArgv(['-e', 'X=a']).join(' '), '-e X=a');
});

test('scrub: list secrets, free text and output line by line (a secret split across writes is still hidden)', () => {
  const s = new Scrubber();
  s.addList({ backends: [{ env: { POSTGRES_PASSWORD: 'pg-Hunter22', POSTGRES_USER: 'mwsc', HOST_URL: 'redis://:rd-Hunter22@b0' } }], server: { env: { DB_TOKEN: '{{tok}}', LOG: 'x' } },
    setup: ['git clone https://u:sekret-777@h/r'], note: 'mysql://root:my-Hunter22@b1/db' });
  assert.equal(s.text('PGPASSWORD=pg-Hunter22 psql -U mwsc'), 'PGPASSWORD=<redacted:POSTGRES_PASSWORD> psql -U mwsc', 'a known value is named after where the list gives it');
  assert.equal(new Scrubber().text('PGPASSWORD=other99 psql'), 'PGPASSWORD=<redacted:PGPASSWORD> psql', 'an unknown one by its NAME=');
  assert.equal(s.text('connecting with pg-Hunter22 now'), 'connecting with <redacted:POSTGRES_PASSWORD> now');
  for (const v of ['rd-Hunter22', 'sekret-777', 'my-Hunter22']) assert.ok(!s.text(`... ${v} ...`).includes(v), v);
  assert.ok(!s.values.has('{{tok}}'), 'a template is not a value yet');
  assert.ok(!s.values.has('mwsc'), 'a value under a plain name is not a secret');
  const ls = new LineScrubber(s);
  const out = Buffer.concat([ls.push(Buffer.from('line one pg-Hun')), ls.push(Buffer.from('ter22 end\nsecond: my-Hunt')), ls.push(Buffer.from('er22')), ls.end()]).toString();
  assert.equal(out, 'line one <redacted:POSTGRES_PASSWORD> end\nsecond: <redacted:url>');
  // Strings in a JSON-like value; keys kept.
  // meta.json: free-text fields only; structured data (names, URLs, versions) as it is.
  assert.deepEqual(scrubStrings({ harness_error: 'x pg-Hunter22', a: ['x pg-Hunter22'], pg_Hunter22: 1, n: 2 }, s), { harness_error: 'x <redacted:POSTGRES_PASSWORD>', a: ['x pg-Hunter22'], pg_Hunter22: 1, n: 2 });
});

test('scrub: linear on floods: each 4 MiB flood within 20x a plain letters flood measured in the same process', () => {
  // Relative to a baseline from this process and machine, so a slow CI runner does not fail it, while
  // quadratic behaviour (seconds where letters take tens of milliseconds) still does.
  const s = new Scrubber(new Map([['tok', new Set(['abcdEFGH1234'])]]));
  const time = (unit) => {
    const ls = new LineScrubber(s);
    const chunk = Buffer.from(unit.repeat(Math.ceil(65536 / unit.length)));
    const t0 = process.hrtime.bigint();
    let bytes = 0;
    for (let i = 0; i < 64; i++) bytes += ls.push(chunk).length;
    bytes += ls.end().length;
    assert.ok(bytes > 0);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time('x'); // warm-up
  const baseline = Math.min(time('x'), time('x'), time('x'));
  // A floor of 250 ms keeps timer noise from failing it when the baseline is a few milliseconds.
  const bound = Math.min(Math.max(20 * baseline, 250), 30_000);
  for (const unit of ['ab=', 'a://', 'a://u:p@', 'http://u:p@h ', ' ', 'PASSWORD=x;', 'curl ', 'curl -u a:b ', 'wget --user ', 'mysql ', 'mysql -p ', 'redis-cli -a ',
    '--password ', '?password=', 'abcdEFGH123']) {
    const ms = Math.min(time(unit), time(unit));
    assert.ok(ms <= bound, `${JSON.stringify(unit)}: ${ms.toFixed(0)} ms, bound ${bound.toFixed(0)} ms (20x the ${baseline.toFixed(0)} ms letters baseline)`);
  }
});

test('scrub: redis-cli -a, mysql -p and curl -u need their program earlier on the same line', () => {
  const s = new Scrubber();
  assert.equal(s.text('curl -s http://b0 -u admin:pw-9988'), 'curl -s http://b0 -u admin:<redacted:password>');
  assert.equal(s.text('wget --user=admin:pw-9988 http://b0'), 'wget --user=admin:<redacted:password> http://b0');
  assert.equal(s.text('mysql -uroot -ppw-9988 -e "select 1"'), 'mysql -uroot -p<redacted:password> -e "select 1"');
  assert.equal(s.text('redis-cli -a pw-9988 ping'), 'redis-cli -a <redacted:password> ping');
  // Without the program on that line, the flags are something else (a port, ls -a, a user:group).
  assert.equal(s.text('docker run -p 8080 --user 10001:10001 x\nls -a dir\n-u admin:x'), 'docker run -p 8080 --user 10001:10001 x\nls -a dir\n-u admin:x');
  assert.equal(s.text('curl http://b0\n --user admin:pw-9988'), 'curl http://b0\n --user admin:pw-9988', 'the program must be on the same line');
  assert.deepEqual(flagSecrets('ls -a dir; redis-cli -a pw-1122 ping'), ['pw-1122']);
});

test('volatile: a capture made from a volatile one is volatile too; a CLI template name in the manifest is not a use', () => {
  const b = { backends: [{ setup: [{ exec: ['x'], capture: 'tok', volatile: true }, { exec: ['echo', 'u:{{tok}}'], capture: 'dsn' }, { exec: ['echo', '{{dsn}}'], capture: 'dsn2' }] }] };
  assert.deepEqual([...volatileCaptures(b)].sort(), ['dsn', 'dsn2', 'tok']);
  assert.throws(() => volatileCaptures({ ...b, full: { manifest: 'x: "{{dsn}}"' } }), /volatile capture dsn is used in full\.manifest/);
  assert.throws(() => volatileCaptures({ ...b, full: { manifest: 'x: "{{dsn2}}"' } }), /volatile capture dsn2 is used in full\.manifest/);
  assert.throws(() => volatileCaptures({ ...b, server: { command: ['x', '--t={{tok}}'] } }), /used in server\.command/);
  assert.throws(() => volatileCaptures({ ...b, full: { manifest: '{{tok}}' } }), /used in full\.manifest/);
  assert.doesNotThrow(() => volatileCaptures({ ...b, setup: ['echo {{tok}} > /work/t'] }), 'list set-up runs again on every repeat');
  assert.doesNotThrow(() => volatileCaptures({ ...b, backends: [...b.backends, { args: ['{{tok}}'] }] }), 'a backend is started again on every repeat');
  // `id` is a CLI template name: fillManifest never fills it, so a volatile capture named id does not reach the manifest.
  const idv = { backends: [{ setup: [{ exec: ['x'], capture: 'id', volatile: true }] }] };
  assert.doesNotThrow(() => volatileCaptures({ ...idv, full: { manifest: 'read: { args: { id: "{{id}}" } }' } }));
  assert.throws(() => volatileCaptures({ ...idv, server: { command: ['x', '{{id}}'] } }), /used in server\.command/, 'server.command is filled with every name');
  // A derived capture that is also captured plainly elsewhere is refused like any mixed name.
  assert.throws(() => volatileCaptures({ backends: [{ setup: [...b.backends[0].setup, { exec: ['y'], capture: 'dsn' }] }] }), /capture dsn is volatile in one set-up step and not in another/);
});

test('logs: no list secret, volatile or derived value reaches a log file, meta.json or the archived manifest; Docker gets them all', () => {
  const PW = { pg: 'pg-Hunter22', my: 'my-Hunter22', rb: 'rb-Hunter22', rd: 'rd-Hunter22', n4: 'n4-Hunter22', pat: 'ghp_patvalue1', creds: 'creds-value1', db: 'pw-999888', url: 'sekret-777' };
  const manifest = `mws: "0.9"\nserver:\n  stdio: ["{{bin}}/srv"]\n  env: { DB_PASSWORD: "${PW.pg}", URL: "postgres://u:${PW.pg}@b0/db" }\nresources: []\n`;
  const d = stand([{ id: 't23',
    backends: [pg({
      env: { POSTGRES_PASSWORD: PW.pg, MYSQL_ROOT_PASSWORD: PW.my, RABBITMQ_DEFAULT_PASS: PW.rb, REDIS_PW: PW.rd, NEO4J_AUTH: `neo4j/${PW.n4}`, GITHUB_PAT: PW.pat },
      args: ['redis-server', '--requirepass', PW.rd],
      wait: ['mysql', '-uroot', `-p${PW.my}`, '-e', 'select 1'],
      setup: [{ exec: ['psql', '-c', `ALTER USER u PASSWORD '${PW.pg}'`] }, { exec: ['sh', '-c', `PGPASSWORD=${PW.pg} psql -c "select 1"`] }, mint(),
        { exec: ['echo', 'postgres://u:{{tok}}@b0/db', 'CAPTURE'], capture: 'dsn' }],
      snapshot: { exec: ['sh', '-c', `curl -u admin:${PW.rb} http://b0 SNAPSHOT`] },
    })],
    setup: [`git clone https://u:${PW.url}@h/r {{tdir}}/src || true`, `mysql -uroot -p${PW.my} -e "select 1" || true`, `curl -s -H "Authorization: Bearer ${PW.pat}" http://b0 || true`],
    server: { command: ['{{bin}}/srv'], env: { GIT_TOKEN: '{{tok}}', DB_DSN: '{{dsn}}', DATABASE_URL: `postgres://mwsc:${PW.db}@b0:5432/db`, LOG_LEVEL: 'debug', CREDS: PW.creds } },
    full: fullOf({ manifest, repeats: 3 }) }]);
  const caps = 'tok-AAA1\npostgres://u:tok-AAA1@b0/db\ntok-BBB2\npostgres://u:tok-BBB2@b0/db\ntok-CCC3\npostgres://u:tok-CCC3@b0/db\n';
  const { records, meta } = drive(d, { fake: { 'capture-values': caps, 'exec-echo': '1' } });
  const m = meta('t23');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.deepEqual(m.full_runs.map((f) => [f.status, f.volatile_refreshed ?? null]), [['completed', null], ['completed', ['tok', 'dsn']], ['completed', ['tok', 'dsn']]]);
  assert.equal(m.manifest_redacted, true);
  const secrets = [...Object.values(PW), 'tok-AAA1', 'tok-BBB2', 'tok-CCC3'];
  const walk = (p) => readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]));
  const files = walk(join(d, 'out')).filter((f) => f.endsWith('.log') || f.endsWith('meta.json') || f.endsWith('writecheck.yaml') || f.endsWith('.txt'));
  assert.ok(files.some((f) => f.endsWith('writecheck.yaml')) && files.some((f) => f.endsWith('backend-0.log')) && files.some((f) => f.endsWith('setup.log')));
  for (const f of files.filter((x) => !/backend-0-.*\.txt$/.test(x))) {
    const text = readFileSync(f, 'utf8');
    for (const v of secrets) assert.ok(!text.includes(v), `${v} in ${f}`);
  }
  // What the logs say instead, and that the scrubbed output lines are there.
  const blog = readFileSync(join(d, 'out', 't23', 'logs', 'backend-0.log'), 'utf8');
  assert.match(blog, /--env POSTGRES_PASSWORD( |\n)/, 'a secret env value is not even on the docker argv');
  assert.match(blog, /--requirepass <redacted:/);
  assert.match(blog, /\nran: \S+ mysql -uroot -p<redacted:MYSQL_ROOT_PASSWORD> -e select 1\n/, 'output lines are scrubbed too');
  assert.match(blog, /PASSWORD '<redacted:/);
  // Docker got every real value: on its argv where the list puts it there, else in its client env.
  const flat = records.map((x) => `${x.argv.join(' ')} ${JSON.stringify(x.secrets ?? {})}`).join('\n');
  for (const v of secrets) assert.ok(flat.includes(v), v);
  const be = records.find((x) => x.argv[0] === 'run' && x.argv.includes('-d'));
  assert.equal(be.secrets.POSTGRES_PASSWORD, PW.pg);
  assert.ok(be.argv.includes('POSTGRES_PASSWORD') && be.argv.includes(PW.rd));
  const run2 = records.filter((x) => x.argv.includes('--plan-hash'))[1];
  assert.deepEqual([run2.secrets.GIT_TOKEN, run2.secrets.DB_DSN, run2.secrets.DATABASE_URL], ['tok-BBB2', 'postgres://u:tok-BBB2@b0/db', `postgres://mwsc:${PW.db}@b0:5432/db`]);
  assert.ok(run2.argv.includes('LOG_LEVEL=debug'));
  // The CLI got the real manifest (written into the target's volume).
  const vols = readdirSync(join(d, 'fake', 'vols')).filter((v) => /-t23$/.test(v));
  assert.ok(readFileSync(join(d, 'fake', 'vols', vols[0], 'writecheck.yaml'), 'utf8').includes(PW.pg));
});

// ------------------------------------------------------------------------------------------------
// Scrubbing, review round 2: no over-redaction, safe cuts, multi-line and encoded secrets
// ------------------------------------------------------------------------------------------------

test('scrub (1): settings named like AUTH_ENABLED / SESSION_STORE / AUTH_PROVIDER corrupt nothing; meta keeps its structured data', () => {
  const tools = { tools: [{ name: 'memory_search', description: 'Search memory.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, title: 'memory github' } }] };
  const surface = { initialize: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'memory-server', version: '1.0.0' } }, tools, pages: 1, captured_at: '2026-11-17T00:00:00.000Z' };
  const env = { AUTH_ENABLED: 'true', SESSION_STORE: 'memory', AUTH_PROVIDER: 'github', POSTGRES_PASSWORD: 'postgres', API_TOKEN: 'tok-REAL-9988' };
  const source = { repo: 'https://github.com/o/memory-server', commit: 'c'.repeat(40) };
  const d = stand([{ id: 't01', source, backends: [{ image: IMG, port: 5432, env }], server: { command: ['{{bin}}/srv'], env } }]);
  const { records, meta, file } = drive(d, { fake: { 'surface-json': JSON.stringify(surface) } });
  const m = meta('t01');
  assert.equal(m.status, 'completed', m.harness_error);
  assert.equal(m.surface.tools[0].name, 'memory_search');
  assert.deepEqual(m.surface.tools[0].annotations, { readOnlyHint: false, title: 'memory github' });
  assert.deepEqual(m.target.source, source);
  assert.deepEqual(m.surface.server_info, { name: 'memory-server', version: '1.0.0' });
  assert.equal(m.meta_redacted, undefined, 'nothing in meta needed scrubbing');
  assert.equal(JSON.parse(file('t01', 'surface.json')).tools.tools[0].name, 'memory_search');
  const plan = file('t01', 'logs/plan.log');
  assert.match(plan, /--memory 4g/);
  assert.match(plan, /--env AUTH_ENABLED=true --env SESSION_STORE=memory --env AUTH_PROVIDER=github/);
  assert.match(file('t01', 'logs/backend-0.log'), /--memory 2g/);
  // The real secret is hidden all the same, and Docker got it.
  for (const f of ['logs/plan.log', 'logs/backend-0.log', 'meta.json']) assert.ok(!file('t01', f).includes('tok-REAL-9988'), f);
  assert.ok(records.some((x) => x.secrets?.API_TOKEN === 'tok-REAL-9988'));
  // Values that are never known secrets: booleans, numbers, short words, common words.
  for (const v of ['true', 'false', '1234', '3.5', 'ab', 'memory', 'github', 'postgres', 'root', 'secret', 'admin', 'none']) assert.equal(acceptValue(v), false, v);
  for (const v of ['k3y', 'hunter2xyz', 'p@ss w0rd!', 'tok-REAL-9988']) assert.equal(acceptValue(v), true, v);
  // meta: free text only, with the paths that changed.
  const s = new Scrubber();
  s.add('API_TOKEN', 'tok-REAL-9988');
  const r = scrubFreeText({ harness_error: 'set-up: tok-REAL-9988', surface: { tools: [{ name: 'tok-REAL-9988' }] }, steps: [{ spawn_error: 'x tok-REAL-9988' }], fresh_state_why: 'ok' }, s);
  assert.deepEqual(r.paths, ['harness_error', 'steps[0].spawn_error']);
  assert.equal(r.value.surface.tools[0].name, 'tok-REAL-9988', 'structured data is never touched');
});

test('scrub (2/3): no known value, flag+value pair or private key is split by a cut, across chunks and lines', () => {
  const s = new Scrubber();
  s.add('DB_PASSWORD', 'Secret-Value-123456');
  s.add('PRIVATE_KEY', '-----BEGIN KEY-----\nAAAABBBBCCCC\nDDDDEEEE\n-----END KEY-----');
  const feed = (text, size, opts) => {
    const ls = new LineScrubber(s, opts);
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(ls.push(Buffer.from(text.slice(i, i + size))));
    out.push(ls.end());
    return Buffer.concat(out).toString();
  };
  // A known value straddling the forced cut of a line with no newline (limit 1000), in 7-byte chunks.
  const long = `${'x'.repeat(995)}Secret-Value-123456${'y'.repeat(3000)}`;
  const o1 = feed(long, 7, { limit: 1000 });
  assert.ok(!o1.includes('Secret-Value') && o1.includes('<redacted:DB_PASSWORD>'), o1.slice(980, 1040));
  // A flag and an unknown value straddling the cut.
  const o2 = feed(`${'x'.repeat(990)} --requirepass zz9-unknown-77 ${'y'.repeat(3000)}`, 5, { limit: 1000 });
  assert.ok(!o2.includes('zz9-unknown-77'), o2.slice(970, 1040));
  // A known multi-line value and a PEM private key, split across chunks and lines.
  const o3 = feed('key: -----BEGIN KEY-----\nAAAABBBBCCCC\nDDDDEEEE\n-----END KEY-----\nnext line\n', 9);
  assert.equal(o3, 'key: <redacted:PRIVATE_KEY>\nnext line\n');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1\nZZZZ\n-----END RSA PRIVATE KEY-----\n';
  const o4 = feed(`before\n${pem}after\n`, 11);
  assert.equal(o4, 'before\n<redacted:private-key>\nafter\n');
  assert.equal(new Scrubber().text(pem), '<redacted:private-key>\n');
});

test('scrub (4/5): literal secrets outside env are known (flags in args, exec, set-up; manifest YAML); encoded forms; $ENV-derived captures', () => {
  const s = new Scrubber();
  s.addList({ backends: [{ args: ['redis-server', '--requirepass', 'redisPW123'], setup: [{ exec: ['redis-cli', '-a', 'otherPW-777', 'ping'] }] }],
    setup: ['node s.js --db-password=dbPW-5566 --redis-pass "rpPW-8899"'], full: { manifest: 'server:\n  env:\n    password: mfPW-1234\n    token: "mfTK-5678"\n' } });
  for (const v of ['redisPW123', 'otherPW-777', 'dbPW-5566', 'rpPW-8899', 'mfPW-1234', 'mfTK-5678']) {
    assert.ok(s.values.has(v), v);
    assert.ok(!s.text(`connected with ${v} ok`).includes(v), v);
  }
  assert.deepEqual(redactArgv(['node', 's.js', '--db-password', 'zz-1', '--redis-pass=zz-2', '--x-token', 'zz-3'], new Scrubber()), ['node', 's.js', '--db-password', '<redacted:password>', '--redis-pass=<redacted:password>', '--x-token', '<redacted:password>']);
  assert.deepEqual(redactArgv(['redis-cli', '-a', 'zz-4', 'ping'], new Scrubber()), ['redis-cli', '-a', '<redacted:password>', 'ping']);
  assert.equal(new Scrubber().text('env:\n  password: zz-5\n  REDIS_PASSWORD: "zz-6"\n'), 'env:\n  password: <redacted:password>\n  REDIS_PASSWORD: "<redacted:REDIS_PASSWORD>"\n');
  // Encoded forms of a known value of 6+ characters.
  const e = new Scrubber();
  e.add('DB_PASS', 'p@ss w0rd!"\\');
  e.add('POSTGRES_PASSWORD', 'hunter2xyz');
  const enc = ['p%40ss%20w0rd!%22%5C', 'p%40ss%20w0rd%21%22%5C', JSON.stringify('p@ss w0rd!"\\').slice(1, -1), Buffer.from('hunter2xyz').toString('base64'), Buffer.from('hunter2xyz').toString('base64url'), Buffer.from('p@ss w0rd!"\\').toString('base64url')];
  for (const v of enc) assert.ok(e.text(`x ${v} y`).includes('<redacted:'), v);
  // A capture that reads a secret-named variable is derived, so volatile (and refused in the manifest).
  const derived = { backends: [{ setup: [{ exec: ['sh', '-c', 'echo "u:$POSTGRES_PASSWORD"'], capture: 'pw' }, { exec: ['sh', '-c', 'echo ${API_TOKEN}'], capture: 'tk' }, { exec: ['sh', '-c', 'echo $HOME'], capture: 'home' }] }] };
  assert.deepEqual([...volatileCaptures(derived)].sort(), ['pw', 'tk']);
  assert.throws(() => volatileCaptures({ ...derived, full: { manifest: 'x: "{{pw}}"' } }), /volatile capture pw is used in full\.manifest/);
  assert.doesNotThrow(() => volatileCaptures({ ...derived, full: { manifest: 'x: "{{home}}"' } }));
});

test('scrub (6/7): errors are scrubbed; Authorization in any case; LineScrubber is linear (2 MiB in 16-byte chunks)', () => {
  const s = new Scrubber();
  s.add('API_TOKEN', 'tok-REAL-9988');
  const err = new Error('failed with tok-REAL-9988');
  assert.ok(!errorText(err, s).includes('tok-REAL-9988') && errorText(err, s).includes('<redacted:API_TOKEN>'));
  for (const h of ['authorization: bearer abcd1234efgh', 'Authorization: BEARER abcd1234efgh', 'AUTHORIZATION: Basic dXNlcjpwYXNzd29yZA==']) assert.match(new Scrubber().text(h), /<redacted:authorization>/, h);
  assert.equal(new Scrubber().text('token expired'), 'token expired', 'a plain word after "token" is not a credential');
  for (const name of ['AUTH_ENABLED', 'author', 'monkey']) assert.equal(isSecretName(name), false, name);
  // Timing: one 2 MiB line in 16-byte chunks, with known values (so the stream is held back and cut safely).
  for (const unit of ['x', 'Secret-Value-12345 ', '--requirepass a ', 'a://u:p@h ']) {
    const t = new Scrubber(new Map([['A', ['Secret-Value-12345', ...Array.from({ length: 200 }, (_, i) => `tok${i}xxxxxxxx`)]]]));
    const ls = new LineScrubber(t);
    const chunk = Buffer.from(unit.repeat(Math.ceil(16 / unit.length)).slice(0, 16));
    const t0 = Date.now();
    let bytes = 0;
    for (let i = 0; i < (2 * 1024 * 1024) / 16; i++) bytes += ls.push(chunk).length;
    bytes += ls.end().length;
    assert.ok(Date.now() - t0 < 3000, `${JSON.stringify(unit)}: ${Date.now() - t0} ms`);
    assert.ok(bytes > 0);
  }
});
