// WC13: the Redis fixture of the writecheck loop (loop/fixtures/redis-tracker, dogfood/redis-tracker/writecheck.yaml): a
// source fixture pinned by the digest of its committed folder, with no dependency; a real Redis server (the redis-server
// executable of a digest-pinned official image, copied out of it) started inside the sandbox container for the full write
// test only; every result of that test labelled "hermetic" with backend_kind redis.
//
// Offline tests run everywhere. The live tests (R-WC-23) run the pinned CLI against a real redis-server on this machine,
// with the clean build and with each defect build; they need CLI_DIR (a built packages/writecheck) and REDISFX_BIN_DIR
// (the three files of fixtures.json's binary_image, from `node loop/extract-binary.mjs redis-tracker <dir>`) on a Linux
// machine, and skip themselves without them.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dockerPlatform, extractBinaryImage } from '../loop/binary-image.mjs';
import { BACKEND_HERMETIC, INSTALL_SCRIPT_ALLOW, RESERVED_MOUNTS, isProofLane, loadFixtures, lockProblems, parseItems, resolveSubject, sourceDigest, validateFixtures } from '../loop/items.mjs';
import { findRunFolder, observations, summarize } from '../loop/summary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(root, 'loop', 'fixtures', 'redis-tracker');
const read = (p) => readFileSync(join(root, p), 'utf8');
const fixtures = () => loadFixtures(join(root, 'loop', 'fixtures.json'));
const tmps = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const sha = (b) => createHash('sha256').update(b).digest('hex');

const copyFixture = (to) => cpSync(FIX, to, { recursive: true, filter: (s) => !s.split('/').includes('node_modules') });

test('R-WC-19: redis-tracker is a source fixture with no dependency: its folder is pinned by digest, its Redis client is its own', () => {
  const f = fixtures().fixtures['redis-tracker'];
  assert.equal(f.source.dir, 'loop/fixtures/redis-tracker');
  assert.equal(sourceDigest(FIX), f.source.sha256, 'fixtures.json pins the committed bytes of the folder');
  assert.equal(f.integrity, undefined);
  assert.equal(f.launch.install_scripts, undefined, 'nothing to link or build: the install runs with scripts off, in the slim image');
  const lock = JSON.parse(readFileSync(join(FIX, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lockProblems(f, lock, 'redis-tracker'), []);
  assert.deepEqual(Object.keys(lock.packages), [''], 'the lockfile has the package and nothing else');
  assert.deepEqual(JSON.parse(readFileSync(join(FIX, 'package.json'), 'utf8')).dependencies, {});
  assert.deepEqual(Object.keys(INSTALL_SCRIPT_ALLOW).includes('redis-tracker') && 'ok', 'ok');
  assert.equal(INSTALL_SCRIPT_ALLOW['redis-tracker'].test('node_modules/anything'), false, 'no package may run an install script');
  // No import of anything but Node's own modules and the folder's own files: a client library would be a dependency to pin.
  for (const file of readdirSync(join(FIX, 'src'))) {
    const src = readFileSync(join(FIX, 'src', file), 'utf8').replace(/\/\/[^\n]*/g, '');
    for (const m of src.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2];
      assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `${file} imports ${spec}`);
    }
  }
});

test('R-WC-19: a changed byte of the fixture, a dependency, a loosened lock or a lost label is refused (mutations)', () => {
  const base = JSON.parse(read('loop/fixtures.json'));
  const dir = tmp('wc13-mut-');
  mkdirSync(join(dir, 'loop', 'fixtures'), { recursive: true });
  for (const name of ['redis-tracker', 'pg-tracker', 'tiny-tracker', 'kronicle-lite']) cpSync(join(root, 'loop', 'fixtures', name), join(dir, 'loop', 'fixtures', name), { recursive: true, filter: (s) => !s.split('/').includes('node_modules') });
  writeFileSync(join(dir, 'loop', 'fixtures.json'), JSON.stringify(base));
  assert.doesNotThrow(() => loadFixtures(join(dir, 'loop', 'fixtures.json')));
  // 1. A changed byte of the server's source, of the client, or a new file in src/.
  const store = join(dir, 'loop', 'fixtures', 'redis-tracker', 'src', 'store.mjs');
  const orig = readFileSync(store, 'utf8');
  writeFileSync(store, `${orig}\n// a change nobody reviewed\n`);
  assert.throws(() => loadFixtures(join(dir, 'loop', 'fixtures.json')), /digest/);
  writeFileSync(store, orig);
  writeFileSync(join(dir, 'loop', 'fixtures', 'redis-tracker', 'src', 'extra.mjs'), 'export {};\n');
  assert.throws(() => loadFixtures(join(dir, 'loop', 'fixtures.json')), /digest/);
  rmSync(join(dir, 'loop', 'fixtures', 'redis-tracker', 'src', 'extra.mjs'));
  // 2. Config of the fixture entry.
  const bad = (edit) => { const d = structuredClone(base); edit(d.fixtures['redis-tracker']); return () => validateFixtures(d); };
  assert.throws(bad((f) => { f.integrity = `sha512-${'A'.repeat(86)}==`; }), /no integrity/);
  assert.throws(bad((f) => { f.backend.environment = 'shared'; }), /hermetic/);
  assert.throws(bad((f) => { delete f.backend; }), /backend must be/);
  assert.throws(bad((f) => { f.source.dir = 'loop/fixtures/tiny-tracker'; }), /lock folder/);
  assert.throws(bad((f) => { f.background.only = ['plan', 'serve']; }), /background\.only/);
  // 3. A dependency, or an install script, in the lock.
  const f = fixtures().fixtures['redis-tracker'];
  const lock = JSON.parse(readFileSync(join(FIX, 'package-lock.json'), 'utf8'));
  const withDep = structuredClone(lock);
  withDep.packages[''].dependencies = { redis: '^5.0.0' };
  withDep.packages['node_modules/redis'] = { version: '5.0.0', resolved: 'https://registry.npmjs.org/redis/-/redis-5.0.0.tgz', integrity: `sha512-${'A'.repeat(86)}==` };
  assert.ok(lockProblems(f, withDep, 'redis-tracker').some((p) => p.includes('exact version')));
  const script = structuredClone(lock);
  script.packages['node_modules/x'] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: `sha512-${'A'.repeat(86)}==`, hasInstallScript: true };
  assert.ok(lockProblems(f, script, 'redis-tracker').some((p) => p.includes('install script')));
  const foreign = structuredClone(lock);
  foreign.packages['node_modules/x'] = { version: '1.0.0', resolved: 'https://example.com/x.tgz', integrity: `sha512-${'A'.repeat(86)}==` };
  assert.ok(lockProblems(f, foreign, 'redis-tracker').some((p) => p.includes('registry.npmjs.org')));
});

