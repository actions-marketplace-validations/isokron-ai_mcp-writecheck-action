// Bundle assembly for the writecheck loop worker: what goes in raw/, results/, observations/, logs/ and controls/
// of one item's result bundle (tool-qa worker-kit/README.md, "Bundle layout"), the meta file, and the control
// verdicts. Pure functions over buffers and plain objects, so they can be tested without Docker.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Per-file and per-bundle caps for captured bytes (raw/). tool-qa's contract allows 8 MiB a file, 64 MiB a bundle. */
export const RAW_FILE_CAP = 4 * 1024 * 1024;
export const RAW_TOTAL_CAP = 32 * 1024 * 1024;
const PART_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** A bundle path made from a path the target chose: kept when every part is safe and it fits, else a hashed name. */
export function safeRawPath(prefix, rel) {
  const parts = String(rel).split('/');
  const p = `${prefix}/${parts.join('/')}`;
  if (parts.every((x) => PART_RE.test(x)) && p.length <= 200) return p;
  return `${prefix}/_renamed/${sha256(String(rel)).slice(0, 32)}`;
}

/**
 * The collect helper's JSON lines (loop/sandbox/collect.mjs) as { files: Map(rel -> Buffer), entries: [...], done }.
 * Every line is checked; one that does not parse or has the wrong shape is counted and skipped.
 */
export function parseCollected(stdout) {
  const files = new Map();
  const entries = [];
  let bad = 0;
  let done = null;
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { bad++; continue; }
    if (o.done === true) { done = { entries: Number.isSafeInteger(o.entries) ? o.entries : null, capped: o.capped === true }; continue; }
    if (typeof o.path !== 'string' || o.path.length === 0 || o.path.length > 4096 || o.path.split('/').some((x) => x === '' || x === '.' || x === '..')) { bad++; continue; }
    if (!['file', 'link', 'other'].includes(o.kind)) { bad++; continue; }
    const e = { path: o.path, kind: o.kind };
    if (o.kind === 'file') {
      e.bytes = Number.isSafeInteger(o.bytes) && o.bytes >= 0 ? o.bytes : null;
      e.sha256 = typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) ? o.sha256 : null;
      if (o.omitted === true) e.omitted = true;
      else if (typeof o.b64 === 'string') {
        const data = Buffer.from(o.b64, 'base64');
        e.truncated = o.truncated === true || (e.bytes !== null && data.length < e.bytes);
        if (!files.has(o.path)) files.set(o.path, data);
      } else { bad++; continue; }
    }
    entries.push(e);
  }
  return { files, entries, bad, done };
}

/** Collects the files of one bundle in memory, with raw/ capped and indexed. */
export class BundleFiles {
  constructor({ fileCap = RAW_FILE_CAP, totalCap = RAW_TOTAL_CAP } = {}) { this.files = new Map(); this.rawBytes = 0; this.rawIndex = []; this.fileCap = fileCap; this.totalCap = totalCap; }

  /** A file outside raw/ (our own output). */
  put(path, data) { this.files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(String(data))); }

  /** Captured bytes, cut to the caps; the index keeps the original size and hash. */
  raw(path, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const room = Math.max(0, Math.min(this.fileCap, this.totalCap - this.rawBytes));
    const kept = buf.subarray(0, room);
    this.rawIndex.push({ path, bytes: buf.length, kept: kept.length, sha256: sha256(buf), truncated: kept.length < buf.length });
    if (kept.length === 0 && buf.length > 0) return;
    this.files.set(path, Buffer.from(kept));
    this.rawBytes += kept.length;
  }

  /** Writes every file under dir (which must be new or empty). */
  write(dir) {
    for (const [p, data] of this.files) {
      const abs = join(dir, ...p.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data);
    }
  }
}

// ---- controls ----

const IDENTITY_KEYS = new Set(['attempt_id', 'attemptid', 'run_key', 'runkey', 'fence', 'fencing_no', 'fencing_number', 'fencingno', 'fence_token']);
const canon = (k) => String(k).toLowerCase().replace(/[-\s]/g, '_');

