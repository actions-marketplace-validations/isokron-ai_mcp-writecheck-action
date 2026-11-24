// What the writecheck loop worker keeps outside raw/: a summary of the CLI's own outputs and the field records,
// built only from fields it checks one by one. Everything the CLI wrote ran next to the server under test, in
// the same sandbox container and as the same user, so all of it is target-influenced: it is kept byte for byte in
// raw/ (data only), and only these whitelisted, type-checked values leave it:
//
//   requirement ids (MWS-XXX-n), verdicts (the CLI's fixed words), tool, resource and parameter names (letters,
//   digits, . _ - only, at most 128 characters), the four annotation hints (booleans), counts, the CLI's plan hash
//   (16 hex) and run status (a fixed word).
//
// No description, title, schema text, report text or log line of the target is ever copied, and no object is keyed
// by a name the target chose (an object key such as "attempt_id" would read as an identity claim to tool-qa's
// ingest). That is what the forgery control checks.
import { createHash } from 'node:crypto';

export const SUMMARY_FORMAT = 'isokron-writecheck-loop/1';
export const VERDICTS = Object.freeze(['held', 'violated', 'not tested', 'not applicable', 'not observed', 'self-attested']);
const REQUIREMENT_RE = /^MWS-[A-Z]{2,6}-[0-9]{1,2}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const RUN_STATUS = /^[a-z][a-z_-]{0,31}$/;
const MAX_RECORDS = 2000;
const MAX_TOOLS = 1000;
const MAX_PARAMS = 200;

