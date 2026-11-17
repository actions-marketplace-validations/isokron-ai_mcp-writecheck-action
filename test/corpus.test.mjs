/**
 * The corpus driver (corpus/run-shard.mjs): its public output is the label and one
 * "run finished, exit N" line per target, a verdict never shows or fails the shard, the metadata
 * keeps the real exit statuses, and every piece of target code runs in a locked-down container
 * (C1): user 10001, no capabilities, no-new-privileges, read-only root, named volumes only, install
 * on an egress network and everything else on an internal one. These tests use a stand-in `docker`
 * (test/fixtures/corpus/fake-docker.mjs) and a local artifact; no daemon, no network.
 * test/corpus-container.test.mjs runs the same driver against a real Docker daemon.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BACKEND_CAPS, BACKEND_DEFAULT_CAPS, backendCaps, backendRunArgs, catalogManifest, checkFetch, checkDockerVersion, checkLane, checkNpmLock, checkPinned, checkPypiLock, classifyCli,
  CLI_TEMPLATE_NAMES, dockerEnvFrom, fill, fillManifest, installPlan, keepRegular, LABEL, platformKey, publicExit, sandboxEnv, sandboxRunArgs, serverWrap, shuffled, STDERR_DIR, validateTarget, volumeMount,
} from '../corpus/run-shard.mjs';
import { checkListedUrl, FETCH_HOSTS, fetchVerified } from '../corpus/sandbox/fetch.mjs';
import { MAX_FILES } from '../corpus/sandbox/stderr-tee.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'zz-secret-target-name';
const IMG = `docker.io/library/node:22-bookworm-slim@sha256:${'a'.repeat(64)}`;

test('public exit: verdict statuses fold to 0, tool and harness problems keep their code', () => {
  assert.equal(publicExit({ status: 'completed', cli_exit: 1 }), 0);
  assert.equal(publicExit({ status: 'completed', cli_exit: 0 }), 0);
  assert.equal(publicExit({ status: 'cli_error', cli_exit: 4 }), 4);
  assert.equal(publicExit({ status: 'cli_error', cli_exit: 99 }), 70);
  assert.equal(publicExit({ status: 'cli_crash', cli_exit: null }), 70);
  assert.equal(publicExit({ status: 'timeout' }), 124);
  assert.equal(publicExit({ status: 'harness_error' }), 125);
});

test('CLI step classes; a container that did not start is a harness error', () => {
  assert.equal(classifyCli({ exit: 1 }), 'completed');
  assert.equal(classifyCli({ exit: 3 }), 'cli_error');
  assert.equal(classifyCli({ exit: null, signal: 'SIGSEGV' }), 'cli_crash');
  assert.equal(classifyCli({ exit: 7 }), 'cli_crash');
  assert.equal(classifyCli({ exit: 137, container: true }), 'cli_crash');
  assert.equal(classifyCli({ exit: 125, container: true }), 'harness_error');
  assert.equal(classifyCli({ exit: 0, timed_out: true }), 'timeout');
});

test('an expected CLI problem reports 0', () => {
  assert.equal(publicExit({ status: 'expected_cli_error', cli_exit: 4 }), 0);
});

test('templates: unknown names are a harness error', () => {
  assert.deepEqual(fill(['{{a}}/x', { k: '{{a}}' }], { a: 'v' }), ['v/x', { k: 'v' }]);
  assert.throws(() => fill('{{nope}}', {}));
  assert.match(catalogManifest(['srv', 'a b'], ['E'], 'c'), /stdio: \["srv", "a b"\]/);
});

test('fillManifest: a hand manifest keeps the CLI\'s own templates and gets only the driver\'s names', () => {
  const vars = { tdir: '/work', bin: '/work/bin', host: 'b0', host0: 'b0', port0: '27017', seed_check: '1', id: '{{id}}' };
  const manifest = [
    'server:',
    '  stdio: ["{{bin}}/srv", "--dir", "{{tdir}}"]',
    '  env: { URL: "mongodb://{{host0}}:{{port0}}/mwsc" }',
    'resources:',
    '  - name: item',
    '    read: { tool: find, args: { filter: { _id: "{{id}}" } } }',
    '    update: { tool: update-many, args: { filter: { _id: "{{id}}", version: "{{version}}" }, update: { $set: { "{{field}}": "{{value}}" } } } }',
    '    other: ["{{json:object}}", "{{object.x}}", "{{?scope}}", "{{ id }}", "{{read.obj.version}}", "{{my_var}}", "{{REP}}"]',
  ].join('\n');
  const out = fillManifest(manifest, vars);
  const want = manifest.replace('{{bin}}', '/work/bin').replace('{{tdir}}', '/work').replace('{{host0}}', 'b0').replace('{{port0}}', '27017');
  assert.equal(out, want);
  // every CLI template name passes through unchanged, even when a capture has the same name
  for (const k of CLI_TEMPLATE_NAMES) assert.equal(fillManifest(`a: "{{${k}}}"`, { ...vars, [k]: 'CLOBBERED' }), `a: "{{${k}}}"`);
  assert.equal(fillManifest('{{seed_check}}', vars), '1');
  // a driver name the target does not set is still the harness's error
  for (const k of ['host1', 'port1', 'pkgdir']) assert.throws(() => fillManifest(`x: "{{${k}}}"`, vars), /template variable .* is not set/);
  // outside the manifest text, unknown names still throw
  assert.throws(() => fill(['{{id}}'], { tdir: '/work' }), /template variable id is not set/);
});

test('fillManifest: the CLI template names match the CLI\'s RESERVED_VARS', { skip: !process.env.MWS_CLI_SRC && 'set MWS_CLI_SRC to the CLI checkout to compare' }, () => {
  const src = readFileSync(join(process.env.MWS_CLI_SRC, 'packages/writecheck/src/core/manifest.ts'), 'utf8');
  const m = /export const RESERVED_VARS = (\[[^\]]*\])/.exec(src);
  assert.ok(m, 'RESERVED_VARS not found');
  assert.deepEqual([...CLI_TEMPLATE_NAMES], JSON.parse(m[1].replace(/'/g, '"')));
});

// ------------------------------------------------------------------------------------------------
// C1: the container flags
// ------------------------------------------------------------------------------------------------

const mounts = [{ src: 'corpus-r1-t01', dst: '/work' }, { src: 'corpus-r1-cli', dst: '/opt/mwsc', ro: true }];

test('C1: sandbox containers run as 10001, no capabilities, no-new-privileges, read-only root, tmpfs /tmp', () => {
  const a = sandboxRunArgs({ name: 'n', image: IMG, network: 'corpus-r1-t01-run', mounts, env: { A: 'b' }, cmd: ['node', 'x'] });
  const pair = (k) => a[a.indexOf(k) + 1];
  assert.equal(pair('--user'), '10001:10001');
  assert.equal(pair('--cap-drop'), 'ALL');
  assert.equal(pair('--security-opt'), 'no-new-privileges');
  assert.ok(a.includes('--read-only'));
  assert.match(pair('--tmpfs'), /^\/tmp:rw,nosuid,nodev/);
  assert.ok(a.includes('--pids-limit') && a.includes('--memory') && a.includes('--init'));
  assert.equal(pair('--cpus'), '2');
  assert.equal(sandboxRunArgs({ name: 'n', image: IMG, network: 'none', mounts, cpus: 1, cmd: ['x'] }).at(sandboxRunArgs({ name: 'n', image: IMG, network: 'none', mounts, cpus: 1, cmd: ['x'] }).indexOf('--cpus') + 1), '1');
  assert.equal(pair('--network'), 'corpus-r1-t01-run');
  assert.ok(!a.includes('--cap-add') && !a.includes('--privileged') && !a.includes('-v') && !a.includes('--volume'));
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--mount'), ['type=volume,src=corpus-r1-t01,dst=/work', 'type=volume,src=corpus-r1-cli,dst=/opt/mwsc,readonly']);
  assert.deepEqual(a.slice(-3), [IMG, 'node', 'x']);
});

test('C1: only corpus volumes are mounted: no host path, no Docker socket, no workspace or RUNNER_TEMP', () => {
  for (const src of ['/var/run/docker.sock', '/home/runner/work/x/x', '/home/runner/work/_temp', '/home/runner/work/_actions', '/', 'data', 'corpus-x/../../etc']) {
    assert.throws(() => volumeMount({ src, dst: '/work' }), /only corpus volumes/, src);
  }
  assert.throws(() => volumeMount({ src: 'corpus-x', dst: '/var/run/docker.sock' }), /mount point/);
  assert.throws(() => sandboxRunArgs({ name: 'n', image: IMG, network: 'none', mounts: [{ src: '/var/run/docker.sock', dst: '/work' }], cmd: ['x'] }));
});

test('C1: images must be pinned by digest (sandbox and backends)', () => {
  assert.equal(checkPinned(IMG, 'x'), IMG);
  for (const bad of ['node:22', 'node@sha256:abc', `node:22@sha256:${'A'.repeat(64)}`, '', null]) assert.throws(() => checkPinned(bad, 'x'), /pinned by digest/);
  assert.throws(() => sandboxRunArgs({ name: 'n', image: 'node:22', network: 'none', mounts, cmd: ['x'] }), /pinned/);
  assert.throws(() => backendRunArgs({ name: 'b', image: 'postgres:16', network: 'n', alias: 'b0' }), /pinned/);
});

test('C1: backends drop every capability but an allowlisted few, and publish no host port', () => {
  const a = backendRunArgs({ name: 'b', image: IMG, network: 'corpus-r1-t01-run', alias: 'b0', capAdd: ['CHOWN', 'SETUID'], env: { P: '1' }, args: ['-c', 'x'] });
  assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--cap-add'), ['CHOWN', 'SETUID']);
  assert.equal(a[a.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.ok(!a.includes('-p') && !a.includes('--publish') && !a.includes('--privileged'));
  assert.equal(a[a.indexOf('--network-alias') + 1], 'b0');
  assert.equal(a[a.indexOf('--cpus') + 1], '2');
  for (const cap of ['SYS_ADMIN', 'NET_ADMIN', 'ALL', 'SYS_PTRACE', 'KILL', 'NET_BIND_SERVICE']) {
    assert.throws(() => backendRunArgs({ name: 'b', image: IMG, network: 'n', alias: 'b0', capAdd: [cap] }), /not allowed/);
  }
  // no-new-privileges and the full drop come before any add.
  const at = (k) => a.indexOf(k);
  assert.ok(at('--security-opt') < at('--cap-drop') && at('--cap-drop') < at('--cap-add'), a.join(' '));
});

test('A: backend capabilities: exactly five allowlisted; the default is those five; anything else refused at load', () => {
  assert.deepEqual([...BACKEND_CAPS].sort(), ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']);
  assert.deepEqual([...BACKEND_DEFAULT_CAPS].sort(), [...BACKEND_CAPS].sort());
  assert.deepEqual(backendCaps({ image: IMG }).sort(), [...BACKEND_DEFAULT_CAPS].sort(), 'no cap_add: the default');
  assert.deepEqual(backendCaps({ cap_add: [] }), [], 'an explicit empty list means none');
  assert.deepEqual(backendCaps({ cap_add: ['SETUID', 'SETGID'] }), ['SETUID', 'SETGID']);
  for (const bad of [['SYS_ADMIN'], ['CAP_CHOWN'], ['chown'], ['KILL'], ['NET_BIND_SERVICE'], ['ALL'], ['CHOWN', 'CHOWN'], [7], 'CHOWN', { CHOWN: true }, null]) {
    assert.throws(() => backendCaps({ cap_add: bad }), /cap_add|not allowed|twice/, JSON.stringify(bad));
    assert.throws(() => validateTarget({ id: 't01', backends: [{ image: IMG, cap_add: bad }] }), /backend 0/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => validateTarget({ id: 't01', backends: [{ image: IMG }, { image: IMG, cap_add: ['CHOWN'] }] }));
  const a = backendRunArgs({ name: 'b', image: IMG, network: 'n', alias: 'b0', capAdd: backendCaps({}) });
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--cap-add').sort(), [...BACKEND_DEFAULT_CAPS].sort());
});

test('C1 / H3: the docker client and the containers get no GitHub file command, no token, a HOME of their own', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/runner', DOCKER_HOST: 'unix:///x', GITHUB_ENV: 'f', GITHUB_STEP_SUMMARY: 'f', GITHUB_OUTPUT: 'f', GITHUB_PATH: 'f', ACTIONS_RUNTIME_TOKEN: 't', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', MWS_CLI_TOKEN: 't', CORPUS_TARGETS_KEY: 'k', RUNNER_TEMP: '/t' };
  assert.deepEqual(Object.keys(dockerEnvFrom(env)).sort(), ['DOCKER_HOST', 'HOME', 'PATH']);
  const s = sandboxEnv('/work/venv/bin', { SRV: '1' });
  assert.equal(s.HOME, '/work/home');
  assert.ok(!Object.keys(s).some((k) => /^(GITHUB|ACTIONS|RUNNER)_|TOKEN|KEY/.test(k)));
  // L4: every cache lives in the target's own volume, so one target cannot poison the next.
  for (const k of ['npm_config_cache', 'UV_CACHE_DIR', 'PIP_CACHE_DIR', 'XDG_CACHE_HOME']) assert.match(s[k], /^\/work\/home\//, k);
  assert.match(s.PATH, /^\/opt\/tools:.*:\/work\/venv\/bin$/, 'the target bin folder comes last');
});

test('C1: platform comes from the Docker server and must be Linux', () => {
  assert.equal(platformKey('linux/amd64\n'), 'linux-x64');
  assert.equal(platformKey('linux/arm64'), 'linux-arm64');
  assert.throws(() => platformKey('darwin/arm64'), /Linux/);
  assert.throws(() => platformKey('linux/s390x'), /unsupported/);
});

// ------------------------------------------------------------------------------------------------
// M4: hash-locked installs
// ------------------------------------------------------------------------------------------------

test('M4: npm targets install with npm ci from the pinned lockfile; install scripts off unless asked', () => {
  assert.throws(() => installPlan({ ecosystem: 'npm', package: 'p' }, 'linux-x64'), /not hash-locked/);
  const t = { ecosystem: 'npm', package: 'p', lock: npmLock('p') };
  const p = installPlan(t, 'linux-x64');
  const ci = p.steps.find((s) => s.cmd[0] === 'npm' && s.cmd[1] === 'ci');
  assert.ok(ci.cmd.includes('--ignore-scripts'));
  assert.equal(ci.net, 'egress');
  assert.ok(!p.steps.some((s) => s.cmd.includes('install') && s.cmd[0] === 'npm'), 'never npm install');
  assert.ok(!installPlan({ ...t, install_scripts: true }, 'linux-x64').steps[0].cmd.includes('--ignore-scripts'));
  assert.deepEqual(p.files.map((f) => f.path), ['/work/pkg/artifact.tgz', '/work/pkg/package.json', '/work/pkg/package-lock.json']);
});

test('M4: PyPI targets install with --require-hashes from the lock for this platform; the target itself offline', () => {
  const t = { ecosystem: 'pypi', package: 'p', artifact: { file: 'p-1.0-py3-none-any.whl' }, lock: { pypi: { 'linux-x64': `a==1 --hash=sha256:${'0'.repeat(64)}\n` } } };
  assert.throws(() => installPlan(t, 'linux-arm64'), /not hash-locked for linux-arm64/);
  const p = installPlan(t, 'linux-x64');
  const deps = p.steps.find((s) => s.cmd.includes('-r'));
  for (const f of ['--require-hashes', '--no-deps', '--only-binary']) assert.ok(deps.cmd.includes(f), f);
  assert.equal(deps.net, 'egress');
  const self = p.steps.find((s) => s.cmd.includes('/work/dl/p-1.0-py3-none-any.whl'));
  assert.equal(self.net, 'none');
  assert.ok(self.cmd.includes('--offline') && self.cmd.includes('--no-deps'));
  assert.ok(p.needsUv);
  assert.ok(!installPlan({ ...t, allow_build: true }, 'linux-x64').steps.find((s) => s.cmd.includes('-r')).cmd.includes('--only-binary'));
  assert.throws(() => installPlan({ ...t, artifact: { file: '../x.whl' } }, 'linux-x64'), /file name/);
});

test('M4: binary targets unpack with no network', () => {
  const p = installPlan({ ecosystem: 'binary', artifact: { 'linux-x64': { file: 's.tgz' } } }, 'linux-x64');
  assert.ok(p.steps.every((s) => s.net === 'none'));
  assert.throws(() => installPlan({ ecosystem: 'binary', artifact: {} }, 'linux-x64'), /no artifact/);
});

// ------------------------------------------------------------------------------------------------
// R2-5: locks fetch from the registries only
// ------------------------------------------------------------------------------------------------

/** A lock as prep-targets.py writes it: the target from its checked artifact, the rest from the registry. */
function npmLock(pkg, more = {}) {
  return {
    package_json: JSON.stringify({ private: true, dependencies: { [pkg]: 'file:artifact.tgz' } }),
    package_lock: JSON.stringify({ lockfileVersion: 3, requires: true, packages: {
      '': { dependencies: { [pkg]: 'file:artifact.tgz' } },
      [`node_modules/${pkg}`]: { version: '1.0.0', resolved: 'file:artifact.tgz', integrity: 'sha512-AAAA' },
      'node_modules/dep': { version: '2.0.0', resolved: 'https://registry.npmjs.org/dep/-/dep-2.0.0.tgz', integrity: 'sha512-BBBB' },
      'node_modules/dep/node_modules/inner': { version: '1.0.0', inBundle: true },
      ...more,
    } }),
  };
}