test('R-WC-20: the backend binary is pinned twice, by the image\'s digest and by sha256 of each file, and the two pins agree', () => {
  const f = fixtures().fixtures['redis-tracker'];
  const b = f.binary_image;
  assert.match(b.ref, /^docker\.io\/library\/redis:8\.2\.11-bookworm@sha256:[0-9a-f]{64}$/);
  assert.equal(b.mount, '/opt/redis');
  assert.deepEqual(Object.keys(b.files).sort(), ['linux/amd64', 'linux/arm64']);
  assert.deepEqual(Object.keys(b.files['linux/amd64']).sort(), ['libcrypto.so.3', 'libssl.so.3', 'redis-server']);
  // backend.mjs carries the same sha256 values (it checks them again inside the sandbox, from the mounted volume).
  const be = read('loop/fixtures/redis-tracker/src/backend.mjs');
  const pins = (key) => Object.fromEntries([...new RegExp(`'${key}': \\{([^}]+)\\}`).exec(be)[1].matchAll(/'([^']+)': '([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]));
  for (const [key, plat] of [['linux-x64', 'linux/amd64'], ['linux-arm64', 'linux/arm64']]) {
    assert.deepEqual(pins(key), Object.fromEntries(Object.entries(b.files[plat]).map(([n, v]) => [n, v.sha256])), `${key} pins agree with fixtures.json`);
  }
  assert.match(be, /has sha256 \$\{got\}, not the pinned/);
  assert.match(be, /process\.env\.REDISFX_BIN_DIR \|\| DEFAULT_BIN_DIR/);
  assert.match(be, /DEFAULT_BIN_DIR = '\/opt\/redis'/);
  // The version measured from the running server must be the pinned one, and the label says it.
  const pinned = /PINNED_SERVER_VERSION = '([0-9.]+)'/.exec(be)[1];
  assert.ok(f.backend.version.includes(`Redis ${pinned} `), 'the label records the version the backend is checked to be');
  assert.ok(b.ref.includes(`redis:${pinned}-`));
  assert.match(be, /the server says it is Redis/);
  assert.equal(f.backend.kind, 'redis');
  // The driver mounts the files read-only at the mount the pins name, from a volume it filled after checking them.
  const run = read('loop/run-items.mjs');
  assert.match(run, /\{ src: u\.binVol, dst: u\.binaryImage\.mount, ro: true \}/);
  assert.match(run, /if \(u\.binaryImage\) u\.binVol = await this\.binaryVolume\(u\)/);
  assert.match(run, /extractBinaryImage\(/);
  // No file of the image runs outside the sandbox: the image is only created (never started) and copied from.
  const bi = read('loop/binary-image.mjs');
  assert.match(bi, /\['create', '--platform', platform, '--network', 'none'/);
  assert.doesNotMatch(bi, /\[\s*'(?:run|start|exec)'/);
});

test('R-WC-20: the image reference and the file pins are validated; a wrong file is refused before it is kept (mutations)', async () => {
  const base = JSON.parse(read('loop/fixtures.json'));
  const bad = (edit) => { const d = structuredClone(base); edit(d.fixtures['redis-tracker']); return () => validateFixtures(d); };
  assert.throws(bad((f) => { f.binary_image.ref = 'docker.io/library/redis:8.2.11-bookworm'; }), /official docker\.io\/library image by tag and digest/);
  assert.throws(bad((f) => { f.binary_image.ref = `ghcr.io/someone/redis:8@sha256:${'a'.repeat(64)}`; }), /official docker\.io\/library image/);
  assert.throws(bad((f) => { f.binary_image.ref = `docker.io/library/redis@sha256:${'a'.repeat(64)}`; }), /by tag and digest/);
  assert.throws(bad((f) => { f.binary_image.mount = '/opt/surface'; }), /mount/);
  assert.throws(bad((f) => { f.binary_image.mount = '/usr/local/bin'; }), /mount/);
  for (const m of ['/opt/surface', '/opt/bin', '/opt/node', '/opt/work', '/opt/out', '/opt/tools', '/opt/yarn', '/opt/yarn-v1']) assert.throws(bad((f) => { f.binary_image.mount = m; }), /mount/, m);
  assert.ok(RESERVED_MOUNTS.test('/opt/surface') && !RESERVED_MOUNTS.test('/opt/redis'));
  assert.throws(bad((f) => { delete f.binary_image.system_libs; }), /system_libs/);
  assert.throws(bad((f) => { f.binary_image.system_libs = ['../etc/passwd']; }), /system_libs/);
  // A second fixture with the same mount is refused.
  const twice = structuredClone(base);
  twice.fixtures['pg-tracker'].binary_image = structuredClone(twice.fixtures['redis-tracker'].binary_image);
  assert.throws(() => validateFixtures(twice), /another fixture's/);
  assert.throws(bad((f) => { delete f.binary_image.files['linux/arm64']; }), /exactly linux\/amd64 and linux\/arm64/);
  assert.throws(bad((f) => { delete f.binary_image.files['linux/arm64']['libssl.so.3']; }), /same files on both platforms/);
  assert.throws(bad((f) => { f.binary_image.files['linux/amd64']['redis-server'].sha256 = 'abc'; }), /must be \{ path, sha256 \}/);
  assert.throws(bad((f) => { f.binary_image.files['linux/amd64']['redis-server'].path = '../../etc/passwd'; }), /must be \{ path, sha256 \}/);
  assert.throws(bad((f) => { f.binary_image.extra = 1; }), /is \{ ref, mount, files, system_libs \}/);
  // extractBinaryImage with a stand-in for docker: the files it writes are checked against the pin.
  const f = fixtures().fixtures['redis-tracker'];
  const platform = 'linux/amd64';
  const content = { 'redis-server': Buffer.from('server'), 'libssl.so.3': Buffer.from('ssl'), 'libcrypto.so.3': Buffer.from('crypto') };
  const spec = structuredClone(f.binary_image);
  for (const n of Object.keys(content)) spec.files[platform][n].sha256 = sha(content[n]);
  const calls = [];
  const dockFor = (tamper) => async (argv) => {
    calls.push(argv[0]);
    if (argv[0] === 'cp') {
      const name = argv[2].split('/').pop();
      writeFileSync(argv[2], tamper === name ? Buffer.from('tampered') : content[name]);
    }
    return { exit: 0 };
  };
  const out = tmp('wc13-x-');
  const ok = await extractBinaryImage({ dock: dockFor(null), spec, platform, outDir: out, containerName: 'x' });
  assert.deepEqual(ok.files, Object.fromEntries(Object.entries(content).map(([n, b]) => [n, sha(b)])));
  assert.deepEqual(calls.filter((c) => c !== 'cp'), ['create', 'rm'], 'created, copied from, removed; never started');
  for (const victim of Object.keys(content)) {
    calls.length = 0;
    await assert.rejects(extractBinaryImage({ dock: dockFor(victim), spec, platform, outDir: tmp('wc13-x-'), containerName: 'x' }), new RegExp(`${victim.replace('.', '\\.')} copied from .* has sha256`));
    assert.equal(calls.at(-1), 'rm', 'the container is removed on a refusal too');
  }
  await assert.rejects(extractBinaryImage({ dock: async () => ({ exit: 1, stderr_tail: 'no such image' }), spec, platform, outDir: tmp('wc13-x-'), containerName: 'x' }), /docker create failed/);
  assert.equal(dockerPlatform('x64'), 'linux/amd64');
  assert.equal(dockerPlatform('arm64'), 'linux/arm64');
  assert.throws(() => dockerPlatform('ia32'), /no pinned binary image files/);
});

test('R-WC-21: every result of a full write test of redis-tracker is labelled hermetic, kind redis; nothing else is', () => {
  const f = fixtures().fixtures['redis-tracker'];
  assert.equal(f.backend.environment, BACKEND_HERMETIC);
  const results = (rs) => Buffer.from(JSON.stringify({ run: { status: 'complete', writes: 5 }, results: rs }));
  const files = new Map([
    ['full/run1/results.json', results([{ requirement: 'MWS-CONC-2', verdict: 'held', write_path: { tool: 'delete_item', resource: 'item' } }])],
  ]);
  const ran = summarize({ files, steps: [], planStdout: `plan hash: ${f.full.plan_hash}\n`, fullRan: true, acceptedPlanHash: f.full.plan_hash });
  const obs = observations(ran, { versions: {}, stagesRan: { install: true, full: true }, backend: f.backend });
  const cov = obs.find((o) => o.field === 'observation_coverage').value;
  assert.equal(cov.backend_environment, 'hermetic');
  assert.equal(cov.backend_kind, 'redis');
  assert.equal(obs.find((o) => o.field === 'backend_version').value, f.backend.version);
  assert.ok(obs.filter((o) => o.field === 'requirement_verdicts' && o.stage === 'full').flatMap((o) => o.value).every((v) => v.backend_environment === 'hermetic'));
  // No full run: "none", never hermetic.
  const none = observations(summarize({ files: new Map(), steps: [], planStdout: '', fullRan: false }), { versions: {}, stagesRan: {}, backend: f.backend });
  assert.deepEqual([none.find((x) => x.field === 'observation_coverage').value.backend_environment, none.find((x) => x.field === 'observation_coverage').value.backend_kind], ['none', 'none']);
  assert.ok(findRunFolder(files, 'full').dir);
});

test('R-WC-21: the backend runs inside the sandbox container, for the full write test only, on loopback, with a random password and no persistence; never a runner service', () => {
  const f = fixtures().fixtures['redis-tracker'];
  assert.deepEqual(f.background.only, ['run'], 'plan and catalog call no tool and do not start Redis');
  assert.deepEqual(f.background.args, ['backend', '--port', '4630']);
  assert.equal(f.manifest, 'dogfood/redis-tracker/writecheck.yaml');
  assert.deepEqual(f.random_env, ['REDISFX_PASSWORD'], 'the Redis password is random per run, never in fixtures.json or the manifest');
  assert.equal(new URL(f.env.REDISFX_URL).hostname, '127.0.0.1');
  assert.equal(new URL(f.env.REDISFX_CONTROL_URL).hostname, '127.0.0.1');
  assert.equal(JSON.stringify(f).includes('requirepass'), false);
  for (const w of readdirSync(join(root, '.github', 'workflows'))) assert.doesNotMatch(read(`.github/workflows/${w}`), /^\s*services:/m, w);
  const be = read('loop/fixtures/redis-tracker/src/backend.mjs');
  assert.match(be, /'bind 127\.0\.0\.1'/);
  assert.match(be, /'protected-mode yes'/);
  assert.doesNotMatch(be, /unixsocket/, 'no Unix socket');
  assert.match(be, /`requirepass \$\{password\}`/);
  assert.match(be, /'save ""', 'appendonly no'/, 'no persistence');
  assert.match(be, /'enable-debug-command no', 'enable-module-command no', 'enable-protected-configs no'/);
  assert.match(be, /\{ mode: 0o600 \}/, 'the password is in a private config file, not on a command line');
  assert.match(be, /wipe\(conf\)/, 'and the file is removed once the server is up');
  assert.match(be, /spawn\(bin\.server, \[conf\]/);
  assert.match(be, /listen\(port \+ 1, '127\.0\.0\.1'/);
  assert.match(be, /REDISFX_PASSWORD \(at least 16 characters\) is required/);
  assert.match(be, /!sameToken\(req\.headers\.authorization, `Bearer \$\{token\}`\)/);
  assert.match(be, /timingSafeEqual/);
  // The sandbox runs it as 65534 with a read-only root: its data dir is under $TMPDIR (the container's tmpfs), nothing else is written.
  assert.match(be, /process\.env\.REDISFX_DATA_DIR \|\| tmpdir\(\)/);
  // The PR proof runs the fixture in the sandbox with the other fixture servers.
  assert.match(read('.github/workflows/loop-fixture.yml'), /"fixture":"redis-tracker"/);
  assert.match(read('loop/check-bundles.mjs'), /fixture:redis-tracker/);
});

test('R-WC-22: redis-tracker has a subject of its own and is selected by its id in the item only', () => {
  const fx = fixtures();
  const repo = 'isokron-ai/mcp-writecheck-action';
  const own = fx.fixtures['redis-tracker'].subject;
  // History in tool-qa is keyed by subject: two backends must not share a key, so each source fixture's subject is <repository>.<id>.
  assert.equal(own, `${repo}.redis-tracker`);
  const subjects = Object.values(fx.fixtures).map((f) => f.subject.toLowerCase());
  assert.equal(new Set(subjects).size, subjects.length, 'no two fixtures share a subject');
  assert.equal(fx.fixtures['pg-tracker'].subject, `${repo}.pg-tracker`);
  const seed = { map: new Map([[repo, { id: repo, packages: [{ registry: 'npm', identifier: 'some-package' }] }]]) };
  assert.equal(resolveSubject(repo, { seed, fixtures: fx }).fixture, null, 'the repository itself, no id: the generic path');
  assert.equal(resolveSubject(own, { seed, fixtures: fx }).skip.reason, 'policy_excluded', 'the fixture subject with no id is never the fixture');
  assert.equal(resolveSubject(own, { seed, fixtures: fx }, 'redis-tracker').fixture, 'redis-tracker');
  assert.equal(resolveSubject(repo, { seed, fixtures: fx }, 'redis-tracker').skip.reason, 'policy_excluded', 'the id must go with its own subject');
  assert.equal(resolveSubject(fx.fixtures['pg-tracker'].subject, { seed, fixtures: fx }, 'redis-tracker').skip.reason, 'policy_excluded');
  const key = 'a'.repeat(64);
  const item = (subject, fixture, extra = {}) => ({ subject, ...(fixture ? { fixture } : {}), run_key: key, fence: 1, ...extra });
  assert.equal(parseItems(JSON.stringify([item(fx.fixtures['pg-tracker'].subject, 'pg-tracker'), item(own, 'redis-tracker', { fence: 2 })])).length, 2);
  assert.throws(() => parseItems(JSON.stringify([item(own, 'redis-tracker'), item(own, 'redis-tracker', { fence: 2 })])), /appears twice/);
  assert.throws(() => parseItems(JSON.stringify([item(own, 'Bad Id')])), /fixture id/);
  assert.match(read('.github/workflows/loop-fixture.yml'), /"subject":"isokron-ai\/mcp-writecheck-action\.redis-tracker","fixture":"redis-tracker","run_key"/);
});

test('R-WC-22: the plan a person accepted is in the repository and is the one fixtures.json names; a proof item never counts as an acceptance', () => {
  const f = fixtures().fixtures['redis-tracker'];
  // Accepted by the owner on 25 Nov 2026 (recorded in loop/BACKENDS.md): this hash and no other.
  assert.equal(f.full.plan_hash, '5ee5a5b97a2363b8');
  assert.equal(f.full.proposed_plan_hash, undefined, 'no proposal is left next to the accepted hash');
  const plan = read('dogfood/redis-tracker/plan.txt');
  assert.match(plan, new RegExp(`^plan hash: ${f.full.plan_hash}$`, 'm'));
  assert.match(plan, new RegExp(`for target ${f.full.confirm} \\(environment: test\\)`));
  assert.match(plan, /Hosts reached or given to the server: 127\.0\.0\.1:4630, 127\.0\.0\.1:4631\n/);
  assert.match(plan, /At most \d+ writes and \d+ created objects/);
  const m = read('dogfood/redis-tracker/writecheck.yaml');
  assert.match(m, new RegExp(`confirm: ${f.full.confirm}\\n`));
  assert.match(m, /base_env: REDISFX_CONTROL_URL/);
  assert.match(m, /env_passthrough: \[REDISFX_PASSWORD\]/);
  // Only a proof item (an explicit proof_plan in the item, which the pump does not send) runs the proposed plan, and the bundle says it was not accepted.
  const run = read('loop/run-items.mjs');
  assert.match(run, /acceptedHash: f\?\.full \? \(f\.full\.plan_hash \?\? \(proofPlan \? f\.full\.proposed_plan_hash \?\? null : null\)\) : null/);
  assert.match(run, /driver\.plan_accepted = false/);
  const own = fixtures().fixtures['redis-tracker'].subject;
  const u = (item, opts) => parseItems(JSON.stringify([{ subject: own, fixture: 'redis-tracker', run_key: 'a'.repeat(64), fence: 1, ...item }]), opts)[0];
  assert.equal(u({ proof_plan: true }, { proofLane: true }).proof_plan, true);
  assert.equal(u({}, { proofLane: true }).proof_plan, undefined);
  assert.throws(() => u({ proof_plan: 'yes' }, { proofLane: true }), /proof_plan/);
  assert.throws(() => parseItems(JSON.stringify([{ subject: 'isokron-ai/kronicle-lite', run_key: 'a'.repeat(64), fence: 1, proof_plan: true }]), { proofLane: true }), /only on an item that names a fixture/);
  // (a) Outside the pull-request proof an item with proof_plan is refused whole, whatever else it says: the default lane is read from the
  // event, which no dispatch can set; corpus.yml (workflow_dispatch) is never the proof lane.
  assert.throws(() => u({ proof_plan: true }, { proofLane: false }), /accepted only in the pull-request proof/);
  assert.throws(() => u({ proof_plan: true }), /accepted only in the pull-request proof/, 'no option: the environment of this test is not the proof');
  const proofEnv = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'isokron-ai/mcp-writecheck-action', GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-writecheck-action/.github/workflows/loop-fixture.yml@refs/pull/69/merge' };
  assert.equal(isProofLane(proofEnv), true);
  for (const [k, v] of [['GITHUB_EVENT_NAME', 'workflow_dispatch'], ['GITHUB_EVENT_NAME', 'push'], ['GITHUB_REPOSITORY', 'someone/fork'], ['GITHUB_WORKFLOW_REF', 'isokron-ai/mcp-writecheck-action/.github/workflows/corpus.yml@refs/heads/main'], ['GITHUB_WORKFLOW_REF', undefined]]) assert.equal(isProofLane({ ...proofEnv, [k]: v }), false, `${k}=${v}`);
  assert.equal(isProofLane({}), false);
  // The driver and the judge ask the same question of their own environment.
  assert.match(read('loop/run-items.mjs'), /parseItems\(env\.ITEMS, \{ proofLane: isProofLane\(env\) \}\)/);
  // (b) A proof item hands the summary no accepted hash: the record says the plan was not accepted, and there is no drift.
  assert.match(read('loop/run-items.mjs'), /acceptedPlanHash: u\.proofPlan \? null : u\.acceptedHash/);
  const hash = fixtures().fixtures['redis-tracker'].full.plan_hash;
  const files = new Map([['full/run1/results.json', Buffer.from(JSON.stringify({ run: { status: 'complete', writes: 1 }, results: [] }))]]);
  const asProof = summarize({ files, steps: [], planStdout: `plan hash: ${hash}\n`, fullRan: true, acceptedPlanHash: null });
  const record = observations(asProof, { versions: {}, stagesRan: { full: true }, backend: fixtures().fixtures['redis-tracker'].backend }).find((o) => o.field === 'plan_hash_and_drift').value;
  assert.deepEqual(record, { plan_hash: hash, accepted: null, drift: false, full_run: true });
  // The mutation: with the hash passed as accepted (what the code did before), the record would claim acceptance.
  const asAccepted = summarize({ files, steps: [], planStdout: `plan hash: ${hash}\n`, fullRan: true, acceptedPlanHash: hash });
  assert.equal(observations(asAccepted, { versions: {}, stagesRan: { full: true }, backend: null }).find((o) => o.field === 'plan_hash_and_drift').value.accepted, hash);
  // A proposed hash next to an accepted one is refused, as is a malformed one (mutations); the mechanism stays for the next fixture.
  const base = JSON.parse(read('loop/fixtures.json'));
  const bad = (edit) => { const d = structuredClone(base); edit(d.fixtures['redis-tracker']); return () => validateFixtures(d); };
  assert.throws(bad((x) => { x.full.proposed_plan_hash = '0123456789abcdef'; }), /proposed_plan_hash/);
  assert.throws(bad((x) => { x.full.proposed_plan_hash = 'xyz'; }), /proposed_plan_hash/);
  assert.doesNotThrow(bad((x) => { x.full.plan_hash = '0123456789abcdef'; delete x.full.proposed_plan_hash; }));
});

test('R-WC-19: the defects of the server, the manifest\'s comment and fixtures.json\'s known answers name the same builds', () => {
  const DEFECTS = /export const DEFECTS = \[([^\]]+)\]/.exec(read('loop/fixtures/redis-tracker/src/mcp.mjs'))[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.ok(DEFECTS.length >= 4);
  const f = fixtures().fixtures['redis-tracker'];
  assert.deepEqual(f.known_answers.map((k) => k.defect).sort(), [...DEFECTS].sort());
  const header = read('dogfood/redis-tracker/writecheck.yaml').split('\nmws:')[0].replace(/\n# /g, ' ');
  for (const d of DEFECTS) assert.ok(header.includes(d), `the manifest's header names ${d}`);
  for (const k of f.known_answers) assert.equal(k.env, 'REDISFX_DEFECTS');
  // The store has one place per defect that leaves its protection out; the correct build has both protections in the source.
  const st = read('loop/fixtures/redis-tracker/src/store.mjs');
  assert.match(st, /WATCH/);
  assert.match(st, /'NX'/);
  assert.match(st, /this\.defects\.has\('lost-update'\)/);
  assert.match(st, /this\.defects\.has\('idempotency-key-dropped'\)/);
});

/** The DT_NEEDED entries of a 64-bit little-endian ELF executable or shared object, read in process (no readelf, no ldd). */
export function neededLibs(buf) {
  assert.equal(buf.readUInt32BE(0), 0x7f454c46, 'an ELF file');
  assert.equal(buf[4], 2, '64-bit');
  assert.equal(buf[5], 1, 'little-endian');
  const phoff = Number(buf.readBigUInt64LE(32));
  const phentsize = buf.readUInt16LE(54);
  const phnum = buf.readUInt16LE(56);
  const loads = [];
  let dyn = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    const type = buf.readUInt32LE(o);
    const offset = Number(buf.readBigUInt64LE(o + 8));
    const vaddr = Number(buf.readBigUInt64LE(o + 16));
    const filesz = Number(buf.readBigUInt64LE(o + 32));
    if (type === 1) loads.push({ offset, vaddr, filesz });
    if (type === 2) dyn = { offset, filesz };
  }
  assert.ok(dyn, 'a dynamic section (a statically linked file needs nothing)');
  const toOffset = (va) => { const l = loads.find((x) => va >= x.vaddr && va < x.vaddr + x.filesz); assert.ok(l, 'address in a loaded segment'); return va - l.vaddr + l.offset; };
  const needed = [];
  let strtab = null;
  for (let o = dyn.offset; o < dyn.offset + dyn.filesz; o += 16) {
    const tag = Number(buf.readBigInt64LE(o));
    const val = Number(buf.readBigUInt64LE(o + 8));
    if (tag === 0) break;
    if (tag === 1) needed.push(val);
    if (tag === 5) strtab = toOffset(val);
  }
  const name = (off) => { let e = strtab + off; while (buf[e] !== 0) e++; return buf.toString('latin1', strtab + off, e); };
  return needed.map(name);
}

/** What of `needed` is neither a copied library nor one of the sandbox image's. */
export const unresolved = (needed, copied, system) => needed.filter((n) => !copied.includes(n) && !system.includes(n));

const ELF_DIR = process.env.REDISFX_BIN_DIR ?? null;
test('R-WC-20: every shared library redis-server needs is a pinned copied file or one of the sandbox image\'s (ELF NEEDED, read in process)', { skip: ELF_DIR && process.platform === 'linux' && existsSync(join(ELF_DIR ?? '', 'redis-server')) ? false : 'needs REDISFX_ELF_DIR (node loop/extract-binary.mjs redis-tracker <dir>)' }, () => {
  const b = fixtures().fixtures['redis-tracker'].binary_image;
  const copied = Object.keys(b.files['linux/amd64']).filter((n) => n !== 'redis-server');
  const server = readFileSync(join(ELF_DIR, 'redis-server'));
  const needed = neededLibs(server);
  assert.ok(needed.length >= 4 && needed.includes('libssl.so.3') && needed.includes('libc.so.6'), `read ${needed.join(', ')}`);
  assert.deepEqual(unresolved(needed, copied, b.system_libs), [], 'nothing the executable needs is missing');
  // The libraries we copy need only each other and the image's: the closure is complete.
  for (const lib of copied) assert.deepEqual(unresolved(neededLibs(readFileSync(join(ELF_DIR, lib))), copied, [...b.system_libs, 'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1']), [], `${lib} needs only what is there`);
  // The loader is the image's own too (the interpreter), not something to copy.
  // Mutations: drop a copied library, or a system one, from the sets and the check must find it.
  assert.deepEqual(unresolved(needed, copied.filter((n) => n !== 'libssl.so.3'), b.system_libs), ['libssl.so.3']);
  assert.deepEqual(unresolved(needed, copied, b.system_libs.filter((n) => n !== 'libstdc++.so.6')), ['libstdc++.so.6']);
});

// ---------------------------------------------------------------------------------------------------------------------
// R-WC-23 (live): the pinned CLI against a real redis-server, known-good and known-bad, with the defects switched on one by one.

const CLI_DIR = process.env.CLI_DIR ? join(process.cwd(), process.env.CLI_DIR) : null;
const cliMain = CLI_DIR && (existsSync(CLI_DIR) ? join(CLI_DIR, 'dist', 'src', 'cli', 'main.js') : null);
const BIN_DIR = process.env.REDISFX_BIN_DIR ?? null;
const haveBin = BIN_DIR && process.platform === 'linux' && existsSync(join(BIN_DIR, 'redis-server'));
const live = cliMain && existsSync(cliMain) && haveBin ? false : 'needs CLI_DIR (a built packages/writecheck) and REDISFX_BIN_DIR (node loop/extract-binary.mjs redis-tracker <dir>) on Linux';
// In the CI job that runs them a skip is a failure: the job cannot pass with nothing run.
const required = process.env.REDIS_LIVE_REQUIRED === '1';
if (required && live) test('R-WC-23: the live tests are required here and cannot run', () => assert.fail(live));

const PORT = 4630;
const waitLine = (child, re, ms) => new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error(`no ${re} from the backend in ${ms} ms: ${buf.slice(-400)}`)), ms);
  const on = (d) => { buf += d; if (re.test(buf)) { clearTimeout(t); resolve(buf); } };
  child.stdout.on('data', on);
  child.stderr.on('data', on);
  child.on('exit', (c) => { clearTimeout(t); reject(new Error(`the backend exited (${c}): ${buf.slice(-400)}`)); });
});
const password = () => 'a'.repeat(8) + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
const stopChild = async (c) => { c.kill('SIGTERM'); await new Promise((res) => { c.once('exit', res); setTimeout(res, 15_000); }); };

/** Starts the backend, runs `plan` and then `run` (or `catalog`) of the CLI over the fixture, stops the backend. Returns the results and the plan text. */
async function cliRun({ defect = '', mode = 'run' }) {
  const work = tmp('wc13-live-');
  mkdirSync(join(work, 'm', 'x'), { recursive: true });
  symlinkSync(FIX, join(work, 'rd'));
  const manifest = join(work, 'm', 'x', 'writecheck.yaml');
  writeFileSync(manifest, read('dogfood/redis-tracker/writecheck.yaml'));
  const f = fixtures().fixtures['redis-tracker'];
  const env = { ...process.env, ...f.env, REDISFX_PASSWORD: password(), REDISFX_DATA_DIR: work, REDISFX_BIN_DIR: BIN_DIR };
  delete env.REDISFX_DEFECTS;
  if (defect) env.REDISFX_DEFECTS = defect;
  let backend = null;
  let bufOut = '{"redis":""}';
  const t0 = Date.now();
  let backendMs = null;
  try {
    if (mode === 'run') {
      backend = spawn(process.execPath, [join(FIX, 'src', 'cli.mjs'), ...f.background.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      bufOut = await waitLine(backend, /"backend":.*\}/, 60_000);
      backendMs = Date.now() - t0;
    }
    const cli = (args) => spawnSync(process.execPath, [cliMain, ...args], { cwd: join(work, 'm', 'x'), env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
    const plan = cli(['plan', '-m', manifest]);
    assert.equal(plan.status, 0, plan.stderr || plan.stdout);
    const hash = /^plan hash: ([0-9a-f]{16})$/m.exec(plan.stdout)?.[1];
    assert.ok(hash, 'the plan printed a hash');
    const out = join(work, 'out');
    const r1 = Date.now();
    const r = mode === 'run'
      ? cli(['run', '-m', manifest, '--confirm-target', f.full.confirm, '--plan-hash', hash, '--out', out, '--state', join(work, 'state')])
      : cli(['catalog', '-m', manifest, '--out', out]);
    const runMs = Date.now() - r1;
    const dir = readdirSync(out)[0];
    const results = JSON.parse(readFileSync(join(out, dir, 'results.json'), 'utf8'));
    return { plan: plan.stdout, hash, status: r.status, results, redisVersion: /"redis":"([^"]*)"/.exec(bufOut)?.[1] ?? '', backendMs, runMs, log: `${r.stdout}${r.stderr}`.slice(-3000) };
  } finally {
    if (backend) await stopChild(backend);
  }
}

const verdicts = (results, req, tool) => results.results.filter((r) => r.requirement === req && (!tool || r.write_path?.tool === tool)).map((r) => r.verdict);
function expectViolated(run, req, tool) { assert.ok(verdicts(run.results, req, tool).includes('violated'), `${req} on ${tool} must be violated; got ${JSON.stringify(verdicts(run.results, req, tool))}\n${run.log}`); }
function expectHeld(run, req) { const v = verdicts(run.results, req); assert.ok(v.includes('held') && !v.includes('violated'), `${req} must hold; got ${JSON.stringify(v)}\n${run.log}`); }

test('R-WC-23: known good: the correct build against a real Redis holds every cell it tests, within the timing budget, and the plan is the accepted one', { skip: live, timeout: 300_000 }, async () => {
  const run = await cliRun({});
  const f = fixtures().fixtures['redis-tracker'];
  assert.equal(run.hash, f.full.plan_hash, 'the plan of this CLI, this manifest and this server is the accepted one (dogfood/redis-tracker/plan.txt)');
  assert.equal(run.plan.trim(), read('dogfood/redis-tracker/plan.txt').trim());
  assert.equal(run.status, 0, run.log);
  assert.equal(run.results.run.status, 'complete');
  assert.ok(f.backend.version.includes(`Redis ${run.redisVersion} `), `measured ${run.redisVersion}, labelled ${f.backend.version}`);
  assert.deepEqual(run.results.results.filter((r) => r.verdict === 'violated').map((r) => `${r.requirement} ${r.write_path?.tool}`), [], 'no violated record in the correct build');
  for (const req of ['MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-4', 'MWS-TGT-1', 'MWS-TGT-2', 'MWS-TGT-3', 'MWS-UPD-1', 'MWS-RES-3', 'MWS-RES-4', 'MWS-RETRY-1', 'MWS-RETRY-2', 'MWS-ANN-4', 'MWS-IN-1', 'MWS-IN-7']) expectHeld(run, req);
  // R-WC-13: the backend starts in seconds and the whole write test is a fraction of the 20-minute shard budget (a wide bound; BACKENDS.md has the measured figures).
  assert.ok(run.backendMs < 10_000, `Redis started in ${run.backendMs} ms`);
  assert.ok(run.runMs < 120_000, `the full write test took ${run.runMs} ms`);
  console.log(`# redis-tracker: backend ready in ${run.backendMs} ms, full write test ${run.runMs} ms, ${run.results.run.writes ?? '?'} writes`);
  // The mutation of the oracle: the same results do not satisfy "violated", so the checks below cannot pass vacuously.
  assert.throws(() => expectViolated(run, 'MWS-CONC-2', 'delete_item'), /must be violated/);
});

for (const [defect, req, tool] of [
  ['lost-update', 'MWS-CONC-2', 'delete_item'],
  ['empty-filter-deletes-all', 'MWS-TGT-2', 'delete_items'],
  ['idempotency-key-dropped', 'MWS-RETRY-2', 'create_item'],
]) {
  test(`R-WC-23: known bad (${defect}): the Redis cells catch it as ${req} on ${tool}, and the run still completes`, { skip: live, timeout: 300_000 }, async () => {
    const run = await cliRun({ defect });
    assert.equal(run.results.run.status, 'complete', run.log);
    assert.equal(run.status, 1, 'a violated MUST fails the run');
    expectViolated(run, req, tool);
    for (const other of ['MWS-CONC-2', 'MWS-TGT-2', 'MWS-RETRY-2'].filter((x) => x !== req)) assert.ok(!verdicts(run.results, other).includes('violated'), `${other} unaffected by ${defect}`);
  });
}

test('R-WC-23: known bad (missing-annotations): the catalog read, which needs no Redis, catches it as MWS-ANN-4', { skip: live, timeout: 120_000 }, async () => {
  const good = await cliRun({ mode: 'catalog' });
  expectHeld(good, 'MWS-ANN-4');
  const bad = await cliRun({ mode: 'catalog', defect: 'missing-annotations' });
  expectViolated(bad, 'MWS-ANN-4');
  assert.ok(verdicts(bad.results, 'MWS-ANN-4').every((v) => v === 'violated'));
});

test('R-WC-23: the version check is real: of 20 simultaneous updates with one version exactly one wins, and without the check several do', { skip: live, timeout: 120_000 }, async () => {
  const work = tmp('wc13-race-');
  const pw = password();
  const env = { ...process.env, REDISFX_PASSWORD: pw, REDISFX_DATA_DIR: work, REDISFX_BIN_DIR: BIN_DIR };
  const backend = spawn(process.execPath, [join(FIX, 'src', 'cli.mjs'), 'backend', '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const { Store } = await import('../loop/fixtures/redis-tracker/src/store.mjs');
  const cfg = { host: '127.0.0.1', port: PORT, password: pw };
  const good = new Store(cfg);
  const lost = new Store(cfg, { defects: new Set(['lost-update']) });
  try {
    await waitLine(backend, /"backend":.*\}/, 60_000);
    for (const [store, name, check] of [[good, 'correct', (n) => assert.equal(n, 1)], [lost, 'lost-update', (n) => assert.ok(n > 1, `the defect build let ${n} through`)]]) {
      const { item } = await good.create({ title: `race-${name}` });
      const wins = (await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(item.id, { title: `t${i}` }, item.version)))).filter(Boolean);
      check(wins.length);
    }
    // A change made out of band (the control channel's way, straight in Redis) after the version was read makes the write stale.
    const { item } = await good.create({ title: 'oob' });
    await good.adminUpdate(item.id, { assignee: 'zed' });
    assert.equal(await good.update(item.id, { title: 'late' }, item.version), null, 'a stale version is refused after an out-of-band write');
    assert.equal((await good.get(item.id)).assignee, 'zed');
    // Simultaneous creates with one idempotency key make one item.
    const rs = await Promise.all(Array.from({ length: 10 }, () => good.create({ title: 'once' }, 'k-race')));
    assert.equal(new Set(rs.map((r) => r.item.id)).size, 1);
    assert.equal(rs.filter((r) => r.replayed).length, 9);
    assert.deepEqual(await good.create({ title: 'different' }, 'k-race'), { reused: true });
  } finally {
    await good.close(); await lost.close();
    await stopChild(backend);
  }
});

test('R-WC-23: the control channel answers a bad project with 400, a wrong token with 401, a missing item with 404, and moves the version', { skip: live, timeout: 120_000 }, async () => {
  const work = tmp('wc13-ctl-');
  const f = fixtures().fixtures['redis-tracker'];
  const pw = 'c'.repeat(8) + 'd'.repeat(12);
  const env = { ...process.env, REDISFX_PASSWORD: pw, REDISFX_DATA_DIR: work, REDISFX_BIN_DIR: BIN_DIR };
  const backend = spawn(process.execPath, [join(FIX, 'src', 'cli.mjs'), ...f.background.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitLine(backend, /"backend":.*\}/, 60_000);
    const url = f.env.REDISFX_CONTROL_URL;
    const call = (method, path, body, token = pw, headers = {}) => fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call('POST', '/items', { project: 'no-such-project', title: 'x' })).status, 400);
    assert.equal((await call('POST', '/items', { project: 'inbox' })).status, 400, 'a missing title is the caller\'s');
    assert.equal((await call('POST', '/items', { title: 'x', priority: 'high' })).status, 400, 'a priority that is not an integer is refused');
    assert.equal((await call('POST', '/items', { title: 'x' }, 'wrong')).status, 401);
    const made = await call('POST', '/items', { title: 'ok' });
    assert.equal(made.status, 201);
    const it = (await made.json()).item;
    assert.equal(it.version, 1);
    assert.equal((await call('GET', '/items/I-999999')).status, 404);
    const patched = await (await call('PATCH', `/items/${it.id}`, { assignee: 'bob' })).json();
    assert.equal(patched.item.version, 2, 'every change moves the version');
    assert.equal((await call('PUT', `/items/${it.id}`, { title: 'again' }, pw, { 'if-match': '1' })).status, 412);
    assert.equal((await call('DELETE', `/items/${it.id}`, undefined, pw, { 'if-match': '2' })).status, 200);
    assert.equal((await call('GET', `/items/${it.id}`)).status, 404);
  } finally {
    await stopChild(backend);
  }
});

test('R-WC-23: the backend refuses a changed library, a missing binary and a short password', { skip: live, timeout: 120_000 }, async () => {
  const work = tmp('wc13-bin-');
  const pw = 'e'.repeat(20);
  const run = (extra) => spawnSync(process.execPath, [join(FIX, 'src', 'cli.mjs'), 'backend', '--port', String(PORT)], { env: { ...process.env, REDISFX_PASSWORD: pw, REDISFX_DATA_DIR: work, REDISFX_BIN_DIR: BIN_DIR, ...extra }, encoding: 'utf8', timeout: 30_000 });
  // A copy of the files with one byte of the library changed: refused, nothing started.
  const copy = tmp('wc13-binc-');
  for (const n of ['redis-server', 'libssl.so.3', 'libcrypto.so.3']) cpSync(join(BIN_DIR, n), join(copy, n));
  writeFileSync(join(copy, 'libssl.so.3'), Buffer.concat([readFileSync(join(copy, 'libssl.so.3')), Buffer.from('x')]));
  const changed = run({ REDISFX_BIN_DIR: copy });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /libssl\.so\.3 has sha256 .*, not the pinned/);
  const missing = run({ REDISFX_BIN_DIR: tmp('wc13-empty-') });
  assert.match(missing.stderr, /has no /);
  assert.match(run({ REDISFX_PASSWORD: 'short' }).stderr, /at least 16 characters/);
});
