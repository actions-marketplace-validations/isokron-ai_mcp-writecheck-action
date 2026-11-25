// The writecheck loop worker's inputs: the pump's `items` (tool-qa docs/INTERFACES.md, "Worker dispatch"), and how
// each item's subject maps to something this lane can install and run.
//
// A subject is a public GitHub repository, owner/name, as tool-qa's seed names it (history/seed-v1.json). The
// mapping is the live-probe lane's: the seed's registry packages, npm first, then PyPI; the latest version is
// installed (the record keeps the version that was resolved). IsoKron's own fixture servers (loop/fixtures.json)
// come first: they name an exact version and, where a person accepted its plan hash, a full write test against a
// disposable backend inside the sandbox. A subject with no npm or PyPI package (OCI images, MCPB bundles, crates,
// NuGet) or whose packages are remote-only gets a skip with a code from tool-qa's SKIP_REASONS.
//
// Only Node's standard library: the workflow's input check imports this file before anything else is installed.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The pump's shard size for this lane (tool-qa pump/workflows.json, writecheck). */
export const MAX_ITEMS = 10;
export const MAX_ITEMS_CHARS = 60_000;

const SUBJECT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const RUN_KEY_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,80}\/)?[a-z0-9][a-z0-9._~-]{0,120}$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,120}[A-Za-z0-9])?$/;

export class InputError extends Error {}

/** A shard or attempt id as the pump sends it: refused unless it is one whole line of the id characters. */
export function checkId(what, v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new InputError(`${what} is malformed`);
  return v;
}

/**
 * The dispatched items: a JSON list of 1 to MAX_ITEMS { subject, run_key, fence }, each subject once. Returns
 * [{ index, subject, run_key, fence }] in dispatch order (index names the result artifact).
 */
export function parseItems(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_ITEMS_CHARS || /[\u0000-\u001f]/.test(text)) {
    throw new InputError(`items must be one line of JSON of at most ${MAX_ITEMS_CHARS} characters`);
  }
  let list;
  try { list = JSON.parse(text); } catch { throw new InputError('items is not JSON'); }
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) throw new InputError(`items must be a list of 1 to ${MAX_ITEMS} entries`);
  const seen = new Set();
  return list.map((it, index) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new InputError(`items[${index}] must be an object`);
    for (const k of Object.keys(it)) if (!['subject', 'run_key', 'fence', 'fixture', 'proof_plan'].includes(k)) throw new InputError(`items[${index}] has an unknown key`);
    if (typeof it.subject !== 'string' || !SUBJECT_RE.test(it.subject)) throw new InputError(`items[${index}].subject must be owner/name`);
    if (typeof it.run_key !== 'string' || !RUN_KEY_RE.test(it.run_key)) throw new InputError(`items[${index}].run_key must be 64 lower-case hex characters`);
    if (!Number.isSafeInteger(it.fence) || it.fence < 1) throw new InputError(`items[${index}].fence must be a whole number from 1`);
    if (it.fixture !== undefined && (typeof it.fixture !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(it.fixture))) throw new InputError(`items[${index}].fixture must be a fixture id`);
    if (it.proof_plan !== undefined && (it.proof_plan !== true || it.fixture === undefined)) throw new InputError(`items[${index}].proof_plan is true, and only on an item that names a fixture`);
    // A subject appears once, except that a source fixture is its own item: two fixtures of one repository may share its name.
    const key = `${it.subject.toLowerCase()}\u0000${it.fixture ?? ''}`;
    if (seen.has(key)) throw new InputError(`items[${index}].subject appears twice`);
    seen.add(key);
    return { index, subject: it.subject, run_key: it.run_key, fence: it.fence, ...(it.fixture !== undefined ? { fixture: it.fixture } : {}), ...(it.proof_plan === true ? { proof_plan: true } : {}) };
  });
}

/** tool-qa's seed (history/seed-v1.json) as a Map of lower-cased subject id to its entry, plus the file's sha256. */
export function loadSeed(file) {
  const buf = readFileSync(file);
  const doc = JSON.parse(buf.toString('utf8'));
  if (!doc || !Array.isArray(doc.subjects)) throw new Error('the seed has no subjects list');
  const map = new Map();
  for (const s of doc.subjects) if (s && typeof s.id === 'string') map.set(s.id.toLowerCase(), s);
  return { map, sha256: createHash('sha256').update(buf).digest('hex'), version: doc.version ?? null };
}