/** A tool, resource or parameter name kept as data, or null (with the reason counted by the caller). */
export const safeName = (v) => (typeof v === 'string' && (NAME_RE.test(v) || CLI_PLACEHOLDER_RE.test(v)) ? v : null);
/** The CLI's own names for a record that is about no single tool or resource. */
const CLI_PLACEHOLDER_RE = /^\((?:catalog|server|no tool called)\)$/;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function parseJson(buf) {
  if (!buf || buf.length > 8 * 1024 * 1024) return null;
  try { const j = JSON.parse(buf.toString('utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

/**
 * The CLI's output folder for one mode among the collected files (Map path -> Buffer). Catalog mode writes
 * <out>/catalog-<10 hex>/, a run <out>/<run id>/. Exactly one folder must match; none or several (a target can
 * plant one) gives null and says why.
 */
export function findRunFolder(files, prefix, { catalog = false } = {}) {
  const re = catalog
    ? new RegExp(`^${prefix}/(catalog-[0-9a-f]{10})/results\\.json$`)
    : new RegExp(`^${prefix}/([A-Za-z0-9][A-Za-z0-9._-]{0,99})/results\\.json$`);
  const dirs = [...files.keys()].map((p) => re.exec(p)).filter(Boolean).map((m) => m[1]);
  if (dirs.length === 0) return { dir: null, why: 'no results folder' };
  if (dirs.length > 1) return { dir: null, why: `${dirs.length} results folders (expected one)` };
  return { dir: `${prefix}/${dirs[0]}`, why: null };
}

/** The checked records of a results.json: [{ requirement, verdict, resource, tool }], plus counts of what was dropped. */
export function readResults(doc) {
  const out = { status: null, writes: null, records: [], dropped: 0, truncated: false };
  if (!doc) return out;
  const st = doc.run?.status;
  out.status = typeof st === 'string' && RUN_STATUS.test(st) ? st : null;
  const w = doc.run?.writes;
  out.writes = Number.isSafeInteger(w) && w >= 0 ? w : null;
  const list = Array.isArray(doc.results) ? doc.results : [];
  for (const r of list) {
    if (out.records.length >= MAX_RECORDS) { out.truncated = true; break; }
    const requirement = typeof r?.requirement === 'string' && REQUIREMENT_RE.test(r.requirement) ? r.requirement : null;
    const verdict = VERDICTS.includes(r?.verdict) ? r.verdict : null;
    if (!requirement || !verdict) { out.dropped++; continue; }
    out.records.push({ requirement, verdict, resource: safeName(r?.write_path?.resource), tool: safeName(r?.write_path?.tool) });
  }
  return out;
}

/** Counts of records by requirement and verdict: [{ requirement, verdict, n }], sorted. */
export function verdictCounts(records) {
  const m = new Map();
  for (const r of records) { const k = `${r.requirement}\u0000${r.verdict}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].map(([k, n]) => { const [requirement, verdict] = k.split('\u0000'); return { requirement, verdict, n }; })
    .sort((a, b) => (a.requirement < b.requirement ? -1 : a.requirement > b.requirement ? 1 : a.verdict < b.verdict ? -1 : 1));
}

/**
 * The tools of the CLI's catalog.json ({ tools, prompts, resourceTemplates }): names, the four annotation hints
 * when they are booleans, and parameter names (top level of inputSchema.properties). Nothing else.
 */
export function readCatalog(doc) {
  const out = { tools: [], dropped: 0, truncated: false };
  const list = Array.isArray(doc?.tools) ? doc.tools : [];
  for (const t of list) {
    if (out.tools.length >= MAX_TOOLS) { out.truncated = true; break; }
    const name = safeName(t?.name);
    if (!name) { out.dropped++; continue; }
    const ann = {};
    for (const h of HINTS) if (typeof t?.annotations?.[h] === 'boolean') ann[h] = t.annotations[h];
    const props = t?.inputSchema?.properties;
    const params = props && typeof props === 'object' && !Array.isArray(props)
      ? Object.keys(props).slice(0, MAX_PARAMS).map(safeName).filter(Boolean) : [];
    out.tools.push({ name, annotations: ann, params });
  }
  return out;
}

const IDEMPOTENCY_PARAM = /idempot|dedup|request_?id$|client_?token|operation_?id$/i;
const CONCURRENCY_PARAM = /^(expected_?version|if_?match|if_?unmodified_?since|etag|revision|base_?version|expected_?revision|version)$/i;
const SAFETY_PARAM = /^(dry_?run|confirm(ed|ation)?|force|preview|simulate|validate_?only)$/i;

/** Parameters whose names suggest idempotency keys, concurrency guards or safety switches: [{ tool, param }]. */
export function paramEvidence(tools, re) {
  const out = [];
  for (const t of tools) for (const p of t.params) if (re.test(p)) out.push({ tool: t.name, param: p });
  return out.slice(0, 500);
}

/** The annotation counts of a catalog (registry field annotation_completeness). */
export function annotationCompleteness(tools) {
  const n = (f) => tools.filter(f).length;
  return {
    tool_count: tools.length,
    with_any_hint: n((t) => Object.keys(t.annotations).length > 0),
    with_no_hint: n((t) => Object.keys(t.annotations).length === 0),
    read_only_hint: n((t) => 'readOnlyHint' in t.annotations),
    destructive_hint: n((t) => 'destructiveHint' in t.annotations),
    idempotent_hint: n((t) => 'idempotentHint' in t.annotations),
    open_world_hint: n((t) => 'openWorldHint' in t.annotations),
    read_only_true: n((t) => t.annotations.readOnlyHint === true),
  };
}

const PLAN_HASH_RE = /^plan hash: ([0-9a-f]{16})$/gm;
/** The plan hash the CLI printed (stdout of the plan step). Two different hashes: null. */
export function planHash(stdout) {
  const seen = new Set([...String(stdout ?? '').matchAll(PLAN_HASH_RE)].map((m) => m[1]));
  return seen.size === 1 ? [...seen][0] : null;
}

const byReq = (records, prefix) => records.filter((r) => r.requirement.startsWith(prefix));

/**
 * The summary of one unit (an item or a control): what ran and the checked values of the CLI's outputs.
 * `files` is a Map of path (relative to /work/out) -> Buffer, `steps` our own step records.
 */
export function summarize({ files, steps, planStdout = '', fullRan = false, acceptedPlanHash = null }) {
  const cat = findRunFolder(files, 'results', { catalog: true });
  const catResults = readResults(cat.dir ? parseJson(files.get(`${cat.dir}/results.json`)) : null);
  const catalog = readCatalog(cat.dir ? parseJson(files.get(`${cat.dir}/catalog.json`)) : null);
  const full = fullRan ? findRunFolder(files, 'full') : { dir: null, why: 'not run' };
  const fullResults = readResults(full.dir ? parseJson(files.get(`${full.dir}/results.json`)) : null);
  const hash = planHash(planStdout);
  return {
    format: SUMMARY_FORMAT,
    steps: steps.map((s) => ({ step: s.step, exit: Number.isInteger(s.exit) ? s.exit : null, timed_out: !!s.timed_out, ms: Number.isInteger(s.ms) ? s.ms : null })),
    plan: { hash, accepted: acceptedPlanHash, drift: acceptedPlanHash !== null && hash !== acceptedPlanHash },
    catalog: {
      found: !!cat.dir, why: cat.why, status: catResults.status, tool_count: catalog.tools.length,
      tools_dropped: catalog.dropped, records_dropped: catResults.dropped, truncated: catResults.truncated || catalog.truncated,
      verdicts: verdictCounts(catResults.records),
    },
    full: {
      ran: fullRan, found: !!full.dir, why: full.why, status: fullResults.status, writes: fullResults.writes,
      records_dropped: fullResults.dropped, truncated: fullResults.truncated, verdicts: verdictCounts(fullResults.records),
    },
    _records: { catalog: catResults.records, full: fullResults.records, tools: catalog.tools },
  };
}

/** The summary as written to results/ (without the per-record lists, which become field records). */
export function publicSummary(s) {
  const { _records, ...rest } = s;
  return rest;
}

/**
 * The field records (registry ids of isokron-ai/mcp-results fields/registry.yaml) for one unit. Values are the
 * checked ones above; per-tool values are lists of { tool, ... }, never objects keyed by a tool name.
 */
export function observations(s, { versions, stagesRan, evidenceComplete = true }) {
  const recs = [];
  const add = (field, value, stage, why) => recs.push({ field, value, ...(value === null ? { why } : {}), ...(stage ? { stage } : {}) });
  add('our_tool_versions', versions, null);
  add('sandbox_tier', 'gvisor', null);
  add('observation_coverage', { ...stagesRan, sandbox_evidence_complete: evidenceComplete }, null);
  add('step_telemetry', { steps: publicSummary(s).steps }, null);
  if (!evidenceComplete) return recs;
  const r = s._records;
  if (s.catalog.found) {
    add('tool_annotations_declared', { tools: r.tools.map((t) => ({ tool: t.name, ...t.annotations })), tool_count: r.tools.length }, 'catalog');
    add('annotation_completeness', annotationCompleteness(r.tools), 'catalog');
    add('idempotency_evidence_params', paramEvidence(r.tools, IDEMPOTENCY_PARAM), 'catalog');
    add('concurrency_guard_params', paramEvidence(r.tools, CONCURRENCY_PARAM), 'catalog');
    add('safety_params', paramEvidence(r.tools, SAFETY_PARAM), 'catalog');
    add('requirement_verdicts', r.catalog.map((x) => ({ ...x, mode: 'catalog' })), 'catalog');
  }
  if (s.plan.hash !== null || s.plan.accepted !== null) add('plan_hash_and_drift', { plan_hash: s.plan.hash, accepted: s.plan.accepted, drift: s.plan.drift, full_run: s.full.ran }, 'plan');
  if (s.full.found) {
    add('requirement_verdicts', r.full.map((x) => ({ ...x, mode: 'full' })), 'full');
    const pick = (p) => ({ records: byReq(r.full, p).map((x) => ({ requirement: x.requirement, verdict: x.verdict, tool: x.tool, resource: x.resource })), counts: verdictCounts(byReq(r.full, p)) });
    add('annotation_honesty_behaviour_confirmed', pick('MWS-ANN-'), 'full');
    add('idempotency_evidence_behaviour', pick('MWS-RETRY-'), 'full');
    add('conflict_behaviour', pick('MWS-CONC-'), 'full');
  }
  return recs;
}

export const ndjson = (recs) => recs.map((x) => JSON.stringify(x)).join('\n') + (recs.length ? '\n' : '');
export { sha256 };
