/**
 * The writecheck loop worker (loop/): inputs, subject mapping, the checked summary and field records, bundle
 * layout and caps, the control verdicts, the in-sandbox helpers, the kill switch, and a bundle built from our
 * functions judged by tool-qa's own contract, forgery and registry checks (copies at the pinned commit in
 * test/fixtures/loop/, hashes in VENDORED.json). No Docker, no network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE_MANIFEST, InputError, catalogManifest, loadFixtures, parseItems, resolveSubject, seedPackages, validateFixtures } from '../loop/items.mjs';
import { findRunFolder, observations, planHash, publicSummary, readCatalog, readResults, summarize, ndjson } from '../loop/summary.mjs';
import { BundleFiles, buildMeta, forgeryVerdict, hasIdentityKeys, knownBadVerdict, knownGoodVerdict, parseCollected, safeRawPath } from '../loop/bundle.mjs';
import { evaluateGuard, laneVariable, main as guardMain, refProblem } from '../loop/guard.mjs';
import { buildManifest, validateManifest } from './fixtures/loop/tool-qa/worker-kit/contract.mjs';
import { checkBundle } from './fixtures/loop/tool-qa/ingest/forgery.mjs';
import { parseRegistry, validateObservations } from './fixtures/loop/tool-qa/ingest/registry.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'test', 'fixtures', 'loop');
const KEY = 'a'.repeat(64);
const item = (subject, extra = {}) => ({ subject, run_key: KEY, fence: 3, ...extra });
const sha = (b) => createHash('sha256').update(b).digest('hex');

const SEED = {
  map: new Map([
    ['acme/npm-server', { id: 'acme/npm-server', transport: 'stdio', packages: [{ registry: 'pypi', identifier: 'acme-py' }, { registry: 'npm', identifier: '@acme/server' }] }],
    ['acme/py-server', { id: 'acme/py-server', transport: 'both', packages: [{ registry: 'pypi', identifier: 'acme-mcp' }] }],
    ['acme/oci-only', { id: 'acme/oci-only', transport: 'stdio', packages: [{ registry: 'oci', identifier: 'ghcr.io/acme/x:1' }, { registry: 'cargo', identifier: 'x' }] }],
    ['acme/http-only', { id: 'acme/http-only', transport: 'http', packages: [{ registry: 'npm', identifier: 'acme-http' }] }],
    ['acme/bad-name', { id: 'acme/bad-name', transport: 'stdio', packages: [{ registry: 'npm', identifier: 'Bad Name; rm -rf' }] }],
  ]),
};

test('vendored tool-qa and registry copies match VENDORED.json', () => {
  const v = JSON.parse(readFileSync(join(fx, 'VENDORED.json'), 'utf8'));
  for (const [p, h] of Object.entries(v.files)) assert.equal(sha(readFileSync(join(fx, 'tool-qa', p))), h, p);
  assert.equal(sha(readFileSync(join(fx, 'mcp-results-registry.yaml'))), v.registry.sha256);
  // The workflows pin the same tool-qa commit as the copies.
  for (const wf of ['corpus.yml', 'loop-fixture.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', wf), 'utf8');
    assert.match(text, new RegExp(`WORKER_KIT_REF: '${v.commit}'`), wf);
  }
});

test('items: the pump\'s list, checked whole', () => {
  assert.deepEqual(parseItems(JSON.stringify([item('acme/npm-server')])), [{ index: 0, subject: 'acme/npm-server', run_key: KEY, fence: 3 }]);
  const bad = [
    '', 'not json', '{}', '[]', JSON.stringify(Array.from({ length: 11 }, (_, i) => item(`acme/s${i}`))),
    `[${JSON.stringify(item('acme/x'))}\n]`, JSON.stringify([item('acme/x', { run_key: 'A'.repeat(64) })]), JSON.stringify([item('acme/x', { fence: 0 })]),
    JSON.stringify([item('acme/x', { fence: 1.5 })]), JSON.stringify([item('../x')]), JSON.stringify([item('acme/x\nb')]), JSON.stringify([item('acme/x', { extra: 1 })]),
    JSON.stringify([item('acme/x'), item('ACME/X')]),
  ];
  for (const b of bad) assert.throws(() => parseItems(b), InputError, b.slice(0, 40));
});

test('subjects: fixtures first, then the seed (npm before PyPI), else a skip with a contract code', () => {
  const fixtures = loadFixtures(join(root, 'loop', 'fixtures.json'));
  const tt = resolveSubject('isokron-ai/mcp-write-safety', { seed: SEED, fixtures });
  assert.equal(tt.fixture, 'tiny-tracker');
  assert.deepEqual(tt.launch, { kind: 'npm', package: '@mcp-write-safety/tiny-tracker', version: '0.1.0', bin: 'tiny-tracker' });
  assert.deepEqual(resolveSubject('acme/npm-server', { seed: SEED, fixtures }).launch, { kind: 'npm', package: '@acme/server', version: 'latest' });
  assert.deepEqual(resolveSubject('ACME/py-server', { seed: SEED, fixtures }).launch, { kind: 'pypi', package: 'acme-mcp', version: 'latest' });
  assert.equal(resolveSubject('acme/oci-only', { seed: SEED, fixtures }).skip.reason, 'no_runnable_artifact');
  assert.match(resolveSubject('acme/oci-only', { seed: SEED, fixtures }).skip.detail, /cargo, oci/);
  assert.equal(resolveSubject('acme/http-only', { seed: SEED, fixtures }).skip.reason, 'unsupported_transport');
  assert.equal(resolveSubject('acme/bad-name', { seed: SEED, fixtures }).skip.reason, 'no_runnable_artifact');
  assert.equal(resolveSubject('acme/unknown', { seed: SEED, fixtures }).skip.reason, 'policy_excluded');
  assert.deepEqual(seedPackages({ packages: [{ registry: 'npm', identifier: 'ok' }, { registry: 'npm', identifier: 'NO' }] }), [{ kind: 'npm', package: 'ok' }]);
  // Every skip code is one of tool-qa's.
  const { SKIP_REASONS } = JSON.parse(JSON.stringify({ SKIP_REASONS: readFileSync(join(fx, 'tool-qa', 'worker-kit', 'contract.mjs'), 'utf8').match(/'[a-z_]+'/g).map((s) => s.slice(1, -1)) }));
  for (const c of ['no_runnable_artifact', 'unsupported_transport', 'policy_excluded', 'install_failed_registry', 'timeout_start', 'trace_unavailable', 'upstream_unavailable']) assert.ok(SKIP_REASONS.includes(c), c);
});

test('R-WC-03: fixtures: valid; each runs its dogfood manifest byte for byte, under the plan hash accepted there', () => {
  const f = loadFixtures(join(root, 'loop', 'fixtures.json'));
  assert.throws(() => validateFixtures({ format: 'x' }));
  assert.throws(() => validateFixtures({ format: 'isokron-writecheck-fixtures/1', fixtures: { a: { subject: 'a/b', launch: { kind: 'npm', package: 'x', version: 'latest' } } } }));
  const base = { subject: 'a/b', launch: { kind: 'npm', package: 'x', version: '1.0.0' }, manifest: 'dogfood/x/writecheck.yaml' };
  for (const link of ['/work/out/x', '/work/pkg', '/work/m/x', '/etc/x', '/work/../x', 'work/x']) {
    assert.throws(() => validateFixtures({ format: 'isokron-writecheck-fixtures/1', fixtures: { a: { ...base, link } } }), undefined, link);
  }
  for (const [name, dog] of [['tiny-tracker', 'dogfood/tiny-tracker/writecheck.yaml'], ['kronicle-lite', 'dogfood/kronicle-lite/writecheck.yaml']]) {
    const fx1 = f.fixtures[name];
    assert.equal(fx1.manifest, dog);
    // The manifest's relative cwd, taken from where the driver writes it, is the link to the installed package.
    const cwd = /^ {2}cwd: (\S+)/m.exec(readFileSync(join(root, dog), 'utf8'))[1];
    assert.equal(join(dirname(FIXTURE_MANIFEST), cwd), fx1.link, name);
    const wf = readFileSync(join(root, '.github', 'workflows', `dogfood-${name}.yml`), 'utf8');
    assert.ok(wf.includes(`PLAN_HASH: ${fx1.full.plan_hash}`), `${name}: the plan hash the dogfood workflow accepts`);
  }
});

test('the generic catalog manifest quotes every word and passes only the names it is given', () => {
  const m = catalogManifest(['node', '/work/pkg/a b/"x".js'], ['FORGERY_MARKER'], 'loop-i0');
  assert.match(m, /^ {2}stdio: \["node", "\/work\/pkg\/a b\/\\"x\\"\.js"\]$/m);
  assert.match(m, /^ {2}env_passthrough: \["FORGERY_MARKER"\]$/m);
  assert.match(m, /^ {2}confirm: "loop-i0"$/m);
});

const catalogDoc = {
  tools: [
    { name: 'create_item', description: 'secret text', inputSchema: { properties: { idempotency_key: {}, title: {}, expected_version: {}, dry_run: {}, 'bad name': {} } }, annotations: { destructiveHint: false, title: 'x', readOnlyHint: 'yes' } },
    { name: 'list_items', annotations: { readOnlyHint: true } },
    { name: 'bad name!', annotations: {} },
  ],
};
const resultsDoc = {
  run: { status: 'complete', writes: 12 },
  results: [
    { requirement: 'MWS-ANN-4', verdict: 'violated', write_path: { resource: '(catalog)', tool: 'list_items' }, reason: 'long text' },
    { requirement: 'MWS-ANN-4', verdict: 'held', write_path: { resource: '(catalog)', tool: 'create_item' } },
    { requirement: 'attempt_id=1', verdict: 'held' },
    { requirement: 'MWS-UPD-1', verdict: 'maybe' },
  ],
};
const filesOf = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))]));

test('summary: one results folder, whitelisted values only', () => {
  const files = filesOf({ 'results/catalog-0123456789/results.json': resultsDoc, 'results/catalog-0123456789/catalog.json': catalogDoc });
  assert.equal(findRunFolder(files, 'results', { catalog: true }).dir, 'results/catalog-0123456789');
  files.set('results/catalog-abcdefabcd/results.json', Buffer.from('{}'));
  assert.equal(findRunFolder(files, 'results', { catalog: true }).dir, null, 'two folders: none is trusted');
  assert.equal(findRunFolder(new Map(), 'results', { catalog: true }).why, 'no results folder');
  const r = readResults(resultsDoc);
  assert.equal(r.records.length, 2);
  assert.equal(r.dropped, 2);
  assert.equal(r.status, 'complete');
  const c = readCatalog(catalogDoc);
  assert.deepEqual(c.tools.map((t) => t.name), ['create_item', 'list_items']);
  assert.deepEqual(c.tools[0].annotations, { destructiveHint: false });
  assert.deepEqual(c.tools[0].params, ['idempotency_key', 'title', 'expected_version', 'dry_run']);
  assert.equal(planHash('x\nplan hash: 0123456789abcdef\n'), '0123456789abcdef');
  assert.equal(planHash('plan hash: 0123456789abcdef\nplan hash: fedcba9876543210\n'), null);
});

test('field records: registry ids with the declared types, and no object keyed by a target name', () => {
  const reg = parseRegistry(readFileSync(join(fx, 'mcp-results-registry.yaml'), 'utf8'));
  const files = filesOf({
    'results/catalog-0123456789/results.json': resultsDoc, 'results/catalog-0123456789/catalog.json': catalogDoc,
    'full/run-1/results.json': { run: { status: 'complete', writes: 40 }, results: [{ requirement: 'MWS-RETRY-2', verdict: 'held', write_path: { resource: 'ticket', tool: 'create_item' } }, { requirement: 'MWS-CONC-1', verdict: 'violated', write_path: { resource: 'ticket', tool: 'create_item' } }] },
  });
  const s = summarize({ files, steps: [{ step: 'plan', exit: 0, ms: 5 }], planStdout: 'plan hash: 0123456789abcdef\n', fullRan: true, acceptedPlanHash: '0123456789abcdef' });
  assert.equal(s.plan.drift, false);
  assert.equal(s.full.status, 'complete');
  const recs = observations(s, { versions: { mcp_writecheck: 'x' }, stagesRan: { install: true } });
  const fields = recs.map((x) => x.field);
  for (const f of ['tool_annotations_declared', 'annotation_completeness', 'idempotency_evidence_params', 'concurrency_guard_params', 'safety_params', 'requirement_verdicts', 'plan_hash_and_drift', 'annotation_honesty_behaviour_confirmed', 'idempotency_evidence_behaviour', 'conflict_behaviour', 'our_tool_versions', 'sandbox_tier', 'observation_coverage', 'step_telemetry']) assert.ok(fields.includes(f), f);
  const v = validateObservations(new Map([['observations/writecheck.ndjson', Buffer.from(ndjson(recs))]]), reg);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(recs.find((x) => x.field === 'idempotency_evidence_params').value, [{ tool: 'create_item', param: 'idempotency_key' }]);
  assert.deepEqual(recs.find((x) => x.field === 'concurrency_guard_params').value, [{ tool: 'create_item', param: 'expected_version' }]);
  assert.deepEqual(recs.find((x) => x.field === 'safety_params').value, [{ tool: 'create_item', param: 'dry_run' }]);
  // Incomplete sandbox evidence: only our own records.
  const few = observations(s, { versions: {}, stagesRan: {}, evidenceComplete: false }).map((x) => x.field);
  assert.deepEqual(few, ['our_tool_versions', 'sandbox_tier', 'observation_coverage', 'step_telemetry']);
  assert.ok(!('_records' in publicSummary(s)));
});

test('collected output: checked line by line; unsafe paths are renamed', () => {
  const lines = [
    JSON.stringify({ path: 'results/x/results.json', kind: 'file', bytes: 2, sha256: 'a'.repeat(64), b64: Buffer.from('{}').toString('base64'), truncated: false }),
    JSON.stringify({ path: '../etc/passwd', kind: 'file', bytes: 1, b64: 'YQ==' }),
    JSON.stringify({ path: 'big', kind: 'file', bytes: 10, sha256: 'b'.repeat(64), omitted: true }),
    JSON.stringify({ path: 'l', kind: 'link' }),
    'not json',
    JSON.stringify({ done: true, entries: 4, capped: true }),
  ].join('\n');
  const p = parseCollected(lines);
  assert.deepEqual([...p.files.keys()], ['results/x/results.json']);
  assert.equal(p.bad, 2);
  assert.equal(p.done.capped, true);
  assert.equal(safeRawPath('raw/out', 'results/x/results.json'), 'raw/out/results/x/results.json');
  assert.match(safeRawPath('raw/out', 'a b/c'), /^raw\/out\/_renamed\/[0-9a-f]{32}$/);
  assert.match(safeRawPath('raw/out', `${'a'.repeat(100)}/${'b'.repeat(100)}`), /_renamed/);
});

test('raw caps: a file and the bundle are cut, and the index keeps the original size and hash', () => {
  const b = new BundleFiles({ fileCap: 10, totalCap: 15 });
  b.raw('raw/a', Buffer.alloc(12, 1));
  b.raw('raw/b', Buffer.alloc(12, 2));
  b.raw('raw/c', Buffer.alloc(3, 3));
  assert.equal(b.files.get('raw/a').length, 10);
  assert.equal(b.files.get('raw/b').length, 5);
  assert.ok(!b.files.has('raw/c'));
  assert.deepEqual(b.rawIndex.map((x) => [x.path, x.bytes, x.kept, x.truncated]), [['raw/a', 12, 10, true], ['raw/b', 12, 5, true], ['raw/c', 3, 0, true]]);
});

test('the in-sandbox collector lists files, never follows links, and caps', () => {
  const d = mkdtempSync(join(tmpdir(), 'wc-collect-'));
  mkdirSync(join(d, 'a'));
  writeFileSync(join(d, 'a', 'x.txt'), 'hello');
  writeFileSync(join(d, 'big'), Buffer.alloc(100, 7));
  symlinkSync('/etc/hosts', join(d, 'link'));
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'collect.mjs'), d, '50', '60', '100'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const p = parseCollected(r.stdout);
  assert.equal(p.files.get('a/x.txt').toString(), 'hello');
  assert.equal(p.files.get('big').length, 50);
  assert.ok(p.entries.find((e) => e.path === 'big').truncated);
  assert.equal(p.entries.find((e) => e.path === 'link').kind, 'link');
});

test('the backend starter runs the main command after the background one is ready, with its exit status', () => {
  const d = mkdtempSync(join(tmpdir(), 'wc-bg-'));
  const spec = JSON.stringify({ argv: [process.execPath, '-e', 'console.log("backend ready"); setInterval(() => {}, 1000)'], log: join(d, 'bg.log'), ready: 'backend', wait_ms: 5000 });
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'bg.mjs'), spec, '--', process.execPath, '-e', 'process.exit(3)'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 3);
  assert.match(readFileSync(join(d, 'bg.log'), 'utf8'), /backend ready/);
});

/** What the forgery server answers to tools/list, as catalog.json would hold it, and what it prints on stderr. */
function forgeryCatalog(marker) {
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'forgery-server.mjs')], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`, env: { ...process.env, FORGERY_MARKER: marker }, encoding: 'utf8', timeout: 10_000,
  });
  return { tools: JSON.parse(r.stdout.trim().split('\n')[0]).result.tools, stderr: r.stderr };
}

test('forgery control: contained through our summary; a leak and an unread list are caught', () => {
  const marker = `wcforgery${'1'.repeat(32)}`;
  const { tools, stderr } = forgeryCatalog(marker);
  assert.ok(stderr.includes(marker));
  const files = filesOf({
    'results/catalog-0123456789/catalog.json': { tools }, 'results/catalog-0123456789/results.json': { run: { status: 'complete' }, results: [{ requirement: 'MWS-ANN-4', verdict: 'held', write_path: { resource: '(catalog)', tool: 'fence' }, reason: marker }] },
    'results/forged/results.json': { attempt_id: 'forged', run_key: '0f'.repeat(32), marker },
  });
  const s = summarize({ files, steps: [], planStdout: '' });
  const output = { summary: publicSummary(s), observations: observations(s, { versions: {}, stagesRan: {} }) };
  const rawTexts = [...files.values()].map((b) => b.toString());
  assert.equal(forgeryVerdict({ marker, output, rawTexts, toolCount: s.catalog.tool_count }), 'contained');
  assert.equal(forgeryVerdict({ marker, output: { ...output, x: marker }, rawTexts, toolCount: 2 }), 'leaked');
  assert.equal(forgeryVerdict({ marker, output: { ...output, n: { run_key: 'x' } }, rawTexts, toolCount: 2 }), 'leaked');
  assert.equal(forgeryVerdict({ marker, output, rawTexts: [], toolCount: 2 }), 'not_read');
  assert.equal(forgeryVerdict({ marker, output, rawTexts, toolCount: 1 }), 'not_read');
  assert.ok(hasIdentityKeys({ a: [{ 'Run-Key': 1 }] }));
  assert.ok(hasIdentityKeys({ schema_version: 1, files: [] }));
  assert.ok(!hasIdentityKeys({ tools: [{ tool: 'attempt_id' }] }));
});

test('known-answer controls: detected and held, and their failures', () => {
  const s = (recs, found = true) => ({ catalog: { found }, _records: { catalog: recs } });
  const v = (verdict) => ({ requirement: 'MWS-ANN-4', verdict });
  assert.equal(knownBadVerdict(s([v('violated'), v('held')]), 'MWS-ANN-4'), 'detected');
  assert.equal(knownBadVerdict(s([v('held')]), 'MWS-ANN-4'), 'missed');
  assert.equal(knownBadVerdict(s([], false), 'MWS-ANN-4'), 'not_run');
  assert.equal(knownGoodVerdict(s([v('held')]), 'MWS-ANN-4'), 'held');
  assert.equal(knownGoodVerdict(s([v('held'), v('violated')]), 'MWS-ANN-4'), 'violated');
  assert.equal(knownGoodVerdict(s([]), 'MWS-ANN-4'), 'not_observed');
});

test('a bundle built from our functions passes tool-qa\'s manifest, forgery and registry checks', () => {
  const marker = `wcforgery${'2'.repeat(32)}`;
  const { tools } = forgeryCatalog(marker);
  const ctlFiles = filesOf({ 'results/catalog-0123456789/catalog.json': { tools }, 'results/catalog-0123456789/results.json': { run: { status: 'complete' }, results: [] } });
  const cs = summarize({ files: ctlFiles, steps: [], planStdout: '' });
  const ctlOut = { summary: publicSummary(cs), observations: observations(cs, { versions: {}, stagesRan: {} }) };
  const b = new BundleFiles();
  const subj = summarize({ files: filesOf({ 'results/catalog-0123456789/results.json': resultsDoc, 'results/catalog-0123456789/catalog.json': catalogDoc }), steps: [{ step: 'catalog', exit: 0, ms: 1 }], planStdout: '' });
  b.put('results/writecheck.json', JSON.stringify(publicSummary(subj)));
  b.put('observations/writecheck.ndjson', ndjson(observations(subj, { versions: { mcp_writecheck: 'c' }, stagesRan: { catalog: true } })));
  b.put('controls/forgery.json', JSON.stringify(ctlOut));
  b.put('controls/known-bad.json', '{"observed":"detected"}');
  b.put('logs/driver.json', '{"index":0}');
  b.raw('raw/control-forgery/out/results/catalog-0123456789/catalog.json', ctlFiles.get('results/catalog-0123456789/catalog.json'));
  b.raw('raw/control-forgery/out/forged-envelope.json', JSON.stringify({ attempt_id: 'forged', run_key: '0f'.repeat(32), fence: 9, marker }));
  const files = [...b.files.entries()].map(([path, data]) => ({ path, data }));
  const meta = buildMeta({
    subject: 'acme/npm-server', tools: [{ name: 'mcp-writecheck', version: 'c'.repeat(40) }], settingsDigest: 'd'.repeat(64), startedAt: '2026-11-23T00:00:00Z', finishedAt: '2026-11-23T00:01:00Z',
    skips: [{ stage: 'full', reason: 'policy_excluded', evidence: 'logs/driver.json' }],
    controls: [{ kind: 'forgery', expected: 'contained', observed: 'contained', output: 'controls/forgery.json', marker }, { kind: 'known_bad', expected: 'detected', observed: 'detected', output: 'controls/known-bad.json' }],
  });
  const workflow = { repo: 'isokron-ai/mcp-writecheck-action', file: '.github/workflows/corpus.yml', sha: 'e'.repeat(40), run_id: 5, run_attempt: 1 };
  const manifest = buildManifest({ identity: { attempt_id: 'att-1', fence: 3, run_key: KEY }, workflow, meta, files });
  assert.ok(validateManifest(manifest).ok);
  const exp = { attempt_id: 'att-1', fence: 3, run_key: KEY, repo: workflow.repo, workflow_file: workflow.file, workflow_sha: workflow.sha, run_id: 5, run_attempt: 1 };
  assert.deepEqual(checkBundle(manifest, b.files, exp), []);
  const reg = parseRegistry(readFileSync(join(fx, 'mcp-results-registry.yaml'), 'utf8'));
  assert.deepEqual(validateObservations(b.files, reg).errors, []);
  // A leak of the marker outside raw/ is what ingest rejects.
  const leaked = new Map(b.files);
  leaked.set('logs/driver.json', Buffer.from(`{"m":"${marker}"}`));
  const m2 = buildManifest({ identity: { attempt_id: 'att-1', fence: 3, run_key: KEY }, workflow, meta, files: [...leaked.entries()].map(([path, data]) => ({ path, data })) });
  assert.ok(checkBundle(m2, leaked, exp).some((p) => p.reason === 'forgery_marker_leaked'));
});

test('kill switch: LOOP_ENABLED exactly true, pause, lane switch, pins', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.deepEqual(evaluateGuard({}, { now }), { proceed: false, reason: 'loop_disabled' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'TRUE' }, { now }), { proceed: false, reason: 'loop_disabled' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-24' }, { now }), { proceed: false, reason: 'paused' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: 'soon' }, { now }), { proceed: false, reason: 'pause_unreadable' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-22' }, { now }), { proceed: true, reason: 'enabled' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LANE_WRITECHECK_ENABLED: 'false' }, { now }), { proceed: false, reason: 'lane_disabled' });
  assert.equal(laneVariable('writecheck'), 'LANE_WRITECHECK_ENABLED');
  assert.match(refProblem('SANDBOX_REF', '0'.repeat(40), 'x'), /placeholder/);
  const out = { text: '', write(s) { this.text += s; } };
  assert.equal(guardMain([], { LOOP_ENABLED: 'true', WORKER_KIT_REF: 'b'.repeat(40), SANDBOX_REF: 'short' }, { out, now }), 1);
  assert.equal(guardMain([], { LOOP_ENABLED: 'true', WORKER_KIT_REF: 'b'.repeat(40), SANDBOX_REF: 'c'.repeat(40) }, { out, now }), 0);
  assert.equal(guardMain([], { LOOP_ENABLED: 'no' }, { out, now }), 0);
});

test('R-WC-01: the tools volume carries what its code imports (the network logger needs src/)', async () => {
  const { MSC_TOOL_DIRS, missingImports } = await import('../loop/run-items.mjs');
  assert.deepEqual(MSC_TOOL_DIRS, ['sandbox', 'src']);
  const d = mkdtempSync(join(tmpdir(), 'wc-tools-'));
  mkdirSync(join(d, 'sandbox'));
  writeFileSync(join(d, 'sandbox', 'netlog.mjs'), "import { a } from '../src/dns.mjs';\nexport { b } from './x.mjs';\nconst c = await import('./y.mjs');\nimport fs from 'node:fs';\n");
  writeFileSync(join(d, 'sandbox', 'x.mjs'), 'export const b = 1;\n');
  assert.deepEqual(missingImports(d), ['sandbox/netlog.mjs -> ../src/dns.mjs', 'sandbox/netlog.mjs -> ./y.mjs']);
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'dns.mjs'), 'export const a = 1;\n');
  writeFileSync(join(d, 'sandbox', 'y.mjs'), 'export {};\n');
  assert.deepEqual(missingImports(d), []);
  // Our own in-sandbox code imports nothing outside loop/sandbox.
  assert.deepEqual(missingImports(join(root, 'loop', 'sandbox')), []);
});

test('R-WC-02: every name the driver takes from mcp-surface-corpus is in the list it checks at load', async () => {
  const { MSC_MODULES, MSC_NEEDS } = await import('../loop/run-items.mjs');
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  const used = [...new Set([...src.matchAll(/\b(?:this\.M|M)\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].filter((n) => !['dir', 'images'].includes(n)).sort();
  assert.deepEqual(used, [...MSC_NEEDS].sort());
  assert.ok(MSC_MODULES.includes('src/sandbox-env.mjs'), 'settingsManifest and settingsDigest live in sandbox-env.mjs');
  // With a checkout of mcp-surface-corpus at hand (MSC_DIR), check the names against its exports too.
  if (process.env.MSC_DIR) {
    const { pathToFileURL } = await import('node:url');
    const M = Object.assign({}, ...(await Promise.all(MSC_MODULES.map((p) => import(pathToFileURL(join(process.env.MSC_DIR, p)).href)))));
    assert.deepEqual(MSC_NEEDS.filter((n) => M[n] === undefined), []);
  }
});

test('R-WC-04: the collector brings the files the summary reads first, ahead of thousands of capture files', () => {
  const d = mkdtempSync(join(tmpdir(), 'wc-collect-order-'));
  mkdirSync(join(d, 'full', 'r1', 'capture'), { recursive: true });
  mkdirSync(join(d, 'results', 'catalog-0123456789'), { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(d, 'full', 'r1', 'capture', `f${i}`), 'x');
  writeFileSync(join(d, 'full', 'r1', 'results.json'), '{}');
  writeFileSync(join(d, 'results', 'catalog-0123456789', 'results.json'), '{}');
  writeFileSync(join(d, 'results', 'catalog-0123456789', 'catalog.json'), '{}');
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'collect.mjs'), d, '100', '1000', '10'], { encoding: 'utf8' });
  const p = parseCollected(r.stdout);
  for (const f of ['full/r1/results.json', 'results/catalog-0123456789/results.json', 'results/catalog-0123456789/catalog.json']) assert.ok(p.files.has(f), f);
  assert.equal(p.entries.length, 10);
  assert.equal(p.done.capped, true);
});