test('R2-5: an npm lock fetches only from registry.npmjs.org, every package with an integrity hash', () => {
  const t = (lock) => ({ ecosystem: 'npm', package: 'p', lock });
  assert.doesNotThrow(() => checkNpmLock(t(npmLock('p'))));
  assert.doesNotThrow(() => installPlan(t(npmLock('p')), 'linux-x64'));
  const bad = [
    [{ 'node_modules/x': { resolved: 'https://evil.example/x.tgz', integrity: 'sha512-C' } }, /outside/],
    [{ 'node_modules/x': { resolved: 'https://registry.npmjs.org.evil.example/x.tgz', integrity: 'sha512-C' } }, /outside/],
    [{ 'node_modules/x': { resolved: 'http://registry.npmjs.org/x/-/x-1.tgz', integrity: 'sha512-C' } }, /outside/],
    [{ 'node_modules/x': { resolved: 'git+ssh://git@github.com/a/b.git#abc', integrity: 'sha512-C' } }, /outside/],
    [{ 'node_modules/x': { resolved: 'file:../../etc' } }, /outside/],
    [{ 'node_modules/x': { resolved: 'https://registry.npmjs.org/x/-/x-1.tgz' } }, /integrity/],
    [{ 'node_modules/x': { version: '1.0.0' } }, /outside/],
    [{ 'node_modules/x': { resolved: '../x', link: true } }, /link/],
  ];
  for (const [more, re] of bad) assert.throws(() => installPlan(t(npmLock('p', more)), 'linux-x64'), re, JSON.stringify(more));
  // The target itself only from the checked artifact; package.json names nothing else.
  const own = npmLock('p');
  const pl = JSON.parse(own.package_lock);
  pl.packages['node_modules/p'].resolved = 'https://registry.npmjs.org/p/-/p-1.tgz';
  assert.throws(() => checkNpmLock(t({ ...own, package_lock: JSON.stringify(pl) })), /checked artifact/);
  assert.throws(() => checkNpmLock(t({ ...own, package_json: JSON.stringify({ dependencies: { p: 'file:artifact.tgz', q: 'https://x/q.tgz' } }) })), /package.json/);
  assert.throws(() => checkNpmLock(t({ ...own, package_json: JSON.stringify({ dependencies: { p: 'file:artifact.tgz' }, scripts: { preinstall: 'x' } }) })), /package.json/);
  assert.throws(() => checkNpmLock(t({ ...own, package_lock: '{"lockfileVersion":1,"dependencies":{}}' })), /lockfileVersion/);
  assert.throws(() => checkNpmLock(t({ ...own, package_lock: 'nope' })), /not JSON/);
});