/** True when a JSON value has an object key that reads as an attempt identity, or the shape of a result envelope. */
export function hasIdentityKeys(value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) { stack.push(...v); continue; }
    const keys = Object.keys(v);
    if (keys.some((k) => IDENTITY_KEYS.has(canon(k)))) return true;
    if (keys.includes('schema_version') && keys.includes('files')) return true;
    stack.push(...Object.values(v));
  }
  return false;
}

/** The plan hash loop/sandbox/forgery-server.mjs forges (test/loop.test.mjs checks they agree). */
export const FORGED_PLAN_HASH = '0123456789abcdef';
/** The forgery server's two tools: MWS-ANN-4 must judge each, and `attempt_id` (no read-only or destructive hint) violated. */
const FORGERY_TOOLS = ['attempt_id', 'fence'];

/**
 * The forgery control's verdict, as tool-qa's ingest will check it, plus the CLI's own verdict on the control
 * server (R-WC-05):
 *   "not_read"  the pipeline did not read the control server's tool list, or the marker is not in the captured bytes;
 *   "leaked"    our output for the control holds the marker, an identity key or an envelope;
 *   "tampered"  the verdict is not the one the real tool list gives: a forged or missing plan hash, MWS-ANN-4
 *               records for other tools than the server's two, none violated, or a record for the planted tool;
 *   "contained" otherwise.
 */
export function forgeryVerdict({ marker, output, rawTexts, toolCount, summary = null }) {
  const outText = JSON.stringify(output);
  const inRaw = rawTexts.some((t) => t.includes(marker));
  if (toolCount < 2 || !inRaw) return 'not_read';
  if (outText.includes(marker) || hasIdentityKeys(output)) return 'leaked';
  if (summary) {
    const ann = summary._records.catalog.filter((r) => r.requirement === 'MWS-ANN-4');
    const tools = [...new Set(ann.map((r) => r.tool))].sort();
    const all = [...summary._records.catalog, ...summary._records.tools.map((t) => ({ tool: t.name }))];
    if (summary.plan.hash === null || summary.plan.hash === FORGED_PLAN_HASH) return 'tampered';
    if (JSON.stringify(tools) !== JSON.stringify(FORGERY_TOOLS) || !ann.some((r) => r.tool === 'attempt_id' && r.verdict === 'violated')) return 'tampered';
    if (all.some((r) => r.tool === 'forged')) return 'tampered';
  }
  return 'contained';
}

/** Known-bad control: the defect's requirement must have a violated record. */
export function knownBadVerdict(summary, requirement) {
  if (!summary.catalog.found) return 'not_run';
  const recs = summary._records.catalog.filter((r) => r.requirement === requirement);
  if (recs.some((r) => r.verdict === 'violated')) return 'detected';
  return 'missed';
}

/** Known-good control: the same requirement on the build without the defect: held, never violated. */
export function knownGoodVerdict(summary, requirement) {
  if (!summary.catalog.found) return 'not_run';
  const recs = summary._records.catalog.filter((r) => r.requirement === requirement);
  if (recs.some((r) => r.verdict === 'violated')) return 'violated';
  return recs.some((r) => r.verdict === 'held') ? 'held' : 'not_observed';
}

/** The meta file of one item (tool-qa worker-kit/README.md, "The meta file"). */
export function buildMeta({ subject, tools, settingsDigest, startedAt, finishedAt, skips, controls }) {
  return {
    subject: { id: subject, repo: subject, sha: null },
    tools,
    oracles: [],
    settings_manifest_digest: settingsDigest,
    started_at: startedAt,
    finished_at: finishedAt,
    skips,
    controls: controls.map((c) => ({ kind: c.kind, expected: c.expected, observed: c.observed, output: c.output, ...(c.marker ? { marker: c.marker } : {}) })),
  };
}