const FIXTURE_FORMAT = 'isokron-writecheck-fixtures/1';
const HEX16 = /^[0-9a-f]{16}$/;
const FIXTURE_KEYS = ['subject', 'launch', 'lock', 'integrity', 'source', 'backend', 'manifest', 'link', 'init', 'env', 'random_env', 'background', 'setup', 'full', 'known_answer', 'known_answers', 'binary_image'];
/** What every write-test result of a fixture is labelled with: its backend lives and dies inside the sandbox container (WC12). */
export const BACKEND_HERMETIC = 'hermetic';
/** Where a fixture's manifest is written (two levels below /work, so a dogfood manifest's ../../<dir> cwd lands in /work). */
export const FIXTURE_MANIFEST = '/work/m/x/writecheck.yaml';
const LINK_RE = /^\/work\/(?!(?:out|pkg|home|lock|venv|bin|m)(?:\/|$))[a-z0-9_-]{1,40}(?:\/[a-z0-9_-]{1,40}){0,4}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** loop/fixtures.json, checked, with each fixture's lockfile checked against it (lockProblems). */
export function loadFixtures(file) {
  const buf = readFileSync(file);
  const doc = validateFixtures(JSON.parse(buf.toString('utf8')));
  const root = join(dirname(file), '..');
  for (const [name, f] of Object.entries(doc.fixtures)) {
    const p = lockProblems(f, JSON.parse(readFileSync(join(root, f.lock, 'package-lock.json'), 'utf8')), name);
    if (p.length) throw new Error(`fixtures.${name}: ${p.join('; ')}`);
    if (f.source) {
      const got = sourceDigest(join(root, f.source.dir));
      if (got !== f.source.sha256) throw new Error(`fixtures.${name}: the committed source of ${f.source.dir} has digest ${got}, not the ${f.source.sha256} pinned in fixtures.json (a reviewed change moves both)`);
    }
  }
  return { ...doc, sha256: createHash('sha256').update(buf).digest('hex') };
}

/**
 * The digest of a source fixture's committed folder: package.json, package-lock.json and every file under src/, by
 * relative path and content sha256, in path order (WC12). node_modules and anything else in the folder is not part of it.
 */
export function sourceDigest(dir) {
  const files = ['package.json', 'package-lock.json'];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(join(dir, p)).size <= 1024 * 1024) files.push(p);
    }
  };
  walk('src');
  const h = createHash('sha256');
  for (const p of files) h.update(`${p}\0${createHash('sha256').update(readFileSync(join(dir, p))).digest('hex')}\n`);
  return h.digest('hex');
}

/**
 * A fixture's lockfile (R-WC-07): it pins the package at the fixture's version with the integrity in fixtures.json,
 * and every package in it comes from registry.npmjs.org with an integrity hash. Returns the problems, or [].
 */
/**
 * The packages a fixture's lockfile may let run an install script (WC12), by lock path. A script of any other package
 * is a problem: it would run at install, next to the build image's tools, with only the registry reachable. For
 * pg-tracker: the optional platform packages of embedded-postgres (they link the PostgreSQL libraries; on a Linux
 * runner only linux-x64 is installed, the others are skipped by their `os`/`cpu`). For kronicle-lite: better-sqlite3's build.
 */
export const INSTALL_SCRIPT_ALLOW = Object.freeze({
  'pg-tracker': /^node_modules\/@embedded-postgres\/(?:linux|darwin|windows)-[a-z0-9]+$/,
  'redis-tracker': /^$/, // no dependency at all: its Redis client is src/resp.mjs
  'kronicle-lite': /^node_modules\/better-sqlite3$/,
  'tiny-tracker': /^$/,
});