test('R2-5: a PyPI lock is name==version with sha256 hashes only: no URL, VCS, file or option line', () => {
  const h = (c) => `--hash=sha256:${c.repeat(64)}`;
  const good = `# comment\nsix==1.17.0 \\\n    ${h('a')} \\\n    ${h('b')}\npywin32==306 ; sys_platform == 'win32' \\\n    ${h('c')}\nreq[socks,x]==2.0 ${h('d')}\n\n`;
  assert.doesNotThrow(() => checkPypiLock(good));
  assert.doesNotThrow(() => checkPypiLock(''));
  for (const bad of [
    `x @ https://evil.example/x-1.whl ${h('a')}`,
    `x @ git+https://github.com/a/b ${h('a')}`,
    `x==1.0`,
    `--index-url https://evil.example/simple\nx==1.0 ${h('a')}`,
    `--extra-index-url https://evil.example/simple`,
    `-e ./x`,
    `./x.whl ${h('a')}`,
    `x>=1.0 ${h('a')}`,
    `x==1.0 ; python_version > '3' @ https://e ${h('a')}`,
    `x==1.0 --hash=md5:${'a'.repeat(32)}`,
  ]) assert.throws(() => checkPypiLock(bad), /pypi lock/, bad);
  const t = { ecosystem: 'pypi', package: 'p', artifact: { file: 'p-1.0-py3-none-any.whl' }, lock: { pypi: { 'linux-x64': `x @ https://e/x.whl ${h('a')}` } } };
  assert.throws(() => installPlan(t, 'linux-x64'), /pypi lock/);
});

// ------------------------------------------------------------------------------------------------
// R2-3 / R2-4: the Mac lane
// ------------------------------------------------------------------------------------------------

test('R2-3: on lane mac, or on a macOS host, no target with install scripts or a build', () => {
  for (const f of [{ install_scripts: true }, { allow_build: true }]) {
    assert.throws(() => checkLane(f, 'mac', 'linux'), /lane mac/);
    assert.throws(() => checkLane(f, 'ci', 'darwin'), /lane mac/, 'CORPUS_LOCAL_LANES="mac ci" on the Mac');
    assert.doesNotThrow(() => checkLane(f, 'ci', 'linux'));
  }
  assert.doesNotThrow(() => checkLane({}, 'mac', 'darwin'));
});

test('R2-4: Docker Engine older than 26.0.0 is refused (CVE-2024-29018)', () => {
  for (const v of ['26.0.0', '26.1.4', '28.0.4', '29.9.3', '27.5.1\n']) assert.ok(checkDockerVersion(v), v);
  for (const v of ['25.0.5', '24.0.9', '20.10.24', '', 'unknown', '2.0.0']) assert.throws(() => checkDockerVersion(v), /older than 26/, v);
});

// ------------------------------------------------------------------------------------------------
// L2: order
// ------------------------------------------------------------------------------------------------

