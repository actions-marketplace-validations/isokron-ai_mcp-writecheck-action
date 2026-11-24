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
import { readFileSync } from 'node:fs';
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
    for (const k of Object.keys(it)) if (!['subject', 'run_key', 'fence'].includes(k)) throw new InputError(`items[${index}] has an unknown key`);
    if (typeof it.subject !== 'string' || !SUBJECT_RE.test(it.subject)) throw new InputError(`items[${index}].subject must be owner/name`);
    if (typeof it.run_key !== 'string' || !RUN_KEY_RE.test(it.run_key)) throw new InputError(`items[${index}].run_key must be 64 lower-case hex characters`);
    if (!Number.isSafeInteger(it.fence) || it.fence < 1) throw new InputError(`items[${index}].fence must be a whole number from 1`);
    const key = it.subject.toLowerCase();
    if (seen.has(key)) throw new InputError(`items[${index}].subject appears twice`);
    seen.add(key);
    return { index, subject: it.subject, run_key: it.run_key, fence: it.fence };
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
    const p = lockProblems(f, JSON.parse(readFileSync(join(root, f.lock, 'package-lock.json'), 'utf8')));
    if (p.length) throw new Error(`fixtures.${name}: ${p.join('; ')}`);
  }
  return { ...doc, sha256: createHash('sha256').update(buf).digest('hex') };
}

/**
 * A fixture's lockfile (R-WC-07): it pins the package at the fixture's version with the integrity in fixtures.json,
 * and every package in it comes from registry.npmjs.org with an integrity hash. Returns the problems, or [].
 */
export function lockProblems(f, lock) {
  const out = [];
  const pk = lock?.packages ?? {};
  const own = pk[`node_modules/${f.launch.package}`];
  if (!own) out.push('the lockfile does not install the package');
  else {
    if (own.version !== f.launch.version) out.push(`the lockfile has version ${own.version}, not ${f.launch.version}`);
    if (own.integrity !== f.integrity) out.push('the lockfile\'s integrity for the package is not the one pinned in fixtures.json');
  }
  if (pk['']?.dependencies?.[f.launch.package] !== f.launch.version) out.push('the lockfile\'s root does not depend on the exact version');
  for (const [k, v] of Object.entries(pk)) {
    if (!k) continue;
    if (!/^sha512-/.test(v.integrity ?? '') || !String(v.resolved ?? '').startsWith('https://registry.npmjs.org/')) out.push(`${k} is not pinned to registry.npmjs.org with a sha512 integrity`);
  }
  return out;
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
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(f.integrity ?? '')) throw new Error(`fixtures.${name}.integrity must be the package's sha512 integrity`);
    for (const h of f.install_hosts ?? []) if (!/^[a-z0-9.-]{1,100}$/.test(h)) throw new Error(`fixtures.${name}.install_hosts: bad host ${h}`);
    if (f.full !== undefined) {
      if (!f.manifest) throw new Error(`fixtures.${name}.full needs a manifest`);
      if (!(f.full.plan_hash === null || HEX16.test(f.full.plan_hash ?? ''))) throw new Error(`fixtures.${name}.full.plan_hash must be 16 hex characters or null`);
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
export function resolveSubject(subject, { seed, fixtures }) {
  for (const [name, f] of Object.entries(fixtures?.fixtures ?? {})) {
    if (f.subject.toLowerCase() === subject.toLowerCase()) {
      return { fixture: name, launch: { ...f.launch }, source: 'fixture', package: `npm:${f.launch.package}@${f.launch.version}` };
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
