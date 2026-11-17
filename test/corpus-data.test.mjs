/**
 * Data-capture additions to the corpus driver (DATA-CONTRACT part D): the server surface probe, the
 * config-source copy, and (below) the driver's new fields end to end with the stand-in docker. The
 * in-container helpers (corpus/sandbox/surface.mjs, config-source.mjs) are run here on the host
 * against synthetic fixtures; in a run they only ever run inside the target's sandbox container.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Jcs } from '../corpus/jcs.mjs';
import {
  checkDropped, checkFull, checkSnapshot, entryBin, envVersions, HarnessError, imageParts, LABEL, MAX_FULL_TIMEOUT_S, MAX_REPEATS, NEVER_REUSE_SINCE,
  surfaceMeta, TARGETS_FORMAT, timeLimits, validateList, validateTarget, VERSION_PROBE,
} from '../corpus/run-shard.mjs';
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
  assert.deepEqual(surface.tools[0], { name: 'get', description_sha256: sha('Read one.'), input_schema_sha256_jcs: sha256Jcs(tools.tools[0].inputSchema), output_schema_sha256_jcs: null, annotations: { readOnlyHint: true } });
  assert.equal(surface.tools[1].description_sha256, null);
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

test('D2: versions from inside the target container, image references, the entry bin', () => {
  assert.deepEqual(envVersions({ exit: 0, stdout: 'node v22.11.0\npython Python 3.12.7\n' }), { node_version: 'v22.11.0', python_version: '3.12.7' });
  assert.deepEqual(envVersions({ exit: 0, stdout: 'node v22.11.0\npython none\n' }), { node_version: 'v22.11.0', python_version: null, python_version_why: "python3 is not on the target container's PATH" });
  const failed = envVersions({ exit: 125, stdout: '' });
  assert.equal(failed.node_version, null);
  assert.match(failed.node_version_why, /did not run \(exit 125\)/);
  assert.match(envVersions({ exit: 0, stdout: 'node -\npython -\n' }).python_version_why, /python3 -V failed/);
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
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv) : [];
  const meta = (id) => JSON.parse(readFileSync(join(d, 'out', id, 'meta.json'), 'utf8'));
  return { r, calls, meta, file: (id, f) => readFileSync(join(d, 'out', id, f), 'utf8') };
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
  assert.equal(m.env.spec_text, 'spec/0.9-review@0000000');
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
  const d = stand([{ id: 't01', backends: [pg()], full: fullOf({ repeats: 3 }) }]);
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
  assert.equal(m.full_runs[1].reset, 'backends started again from their images and seeded');
  assert.equal(m.backends[0].resets, 2);
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