test('L2: the per-run order is a seeded shuffle (same seed, same order; another seed, another order)', () => {
  const l = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const a = shuffled(l, 'aa');
  assert.deepEqual([...a].sort(), [...l].sort());
  assert.deepEqual(shuffled(l, 'aa'), a);
  assert.notDeepEqual(shuffled(l, 'bb'), a);
  assert.deepEqual(l, Array.from({ length: 12 }, (_, i) => `t${i}`), 'input untouched');
});

test('copy-out keeps regular files and folders only', () => {
  const d = mkdtempSync(join(tmpdir(), 'corpus-keep-'));
  mkdirSync(join(d, 'a'));
  writeFileSync(join(d, 'a', 'f'), 'x');
  symlinkSync('/etc/passwd', join(d, 'a', 'l'));
  spawnSync('mkfifo', [join(d, 'p')]);
  assert.ok(keepRegular(d) >= 1);
  assert.ok(existsSync(join(d, 'a', 'f')));
  assert.throws(() => lstatSync(join(d, 'a', 'l')));
  assert.throws(() => lstatSync(join(d, 'p')));
});

// ------------------------------------------------------------------------------------------------
// The driver end to end, with the stand-in docker
// ------------------------------------------------------------------------------------------------

function stand({ format = 'isokron-corpus-targets/2', extra = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'corpus-test-'));
  const cli = join(d, 'cli');
  mkdirSync(join(cli, 'dist', 'src', 'cli'), { recursive: true });
  // The host only asks the CLI for its version and requirement list; target steps go to docker.
  writeFileSync(join(cli, 'dist', 'src', 'cli', 'main.js'), `
    const [cmd] = process.argv.slice(2);
    if (cmd === 'version') { console.log('mcp-writecheck 0.0.0-test (MWS 0.9)'); process.exit(0); }
    if (cmd === 'requirements') { console.log('MWS-ANN-4\\tSHOULD\\tx'); process.exit(0); }
    process.exit(9);
  `.replace(/^\s+/gm, ''));
  writeFileSync(join(cli, 'package.json'), '{"type":"commonjs"}');
  const bin = join(d, 'bin');
  mkdirSync(bin);
  // The shim records the names of the variables docker was given, then sets the fake's own.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nFAKE_DOCKER_SEEN_ENV=$("${process.execPath}" -e 'console.log(JSON.stringify(Object.keys(process.env).sort()))')\nexport FAKE_DOCKER_SEEN_ENV\nFAKE_DOCKER_ROOT="${join(d, 'fake')}" exec "${process.execPath}" "${join(root, 'test', 'fixtures', 'corpus', 'fake-docker.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  mkdirSync(join(d, 'fake'));
  writeFileSync(join(d, 'images.json'), JSON.stringify({ runtime: IMG, uv: `ghcr.io/astral-sh/uv:0@sha256:${'b'.repeat(64)}` }));
  const art = join(d, 'srv.tgz');
  mkdirSync(join(d, 'srvsrc'));
  writeFileSync(join(d, 'srvsrc', 'srv'), '#!/bin/sh\n');
  spawnSync('tar', ['-czf', art, '-C', join(d, 'srvsrc'), 'srv']);
  const sha = createHash('sha256').update(readFileSync(art)).digest('hex');
  const bt = (id, s) => ({ id, lane: 'ci', name: NAME, ecosystem: 'binary', package: NAME, version: '1',
    artifact: { 'linux-x64': { url: pathToFileURL(art).href, file: 'srv.tgz', sha256: s } }, server: { command: ['{{bin}}/srv'] }, init: false });
  const targets = { format, targets: [
    bt('t01', sha),
    bt('t02', '0'.repeat(64)),
    { id: 't03', lane: 'mac', name: NAME, ecosystem: 'binary', package: NAME, version: '1', artifact: {}, server: { command: ['x'] } },
    { ...bt('t04', sha), ecosystem: 'npm', artifact: { url: pathToFileURL(art).href, sha256: sha }, lock: npmLock(NAME), setup: ['touch {{tdir}}/seed'] },
    { ...bt('t05', sha), backends: [{ image: 'postgres:16', port: 5432 }] },
    { ...bt('t06', sha), backends: [{ image: IMG, port: 5432, cap_add: ['SYS_ADMIN'] }] },
    { ...bt('t07', sha), ecosystem: 'npm', artifact: { url: pathToFileURL(art).href, sha256: sha } },
    { ...bt('t08', sha), lane: 'mac', ecosystem: 'npm', artifact: { url: pathToFileURL(art).href, sha256: sha }, lock: npmLock(NAME), install_scripts: true },
    { ...bt('t09', sha), lane: 'mac' },
    { ...bt('t10', sha), backends: [{ image: IMG, port: 6379, wait: ['true'], wait_timeout_s: 1 }] },
    { ...bt('t11', sha), backends: [{ image: IMG, port: 6379, cap_add: ['SETUID', 'SETGID'] }] },
    ...extra,
  ] };
  writeFileSync(join(d, 'targets.json'), JSON.stringify(targets));
  return d;
}