export function lockProblems(f, lock, name = null) {
  const out = [];
  const pk = lock?.packages ?? {};
  const allow = INSTALL_SCRIPT_ALLOW[name] ?? /^$/; // a fixture not on the list may run no install script
  for (const [k, v] of Object.entries(pk)) if (k && v.hasInstallScript === true && !allow.test(k)) out.push(`${k} has an install script and is not on the list of packages that may run one`);
  for (const [k, v] of Object.entries(pk)) if (k && v.hasInstallScript === true && allow.test(k) && k.includes('@embedded-postgres/') && !(v.optional === true && Array.isArray(v.os))) out.push(`${k} must be optional with an os restriction`);
  if (f.source) {
    // A fixture whose package is the committed folder (WC12): the lockfile's root is that package, and every
    // dependency it locks is pinned below. The folder's own bytes are pinned by source.sha256.
    if (pk['']?.name !== f.launch.package || pk['']?.version !== f.launch.version) out.push('the lockfile\'s root is not the fixture package at its version');
    for (const [dep, v] of Object.entries(pk['']?.dependencies ?? {})) if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) out.push(`the root depends on ${dep} at ${v}, not an exact version`);
  } else {
    const own = pk[`node_modules/${f.launch.package}`];
    if (!own) out.push('the lockfile does not install the package');
    else {
      if (own.version !== f.launch.version) out.push(`the lockfile has version ${own.version}, not ${f.launch.version}`);
      if (own.integrity !== f.integrity) out.push('the lockfile\'s integrity for the package is not the one pinned in fixtures.json');
    }
    if (pk['']?.dependencies?.[f.launch.package] !== f.launch.version) out.push('the lockfile\'s root does not depend on the exact version');
  }
  for (const [k, v] of Object.entries(pk)) {
    if (!k) continue;
    if (!/^sha512-/.test(v.integrity ?? '') || !String(v.resolved ?? '').startsWith('https://registry.npmjs.org/')) out.push(`${k} is not pinned to registry.npmjs.org with a sha512 integrity`);
  }
  return out;
}

/**
 * A fixture whose backend is an executable of an official image (WC13, redis-tracker): the image by tag and digest of its
 * index, and per platform the files to copy out of it with their sha256. Nothing is fetched from the image at run time but
 * these files (loop/binary-image.mjs), and the sandbox never runs the image.
 */
export const BINARY_PLATFORMS = ['linux/amd64', 'linux/arm64'];
const IMAGE_REF = /^docker\.io\/library\/[a-z0-9][a-z0-9._-]{0,40}:[A-Za-z0-9._-]{1,60}@sha256:[0-9a-f]{64}$/;
function checkBinaryImage(name, b) {
  const bad = (m) => { throw new Error(`fixtures.${name}.binary_image ${m}`); };
  if (!b || typeof b !== 'object' || Object.keys(b).some((k) => !['ref', 'mount', 'files'].includes(k))) bad('is { ref, mount, files }');
  if (!IMAGE_REF.test(b.ref ?? '')) bad('.ref must be an official docker.io/library image by tag and digest');
  if (!/^\/opt\/[a-z0-9-]{1,32}$/.test(b.mount ?? '') || b.mount === '/opt/surface') bad('.mount must be a folder of /opt other than the tools\'');
  const names = (p) => Object.keys(b.files?.[p] ?? {}).sort().join(',');
  if (Object.keys(b.files ?? {}).sort().join(',') !== BINARY_PLATFORMS.join(',')) bad(`.files must name exactly ${BINARY_PLATFORMS.join(' and ')}`);
  if (!names(BINARY_PLATFORMS[0]) || names(BINARY_PLATFORMS[0]) !== names(BINARY_PLATFORMS[1])) bad('.files must name the same files on both platforms');
  for (const p of BINARY_PLATFORMS) {
    for (const [file, v] of Object.entries(b.files[p])) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file) || !/^\/(?:[A-Za-z0-9._-]{1,40}\/){1,6}[A-Za-z0-9._-]{1,64}$/.test(v?.path ?? '') || !/^[0-9a-f]{64}$/.test(v?.sha256 ?? '')) bad(`.files[${p}].${String(file).slice(0, 40)} must be { path, sha256 }`);
    }
  }
}