function drive(d, { only, cliExit = 0, env = {}, extraArgs = [] } = {}) {
  const log = join(d, 'fake', 'calls.jsonl');
  writeFileSync(join(d, 'fake', 'cli-exit'), String(cliExit));
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', join(d, 'cli'),
    '--cli-commit', 'f'.repeat(40), '--out', join(d, 'out'), '--images', join(d, 'images.json'), ...(only ? ['--only', only] : []), ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH}`, ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const meta = (id) => JSON.parse(readFileSync(join(d, 'out', id, 'meta.json'), 'utf8'));
  return { r, calls, meta };
}

for (const cliExit of [0, 1]) {
  test(`a shard prints only the label and run lines (CLI exit ${cliExit}); a bad checksum is a harness error`, () => {
    const d = stand();
    const { r, meta } = drive(d, { only: 't01,t02', cliExit });
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines[0], LABEL);
    assert.deepEqual(lines.slice(1).sort(), ['run finished, exit 0', 'run finished, exit 125']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 1, 'the harness error turns the shard red, the verdict does not');
    const m1 = meta('t01');
    assert.equal(m1.status, 'completed');
    assert.equal(m1.cli_exit, cliExit);
    assert.equal(m1.results.length, 1);
    assert.equal(m1.results[0].folder, 'sandbox/results/catalog-x');
    assert.match(readFileSync(join(d, 'out', 't01', 'logs', 'catalog.log'), 'utf8'), new RegExp(NAME));
    const m2 = meta('t02');
    assert.equal(m2.status, 'harness_error');
    assert.match(m2.harness_error, /checksum/);
  });
}

test('a shard with only a verdict is green', () => {
  const d = stand();
  const { r } = drive(d, { only: 't01', cliExit: 1 });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  assert.equal(r.status, 0);
});

test('C1: every target step runs in a hardened container; install has egress, set-up and the CLI only the internal network', () => {
  const d = stand();
  const { r, calls, meta } = drive(d, { only: 't01,t04' });
  assert.equal(r.status, 0, r.stdout);
  const runs = calls.filter((c) => c.argv[0] === 'run').map((c) => c.argv);
  assert.ok(runs.length >= 8);
  const net = (a) => a[a.indexOf('--network') + 1];
  const internal = JSON.parse(readFileSync(join(d, 'fake', 'networks.json'), 'utf8'));
  for (const a of runs) {
    // Every container, ours or the target's: no host path, no socket, no privileged mode, no bind.
    assert.ok(!a.some((x) => x.includes(d) || x.includes('docker.sock') || x.startsWith('type=bind')), a.join(' '));
    assert.ok(!a.includes('--privileged') && !a.includes('-v') && !a.includes('--volume') && !a.includes('-p'), a.join(' '));
    assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(a[a.indexOf('--security-opt') + 1], 'no-new-privileges');
    const user = a[a.indexOf('--user') + 1];
    const helper = /-h\d+$/.test(a[a.indexOf('--name') + 1]);
    const targetCode = !helper && (a.includes('isokron.corpus.target=t01') || a.includes('isokron.corpus.target=t04'));
    if (targetCode) {
      assert.equal(user, '10001:10001');
      assert.ok(a.includes('--read-only'));
      const cmd = a.slice(a.findIndex((x) => x === IMG) + 1);
      const isInstall = cmd[0] === 'npm' && cmd[1] === 'ci';
      if (isInstall) assert.equal(internal[net(a)], false, 'install: egress network');
      else if (net(a) !== 'none') assert.equal(internal[net(a)], true, `${cmd.join(' ')}: internal network`);
      if (cmd.includes('/opt/mwsc/dist/src/cli/main.js') || /^touch /.test(cmd[2] ?? '')) assert.equal(internal[net(a)], true, 'CLI and set-up: internal network');
    } else {
      // Our helpers (volume set-up, file writes, copy-out, the CLI volume): no network at all.
      assert.equal(net(a), 'none', a.join(' '));
    }
  }
  assert.ok(runs.some((a) => a.includes('npm') && a.includes('ci')), 'npm ci ran');
  assert.ok(runs.some((a) => a.includes('touch /work/seed')), 'set-up ran in a container');
  assert.deepEqual(meta('t04').networks, { install: { internal: false }, run: { internal: true } });
  // Volumes and networks are removed again, by label.
  assert.ok(calls.some((c) => c.argv[0] === 'volume' && c.argv[1] === 'rm'));
  assert.ok(calls.some((c) => c.argv[0] === 'network' && c.argv[1] === 'rm'));
});

test('C1 / H3: the docker client never sees GitHub file commands or secrets; the public summary is untouched', () => {
  const d = stand();
  writeFileSync(join(d, 'summary.md'), '');
  const { r, calls } = drive(d, { only: 't01', env: { GITHUB_STEP_SUMMARY: join(d, 'summary.md'), GITHUB_ENV: join(d, 'genv'), GITHUB_OUTPUT: join(d, 'gout'), GITHUB_ACTIONS: 'true', MWS_CLI_TOKEN: 'x', ACTIONS_RUNTIME_TOKEN: 'y', CORPUS_TARGETS_KEY: 'k' } });
  assert.equal(r.status, 0);
  for (const c of calls) {
    for (const k of ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_ACTIONS', 'MWS_CLI_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'CORPUS_TARGETS_KEY']) assert.ok(!c.env.includes(k), k);
    assert.ok(!c.argv.some((x) => /GITHUB_|TOKEN|CORPUS_TARGETS_KEY/.test(x)), c.argv.join(' '));
  }
  assert.equal(readFileSync(join(d, 'summary.md'), 'utf8'), '');
});

test('C1: an unpinned backend image, a capability outside the allowlist, a list without locks: harness errors', () => {
  const d = stand();
  const { r, meta } = drive(d, { only: 't05,t06,t07' });
  assert.equal(r.status, 1);
  assert.match(meta('t05').harness_error, /pinned by digest/);
  assert.match(meta('t06').harness_error, /SYS_ADMIN is not allowed/);
  assert.match(meta('t07').harness_error, /not hash-locked/);
  assert.equal(r.stdout.split('\n').filter((l) => l === 'run finished, exit 125').length, 3);
});

test('a target list in the v1 format is refused (it carries no locks)', () => {
  const d = stand({ format: 'isokron-corpus-targets/1' });
  const { r } = drive(d, { only: 't01' });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(readFileSync(join(d, 'out', '_shard', 'harness-error.txt'), 'utf8'), /another format/);
});

test('--consume-targets removes the clear-text list before any target runs', () => {
  const d = stand();
  const { r } = drive(d, { only: 't01', extraArgs: ['--consume-targets'] });
  assert.equal(r.status, 0);
  assert.throws(() => readFileSync(join(d, 'targets.json')));
  assert.match(JSON.parse(readFileSync(join(d, 'out', '_shard', 'shard.json'), 'utf8')).targets_list_sha256, /^[0-9a-f]{64}$/);
});

test('L2: the shard records its order seed (encrypted with the rest); the order follows it', () => {
  const d = stand();
  const { r } = drive(d, { only: 't01,t02,t04', env: { CORPUS_ORDER_SEED: 'cafe' } });
  assert.equal(r.status, 1);
  const s = JSON.parse(readFileSync(join(d, 'out', '_shard', 'shard.json'), 'utf8'));
  assert.equal(s.order_seed, 'cafe');
  assert.deepEqual(s.order, shuffled(['t01', 't02', 't04'], 'cafe'));
  assert.deepEqual(s.targets.map((t) => t.id), s.order);
});

test('R2-10: helper containers are named and carry their target label, so the per-target sweep finds them', () => {
  const d = stand();
  const { r, calls } = drive(d, { only: 't01' });
  assert.equal(r.status, 0);
  const helpers = calls.filter((c) => c.argv[0] === 'run' && c.argv.includes('none') && c.argv[c.argv.indexOf('--network') + 1] === 'none' && !c.argv.includes('--cpus')).map((c) => c.argv);
  assert.ok(helpers.length >= 3, 'CLI volume, volume set-up, file writes, copy-out');
  for (const a of helpers) assert.match(a[a.indexOf('--name') + 1], /-h\d+$/, a.join(' '));
  const mine = helpers.filter((a) => a.includes('isokron.corpus.target=t01'));
  assert.ok(mine.some((a) => a.join(' ').includes('cd /work/out')), 'copy-out');
  assert.ok(mine.some((a) => a.join(' ').includes('cat > "$1"')), 'file write');
  assert.ok(mine.some((a) => a.join(' ').includes('chown -R')), 'volume set-up');
  // Target containers are limited to 2 CPUs (or what the Docker server has).
  for (const c of calls.filter((x) => x.argv[0] === 'run' && x.argv.includes('--user') && x.argv.includes('10001:10001') && !/-h\d+$/.test(x.argv[x.argv.indexOf('--name') + 1]))) {
    assert.equal(c.argv[c.argv.indexOf('--cpus') + 1], '2');
  }
});

test('R2-3: lane mac refuses a target with install scripts (harness error); others run', () => {
  const d = stand();
  const { r, meta, calls } = drive(d, { only: 't08,t09', extraArgs: ['--lane', 'mac'] });
  assert.equal(r.status, 1);
  assert.match(meta('t08').harness_error, /lane mac/);
  assert.equal(meta('t09').status, 'completed');
  assert.ok(!calls.some((c) => c.argv.includes('isokron.corpus.target=t08')), 'nothing of t08 was started');
});

test('R2-4: a Docker Engine older than 26.0.0 stops the shard before any target', () => {
  const d = stand();
  writeFileSync(join(d, 'fake', 'server-version'), '25.0.5\n');
  const { r, calls } = drive(d, { only: 't01' });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(readFileSync(join(d, 'out', '_shard', 'harness-error.txt'), 'utf8'), /older than 26\.0\.0/);
  assert.ok(!calls.some((c) => c.argv[0] === 'run'));
});

test('R2-1: output past the caps is dropped, an oversized results.json is recorded by size only, meta.json is written', () => {
  const d = stand();
  writeFileSync(join(d, 'fake', 'deps-bytes'), '5000');
  const { r, meta } = drive(d, { only: 't01,t04', env: { CORPUS_LOG_CAP: '40', CORPUS_BUF_CAP: '1000', CORPUS_JSON_CAP: '10' } });
  assert.equal(r.status, 0, r.stdout);
  for (const id of ['t01', 't04']) {
    const m = meta(id);
    assert.equal(m.status, 'completed');
    assert.equal(m.results[0].status, 'too large to read');
    assert.match(m.results[0].sha256, /^[0-9a-f]{64}$/);
  }
  const log = readFileSync(join(d, 'out', 't01', 'logs', 'catalog.log'), 'utf8');
  assert.match(log, /bytes of output dropped \(log cap\)/);
  assert.ok(!log.includes(`${NAME} on stderr`), 'stderr past the cap is not in the log');
  // Captured stdout (the deps step) is cut at the cap; the log keeps a prefix of the cap's size.
  assert.equal(readFileSync(join(d, 'out', 't04', 'deps.json')).length, 1000);
  assert.match(readFileSync(join(d, 'out', 't04', 'logs', 'deps.log'), 'utf8'), /\n(d{40})\n# 4961 bytes of output dropped \(log cap\)/);
});

// ------------------------------------------------------------------------------------------------
// A: backend capabilities and logs; the server under test gets no capability
// ------------------------------------------------------------------------------------------------

const cliRuns = (calls) => calls.filter((c) => c.argv[0] === 'run' && c.argv.includes('/opt/mwsc/dist/src/cli/main.js')).map((c) => c.argv);
const backendRuns = (calls) => calls.filter((c) => c.argv[0] === 'run' && c.argv.includes('-d')).map((c) => c.argv);
const adds = (a) => a.filter((x, i) => a[i - 1] === '--cap-add');

test('A: a backend gets the five default capabilities; the CLI and server-under-test container gets none', () => {
  const d = stand();
  const { r, calls, meta } = drive(d, { only: 't10,t11' });
  assert.equal(r.status, 0, r.stdout);
  const b = backendRuns(calls);
  assert.equal(b.length, 2);
  const def = b.find((a) => a.includes('isokron.corpus.target=t10'));
  assert.deepEqual(adds(def).sort(), [...BACKEND_DEFAULT_CAPS].sort());
  assert.equal(def[def.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(def[def.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.ok(def.indexOf('--security-opt') < def.indexOf('--cap-drop') && def.indexOf('--cap-drop') < def.indexOf('--cap-add'));
  assert.deepEqual(adds(b.find((a) => a.includes('isokron.corpus.target=t11'))), ['SETUID', 'SETGID']);
  assert.deepEqual(meta('t10').backends[0].cap_add.sort(), [...BACKEND_DEFAULT_CAPS].sort());
  assert.equal(meta('t10').backends[0].cap_add_default, true);
  assert.equal(meta('t10').backends[0].ready, true);
  assert.equal(meta('t11').backends[0].cap_add_default, false);
  // The server under test runs inside the CLI's container (the CLI starts it): no capability at all.
  const cli = cliRuns(calls);
  assert.ok(cli.length >= 4, 'plan and catalog for both targets');
  for (const a of cli) {
    assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
    assert.deepEqual(adds(a), [], a.join(' '));
    assert.equal(a[a.indexOf('--user') + 1], '10001:10001');
    assert.ok(a.includes('--read-only') && !a.includes('--privileged'));
  }
  // Every other container that runs target code (install, set-up): no capability either.
  for (const c of calls.filter((x) => x.argv[0] === 'run' && x.argv.includes('10001:10001') && !/-h\d+$/.test(x.argv[x.argv.indexOf('--name') + 1]))) {
    assert.deepEqual(adds(c.argv), [], c.argv.join(' '));
  }
});

test('A: sandboxRunArgs takes no capability (the server-under-test container stays at --cap-drop ALL)', () => {
  const a = sandboxRunArgs({ name: 'n', image: IMG, network: 'none', mounts, capAdd: ['SETUID'], cap_add: ['SETUID'], cmd: ['node', '/opt/mwsc/dist/src/cli/main.js', 'catalog'] });
  assert.ok(!a.includes('--cap-add'));
  assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
});

test('A: a backend that is not ready: docker logs (capped) and its state go into backend-N.log before the teardown', () => {
  const d = stand();
  writeFileSync(join(d, 'fake', 'backend-not-ready'), '');
  writeFileSync(join(d, 'fake', 'backend-log-bytes'), '5000');
  const { r, calls, meta } = drive(d, { only: 't10', env: { CORPUS_LOG_CAP: '300' } });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.ok(!r.stdout.includes(NAME) && r.stderr === '');
  const m = meta('t10');
  assert.match(m.harness_error, /backend 0 not ready/);
  assert.equal(m.backends[0].ready, false);
  assert.equal(m.backends[0].log, 'logs/backend-0.log');
  const log = readFileSync(join(d, 'out', 't10', 'logs', 'backend-0.log'), 'utf8');
  assert.match(log, /\$ docker logs --timestamps corpus-\w+-t10-b0/);
  assert.match(log, /state exited exit 127/);
  assert.match(log, /bytes of output dropped \(log cap\)/, 'the logs are capped like every other command');
  assert.ok(!log.includes('L'.repeat(400)));
  // The logs were read before the teardown removed the container.
  const i = calls.findIndex((c) => c.argv[0] === 'logs' && c.argv.includes('--timestamps'));
  const rm = calls.findIndex((c) => c.argv[0] === 'rm');
  assert.ok(i >= 0 && (rm === -1 || i < rm), 'logs before rm');
});

test('A: a target with a capability outside the allowlist is refused at load; nothing of it starts, the others run', () => {
  const d = stand();
  const { r, calls, meta } = drive(d, { only: 't01,t06' });
  assert.equal(r.status, 1);
  assert.match(meta('t06').harness_error, /^refused at load: backend 0: capability SYS_ADMIN is not allowed/);
  assert.equal(meta('t01').status, 'completed');
  const made = calls.filter((c) => ['run', 'create', 'pull', 'image'].includes(c.argv[0]) || c.argv[1] === 'create');
  assert.ok(!made.some((c) => c.argv.some((x) => x.includes('t06'))), 'nothing of t06 was pulled, started or created');
});

// ------------------------------------------------------------------------------------------------
// C1 (triage): the server's stderr is kept, capped, in the encrypted bundle only
// ------------------------------------------------------------------------------------------------

const TEE = join(root, 'corpus', 'sandbox', 'stderr-tee.mjs');
const tee = (dir, cap, script) => spawnSync(process.execPath, [TEE, dir, String(cap), '--', process.execPath, '-e', script], { encoding: 'utf8' });

test('C1: stderr-tee forwards stdout and stderr untouched, keeps the first cap bytes of stderr, passes the exit status on', () => {
  const d = join(mkdtempSync(join(tmpdir(), 'corpus-tee-')), 'server-stderr');
  const r = tee(d, 100, "process.stdout.write('{\"jsonrpc\":\"2.0\"}\\n'); process.stderr.write('e'.repeat(5000)); process.exitCode = 3;");
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '{"jsonrpc":"2.0"}\n', 'stdout is the server\'s, byte for byte');
  assert.equal(r.stderr, 'e'.repeat(5000), 'the CLI still sees all of stderr');
  const files = readdirSync(d);
  assert.equal(files.length, 1);
  assert.match(files[0], /^01-\d+\.log$/);
  const kept = readFileSync(join(d, files[0]), 'utf8');
  assert.ok(kept.startsWith(`${'e'.repeat(100)}\n# 4900 bytes of stderr dropped (cap 100)\n# server exit 3 signal null\n`), kept.slice(0, 300));
  assert.ok(!kept.includes('e'.repeat(101)));
});

test('C1: stderr-tee passes a terminating signal on, and keeps at most MAX_FILES files per folder', () => {
  const d = join(mkdtempSync(join(tmpdir(), 'corpus-tee-')), 'server-stderr');
  const r = tee(d, 1000, "process.stderr.write('bye\\n'); process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);");
  assert.equal(r.signal, 'SIGTERM');
  assert.match(readFileSync(join(d, readdirSync(d)[0]), 'utf8'), /^bye\n\n# server exit null signal SIGTERM\n$/);
  for (let i = readdirSync(d).length; i < MAX_FILES; i++) writeFileSync(join(d, `x${i}`), '');
  const r2 = tee(d, 1000, "process.stderr.write('more\\n');");
  assert.equal(r2.status, 0);
  assert.equal(r2.stderr, 'more\n', 'still forwarded');
  assert.equal(readdirSync(d).length, MAX_FILES, 'no file past the limit');
  // A server that cannot start: 127, and the reason on stderr.
  const r3 = spawnSync(process.execPath, [TEE, d, '10', '--', join(d, 'does-not-exist')], { encoding: 'utf8' });
  assert.equal(r3.status, 127);
});

test('C1: init and the catalog manifest start the server through the stderr-tee; a hand-written full manifest is run as written', () => {
  const w = serverWrap(['/work/bin/srv', '--x'], 1234);
  assert.deepEqual(w, ['node', '/opt/mwsc/_corpus/stderr-tee.mjs', STDERR_DIR, '1234', '--', '/work/bin/srv', '--x']);
  assert.ok(STDERR_DIR.startsWith('/work/out/'), 'inside the copied-out (encrypted) folder');
  const d = stand();
  const list = JSON.parse(readFileSync(join(d, 'targets.json'), 'utf8'));
  const t01 = list.targets.find((t) => t.id === 't01');
  list.targets.push({ ...t01, id: 't12', init: true });
  list.targets.push({ ...t01, id: 't13', full: { manifest: 'mws: "0.9"\nserver:\n  stdio: ["{{bin}}/srv"]\nresources:\n  - read: { args: { id: "{{id}}", v: "{{version}}", o: "{{json:object}}", m: "{{my_var}}" } }\n', confirm: 'x', plan_hash: 'ffffffffffffffff' } }); // drift: plan and catalog only
  writeFileSync(join(d, 'targets.json'), JSON.stringify(list));
  const { r, calls, meta } = drive(d, { only: 't12,t13' });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.stdout.includes('server stderr') && !r.stdout.includes(NAME) && r.stderr === '', 'nothing of it in the public output');
  const init = cliRuns(calls).find((a) => a.includes('init') && a.includes('isokron.corpus.target=t12'));
  assert.deepEqual(init.slice(init.indexOf('--') + 1), ['node', '/opt/mwsc/_corpus/stderr-tee.mjs', STDERR_DIR, String(4 * 1024 * 1024), '--', '/work/bin/srv']);
  assert.match(readFileSync(join(d, 'out', 't12', 'writecheck.yaml'), 'utf8'), /stdio: \["node", "\/opt\/mwsc\/_corpus\/stderr-tee\.mjs", "\/work\/out\/server-stderr", "\d+", "--", "\/work\/bin\/srv"\]/);
  assert.equal(readFileSync(join(d, 'out', 't13', 'writecheck.yaml'), 'utf8'), 'mws: "0.9"\nserver:\n  stdio: ["/work/bin/srv"]\nresources:\n  - read: { args: { id: "{{id}}", v: "{{version}}", o: "{{json:object}}", m: "{{my_var}}" } }\n'); // the CLI's templates pass through
  // The kept stderr came back with the rest of /work/out, under sandbox/ (encrypted bundle), and is listed in meta.
  const m = meta('t12');
  assert.equal(m.server_stderr.length, 1);
  assert.equal(m.server_stderr[0].file, 'sandbox/server-stderr/01-7.log');
  assert.match(m.server_stderr[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(readFileSync(join(d, 'out', 't12', 'sandbox', 'server-stderr', '01-7.log'), 'utf8'), /missing setting/);
  assert.equal(m.isolation.server_stderr_cap, 4 * 1024 * 1024);
  assert.deepEqual(Object.keys(m.sandbox_tools_sha256).sort(), readdirSync(join(root, 'corpus', 'sandbox')).filter((f) => f.endsWith('.mjs')).sort());
  // Our helpers went into the CLI volume, read-only for every target container.
  assert.ok(calls.some((c) => c.argv[0] === 'run' && c.argv.join(' ').includes('/opt/mwsc/_corpus') && c.argv.includes('--interactive')));
  for (const a of cliRuns(calls)) assert.ok(a.includes('type=volume,src=' + a.find((x) => /src=corpus-\w+-cli,/.test(x))?.split('src=')[1].split(',')[0] + ',dst=/opt/mwsc,readonly'), a.join(' '));
});

// ------------------------------------------------------------------------------------------------
// B: set-up `fetch`: a pinned tarball instead of git
// ------------------------------------------------------------------------------------------------

const COMMIT = 'c'.repeat(40);
const GH = `https://github.com/o/r/archive/${COMMIT}.tar.gz`;
const shaOf = (b) => createHash('sha256').update(b).digest('hex');

/** A stand-in WHATWG fetch: a map of URL to { status, location?, body? }. */
function fakeFetch(routes, seen = []) {
  return async (url, opts) => {
    seen.push({ url, redirect: opts?.redirect });
    const r = routes[url];
    if (!r) return new Response(null, { status: 404 });
    return new Response(r.body ?? null, { status: r.status ?? 200, headers: r.location ? { location: r.location } : {} });
  };
}

test('B: fetch URLs: https on allowlisted hosts only; a GitHub archive must name a commit', () => {
  assert.deepEqual([...FETCH_HOSTS].sort(), ['codeload.github.com', 'files.pythonhosted.org', 'github.com', 'registry.npmjs.org']);
  assert.equal(checkListedUrl(GH).hostname, 'github.com');
  assert.ok(checkListedUrl(`https://codeload.github.com/o/r/tar.gz/${COMMIT}`));
  assert.ok(checkListedUrl('https://registry.npmjs.org/x/-/x-1.0.0.tgz'));
  for (const bad of [
    `http://github.com/o/r/archive/${COMMIT}.tar.gz`, 'https://github.com/o/r/archive/main.tar.gz', 'https://github.com/o/r/archive/v1.2.tar.gz',
    'https://example.com/x.tgz', `https://user:pw@github.com/o/r/archive/${COMMIT}.tar.gz`, `https://github.com:8443/o/r/archive/${COMMIT}.tar.gz`,
    'https://registry.npmjs.org/x.tgz?y=1', 'https://registry.npmjs.org/x.tgz#f', 'https://169.254.169.254/x.tgz', 'https://localhost/x.tgz', 'file:///etc/passwd', 'git+https://github.com/o/r',
    'https://registry.npmjs.org/a/%2Fb.tgz',
  ]) assert.throws(() => checkListedUrl(bad), /fetch:/, bad);
});

test('B: fetchVerified writes the file only when the sha256 matches; a mismatch is refused and leaves nothing', async () => {
  const d = mkdtempSync(join(tmpdir(), 'corpus-fetch-'));
  const body = Buffer.from('tarball bytes');
  const codeload = `https://codeload.github.com/o/r/tar.gz/${COMMIT}`;
  const seen = [];
  const f = fakeFetch({ [GH]: { status: 302, location: codeload }, [codeload]: { body } }, seen);
  const ok = await fetchVerified({ url: GH, sha256: shaOf(body), out: join(d, 'a', '0.tgz'), cap: 1000, fetchImpl: f });
  assert.deepEqual(ok, { sha256: shaOf(body), bytes: body.length });
  assert.deepEqual(readFileSync(join(d, 'a', '0.tgz')), body);
  assert.ok(seen.every((x) => x.redirect === 'manual'), 'redirects are followed by hand, each one checked');
  // sha256 mismatch: refused, no file left.
  await assert.rejects(fetchVerified({ url: GH, sha256: '0'.repeat(64), out: join(d, '1.tgz'), cap: 1000, fetchImpl: f }), /sha256 [0-9a-f]{64} is not the pinned/);
  assert.ok(!existsSync(join(d, '1.tgz')));
  // Over the cap: refused, no file left.
  await assert.rejects(fetchVerified({ url: GH, sha256: shaOf(body), out: join(d, '2.tgz'), cap: 4, fetchImpl: f }), /cap/);
  assert.ok(!existsSync(join(d, '2.tgz')));
  // A redirect off the allowlist, or to http: refused before anything is written.
  for (const location of ['https://evil.example/x.tgz', `http://codeload.github.com/o/r/tar.gz/${COMMIT}`, 'https://169.254.169.254/latest/meta-data']) {
    await assert.rejects(fetchVerified({ url: GH, sha256: shaOf(body), out: join(d, '3.tgz'), cap: 1000, fetchImpl: fakeFetch({ [GH]: { status: 301, location } }) }), /fetch:/, location);
    assert.ok(!existsSync(join(d, '3.tgz')));
  }
  // A redirect loop, an HTTP error, a missing or malformed sha256.
  await assert.rejects(fetchVerified({ url: GH, sha256: shaOf(body), out: join(d, '4.tgz'), cap: 1000, fetchImpl: fakeFetch({ [GH]: { status: 302, location: GH } }) }), /too many redirects/);
  await assert.rejects(fetchVerified({ url: GH, sha256: shaOf(body), out: join(d, '5.tgz'), cap: 1000, fetchImpl: fakeFetch({}) }), /HTTP 404/);
  await assert.rejects(fetchVerified({ url: GH, sha256: 'ABC', out: join(d, '6.tgz'), cap: 1000, fetchImpl: f }), /sha256 must be/);
  // The file is created exclusively and never through a symlink (something planted there).
  symlinkSync(join(d, 'victim'), join(d, '7.tgz'));
  await assert.rejects(fetchVerified({ url: GH, sha256: shaOf(body), out: join(d, '7.tgz'), cap: 1000, fetchImpl: f }), /EEXIST|ELOOP/);
  assert.ok(!existsSync(join(d, 'victim')));
});

test('B: set-up fetch entries are checked at load: sha256 required, allowlisted URL, safe dest, no unknown field', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(checkFetch({ fetch: { url: GH, sha256: sha } }), { url: GH, sha256: sha, dest: 'src', strip: 0 });
  assert.deepEqual(checkFetch({ fetch: { url: GH, sha256: sha, dest: 'src/app', strip_components: 1 } }), { url: GH, sha256: sha, dest: 'src/app', strip: 1 });
  for (const bad of [
    { fetch: { url: GH } }, { fetch: { url: GH, sha256: 'A'.repeat(64) } }, { fetch: { url: 'https://example.com/x.tgz', sha256: sha } },
    { fetch: { url: GH, sha256: sha, dest: '../x' } }, { fetch: { url: GH, sha256: sha, dest: '/etc' } }, { fetch: { url: GH, sha256: sha, dest: 'out' } },
    { fetch: { url: GH, sha256: sha, dest: 'home/.npmrc' } }, { fetch: { url: GH, sha256: sha, dest: 'a/../../b' } }, { fetch: { url: GH, sha256: sha, dest: '.fetch' } },
    { fetch: { url: GH, sha256: sha, strip_components: 9 } }, { fetch: { url: GH, sha256: sha, strip_components: '1' } },
    { fetch: { url: GH, sha256: sha, run: 'x' } }, { fetch: { url: GH, sha256: sha }, sh: 'x' }, { git: GH }, ['x'], null, 7,
  ]) {
    assert.throws(() => checkFetch(bad), /set-up/, JSON.stringify(bad));
    assert.throws(() => validateTarget({ id: 't01', setup: ['echo ok', bad] }), /set-up 1/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => validateTarget({ id: 't01', setup: ['echo ok', { fetch: { url: GH, sha256: sha } }] }));
});

function fetchTargets(d, steps) {
  const list = JSON.parse(readFileSync(join(d, 'targets.json'), 'utf8'));
  const t01 = list.targets.find((t) => t.id === 't01');
  list.targets.push({ ...t01, id: 't14', setup: steps });
  writeFileSync(join(d, 'targets.json'), JSON.stringify(list));
}

test('B: a fetch step runs our helper on the install network, then unpacks the verified file with no network', () => {
  const d = stand();
  const sha = 'e'.repeat(64);
  fetchTargets(d, [{ fetch: { url: GH, sha256: sha, dest: 'src', strip_components: 1 } }, 'ls {{tdir}}/src']);
  const { r, calls, meta } = drive(d, { only: 't14' });
  assert.equal(r.status, 0, r.stdout);
  const nets = JSON.parse(readFileSync(join(d, 'fake', 'networks.json'), 'utf8'));
  const runs = calls.filter((c) => c.argv[0] === 'run').map((c) => c.argv);
  const fi = runs.findIndex((a) => a.includes('/opt/mwsc/_corpus/fetch.mjs'));
  const fa = runs[fi];
  assert.ok(fa, 'the fetch helper ran');
  assert.equal(nets[fa[fa.indexOf('--network') + 1]], false, 'the install (egress) network');
  assert.equal(fa[fa.indexOf('--user') + 1], '10001:10001');
  assert.equal(fa[fa.indexOf('--cap-drop') + 1], 'ALL');
  assert.ok(!fa.includes('--cap-add') && fa.includes('--read-only') && fa.includes('no-new-privileges'));
  assert.ok(fa.includes('type=volume,src=' + fa.find((x) => /-cli,dst=/.test(x))?.split('src=')[1].split(',')[0] + ',dst=/opt/mwsc,readonly'), 'our script, read-only');
  assert.deepEqual(fa.slice(-6), ['node', '/opt/mwsc/_corpus/fetch.mjs', GH, sha, '/work/.fetch/0.tgz', String(256 * 1024 * 1024)]);
  assert.ok(!fa.some((x) => x.startsWith('PATH=') || x.startsWith('NODE_OPTIONS=')), 'no target environment');
  const ua = runs[fi + 1];
  assert.equal(ua[ua.indexOf('--network') + 1], 'none', 'unpack: no network');
  assert.deepEqual(ua.slice(-4), ['sh', '/work/.fetch/0.tgz', '/work/src', '1']);
  assert.match(ua.at(-5), /tar -xzf "\$1" -C "\$2" --no-same-owner --no-same-permissions --strip-components="\$3"/);
  assert.ok(runs.slice(fi + 2).some((a) => a.includes('ls /work/src')), 'the next set-up line runs after it');
  assert.deepEqual(meta('t14').setup_fetch, [{ step: 0, url: GH, sha256: sha, bytes: 10, dest: 'src', strip_components: 1 }]);
});

test('B: a sha256 mismatch (helper refusal, or a line that does not match the pin) stops the target before any unpack', () => {
  for (const [file, val] of [['fetch-exit', '3'], ['fetch-sha', '0'.repeat(64)]]) {
    const d = stand();
    writeFileSync(join(d, 'fake', file), val);
    fetchTargets(d, [{ fetch: { url: GH, sha256: 'e'.repeat(64) } }, 'echo never']);
    const { r, calls, meta } = drive(d, { only: 't14' });
    assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`, file);
    assert.match(meta('t14').harness_error, file === 'fetch-exit' ? /set-up 0 fetch: refused or failed \(exit 3\)/ : /set-up 0 fetch: sha256 is not the pinned one/);
    assert.ok(!calls.some((c) => c.argv.join(' ').includes('--strip-components')), 'nothing unpacked');
    assert.ok(!calls.some((c) => c.argv.join(' ').includes('echo never')));
    assert.deepEqual(meta('t14').setup_fetch, []);
  }
});

test('B: a fetch entry outside the rules is refused at load; nothing of it is fetched', () => {
  const d = stand();
  fetchTargets(d, [{ fetch: { url: 'https://example.com/x.tgz', sha256: 'e'.repeat(64) } }]);
  const { r, calls, meta } = drive(d, { only: 't14' });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(meta('t14').harness_error, /^refused at load: set-up 0: fetch: host example\.com is not allowlisted/);
  assert.ok(!calls.some((c) => c.argv[0] === 'run' && c.argv.includes('isokron.corpus.target=t14')));
});