export function validateFixtures(doc) {
  if (!doc || doc.format !== FIXTURE_FORMAT) throw new Error(`fixtures: format must be ${FIXTURE_FORMAT}`);
  const fixtures = {};
  for (const [name, f] of Object.entries(doc.fixtures ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`fixtures: bad name ${name}`);
    if (!f || typeof f !== 'object') throw new Error(`fixtures.${name} must be an object`);
    if (typeof f.subject !== 'string' || !SUBJECT_RE.test(f.subject)) throw new Error(`fixtures.${name}.subject must be owner/name`);
    const l = f.launch;
    if (!l || l.kind !== 'npm' || !NPM_NAME.test(l.package ?? '') || !/^\d+\.\d+\.\d+$/.test(l.version ?? '')) throw new Error(`fixtures.${name}.launch must be an npm package at an exact version`);
    if (f.manifest !== undefined && !/^dogfood\/[a-z0-9-]{1,40}\/writecheck\.yaml$/.test(f.manifest)) throw new Error(`fixtures.${name}.manifest must name a dogfood manifest (dogfood/<name>/writecheck.yaml)`);
    if (f.manifest !== undefined && !LINK_RE.test(f.link ?? '')) throw new Error(`fixtures.${name}.link must be a path under /work outside the driver's own folders`);
    for (const k of Object.keys(f.env ?? {})) if (!ENV_NAME.test(k)) throw new Error(`fixtures.${name}.env: bad name ${k}`);
    for (const k of f.random_env ?? []) if (!ENV_NAME.test(k)) throw new Error(`fixtures.${name}.random_env: bad name ${k}`);
    if (!/^loop\/fixtures\/[a-z0-9-]{1,40}$/.test(f.lock ?? '')) throw new Error(`fixtures.${name}.lock must name a folder in loop/fixtures/ with package.json and package-lock.json`);
    if (f.source === undefined) {
      if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(f.integrity ?? '')) throw new Error(`fixtures.${name}.integrity must be the package's sha512 integrity`);
    } else {
      if (f.integrity !== undefined) throw new Error(`fixtures.${name}: a fixture with a source has no integrity (its folder is pinned by source.sha256)`);
      if (!/^loop\/fixtures\/[a-z0-9-]{1,40}$/.test(f.source.dir ?? '') || f.source.dir !== f.lock) throw new Error(`fixtures.${name}.source.dir must be the lock folder`);
      if (!/^[0-9a-f]{64}$/.test(f.source.sha256 ?? '')) throw new Error(`fixtures.${name}.source.sha256 must be 64 hex characters`);
      if (!/^src\/[a-z0-9-]{1,40}\.mjs$/.test(f.source.bin ?? '')) throw new Error(`fixtures.${name}.source.bin must be a src/<name>.mjs file`);
    }
    // WC12: every fixture says what its backend is, and that it is hermetic: it starts with the container and ends with it.
    if (!f.backend || !/^[a-z][a-z0-9_]{0,23}$/.test(f.backend.kind ?? '') || f.backend.environment !== BACKEND_HERMETIC || !/^[0-9A-Za-z._ ()-]{1,80}$/.test(f.backend.version ?? '')) throw new Error(`fixtures.${name}.backend must be { kind, environment: "${BACKEND_HERMETIC}", version }`);
    for (const ka of f.known_answers ?? []) if (!ENV_NAME.test(ka?.env ?? '') || !/^[a-z][a-z0-9-]{1,48}$/.test(ka?.defect ?? '') || !/^MWS-[A-Z]{2,6}-[0-9]{1,2}$/.test(ka?.requirement ?? '') || !['catalog', 'full'].includes(ka?.mode)) throw new Error(`fixtures.${name}.known_answers: each is { env, defect, requirement, mode: catalog|full }`);
    if (f.background?.only !== undefined && !(Array.isArray(f.background.only) && f.background.only.every((c) => ['plan', 'catalog', 'run'].includes(c)))) throw new Error(`fixtures.${name}.background.only must list plan, catalog or run`);
    if (f.binary_image !== undefined) checkBinaryImage(name, f.binary_image);
    // R-WC-09: no fixture widens the install's allowlist; a native module builds from source (registry.npmjs.org only).
    for (const k of Object.keys(f)) if (!FIXTURE_KEYS.includes(k)) throw new Error(`fixtures.${name}: unknown field ${k}`);
    if (f.full !== undefined) {
      if (!f.manifest) throw new Error(`fixtures.${name}.full needs a manifest`);
      if (!(f.full.plan_hash === null || HEX16.test(f.full.plan_hash ?? ''))) throw new Error(`fixtures.${name}.full.plan_hash must be 16 hex characters or null`);
      // A plan nobody has accepted yet: kept so that the pull-request proof can run it (an item with proof_plan), never the live lane.
      if (f.full.proposed_plan_hash !== undefined && (f.full.plan_hash !== null || !HEX16.test(f.full.proposed_plan_hash))) throw new Error(`fixtures.${name}.full.proposed_plan_hash is 16 hex characters, and only while plan_hash is null`);
      if (!/^[a-z0-9-]{1,64}$/.test(f.full.confirm ?? '')) throw new Error(`fixtures.${name}.full.confirm must be a short name`);
    }
    fixtures[name] = f;
  }
  return { format: doc.format, fixtures };
}

/** The registry packages of a seed entry, npm first, then PyPI, each name checked. */
export function seedPackages(entry) {
  const out = [];
  for (const kind of ['npm', 'pypi']) {
    for (const p of entry?.packages ?? []) {
      if (p?.registry !== kind || typeof p.identifier !== 'string') continue;
      if (kind === 'npm' && NPM_NAME.test(p.identifier)) out.push({ kind, package: p.identifier });
      if (kind === 'pypi' && PYPI_NAME.test(p.identifier)) out.push({ kind, package: p.identifier });
    }
  }
  return out;
}

/**
 * What to do with one subject: { fixture, launch, source, package } or { skip: { stage, reason, detail } }.
 * `launch` is mcp-surface-corpus's launch block (src/targets.mjs validateLaunch), stdio transport.
 */
export function resolveSubject(subject, { seed, fixtures }, fixtureId = null) {
  // A source fixture (WC12) is selected by its id, named in the item, and by nothing else: a subject that happens to be
  // its subject (this repository, if the seed ever lists it) is an ordinary subject and never gets the full write test.
  if (fixtureId !== null) {
    const f = fixtures?.fixtures?.[fixtureId];
    if (!f || f.subject.toLowerCase() !== subject.toLowerCase()) return { skip: { stage: 'install', reason: 'policy_excluded', detail: 'the item names a fixture that does not exist or is for another subject' } };
    return { fixture: fixtureId, launch: { ...f.launch }, source: 'fixture', package: f.source ? `local:${f.launch.package}@${f.launch.version}` : `npm:${f.launch.package}@${f.launch.version}` };
  }
  for (const [name, f] of Object.entries(fixtures?.fixtures ?? {})) {
    if (f.source) continue;
    if (f.subject.toLowerCase() === subject.toLowerCase()) {
      return { fixture: name, launch: { ...f.launch }, source: 'fixture', package: f.source ? `local:${f.launch.package}@${f.launch.version}` : `npm:${f.launch.package}@${f.launch.version}` };
    }
  }
  const entry = seed?.map.get(subject.toLowerCase());
  if (!entry) return { skip: { stage: 'install', reason: 'policy_excluded', detail: 'the subject is not in the seed this lane reads, so no package is known for it' } };
  const pkgs = seedPackages(entry);
  if (pkgs.length === 0) {
    const kinds = [...new Set((entry.packages ?? []).map((p) => String(p?.registry ?? '')).filter((k) => /^[a-z]{1,12}$/.test(k)))].sort();
    return { skip: { stage: 'install', reason: 'no_runnable_artifact', detail: `no npm or PyPI package (this lane installs those only)${kinds.length ? `; the seed lists ${kinds.join(', ')}` : ''}` } };
  }
  if (entry.transport === 'http') {
    return { skip: { stage: 'install', reason: 'unsupported_transport', detail: 'the registry lists streamable HTTP only; this lane starts stdio servers' } };
  }
  const p = pkgs[0];
  return { fixture: null, launch: { kind: p.kind, package: p.package, version: 'latest' }, source: 'seed', package: `${p.kind}:${p.package}` };
}

/** A YAML double-quoted string (JSON's escapes are a subset of YAML's). */
const q = (s) => JSON.stringify(String(s));

/**
 * The generic catalog manifest for a subject without a fixture: the server block and a stub resource. Catalog
 * mode reads tools/list and calls no tool; plan calls none either. (The same manifest as corpus/run-shard.mjs.)
 */
export function catalogManifest(command, envNames, confirm) {
  return [
    '# Generated by loop/run-items.mjs: init, plan and catalog only. The stub resource is never called;',
    '# catalog mode reads tools/list and calls no tool. A full run needs a hand-written manifest.',
    'mws: "0.9"',
    'server:',
    `  stdio: [${command.map(q).join(', ')}]`,
    `  env_passthrough: [${envNames.map(q).join(', ')}]`,
    '  processes: separate',
    'target:',
    '  environment: test',
    `  confirm: ${q(confirm)}`,
    'resources:',
    '  - name: catalogstub',
    '    read: { tool: mwsc_catalog_stub, args: { id: "{{id}}" } }',
    '    fixture: { id: mwsc-catalog-stub, name: mwsc-catalog-stub }',
    '    cleanup: leave',
    '',
  ].join('\n');
}
