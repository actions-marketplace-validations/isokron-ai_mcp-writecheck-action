#!/usr/bin/env node
/**
 * Brings a step's output folder back to the host. Ours, not target code: it runs in a helper container (our image,
 * no network, the work volume read-only) after the step's sandbox container has ended, and reads files the target
 * could have written or replaced, so it treats every entry as data:
 *
 *   node collect.mjs <root> <file cap bytes> <total cap bytes> <max entries>
 *
 * One JSON line per entry on stdout: the files the summary reads first (results.json, catalog.json, report.md,
 * init-draft.yaml), then the rest in path order:
 *   { path, kind: "file", bytes, sha256, b64, truncated }   a regular file (the first <file cap> bytes, base64)
 *   { path, kind: "file", bytes, sha256, omitted: true }    past the total cap: listed and hashed, not copied
 *   { path, kind: "link" | "other" }                        never followed, never read
 * then { done: true, entries, files, bytes, capped }. Paths are relative to <root>, with "/" between parts.
 * Folders are walked without following links, at most 12 deep.
 */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [root, fileCapArg, totalCapArg, maxArg] = process.argv.slice(2);
const fileCap = Number(fileCapArg);
const totalCap = Number(totalCapArg);
const maxEntries = Number(maxArg);
if (!root || !(fileCap > 0) || !(totalCap > 0) || !(maxEntries > 0)) {
  process.stdout.write(`${JSON.stringify({ error: 'usage: collect.mjs <root> <file cap> <total cap> <max entries>' })}\n`);
  process.exit(2);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let entries = 0;
let files = 0;
let copied = 0;
let capped = false;

function readFile(abs, size) {
  const h = createHash('sha256');
  const keep = [];
  let kept = 0;
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      if (kept < fileCap) { const take = Math.min(n, fileCap - kept); keep.push(Buffer.from(buf.subarray(0, take))); kept += take; }
    }
  } finally { closeSync(fd); }
  return { sha256: h.digest('hex'), data: Buffer.concat(keep), size };
}

/** The files the summary reads come first, so a run that leaves thousands of capture files cannot crowd them out. */
const FIRST = /(^|\/)(results\.json|catalog\.json|report\.md|init-draft\.yaml)$/;
const LIST_CAP = 50_000;
const listed = [];
function list(abs, rel, depth) {
  let names;
  try { names = readdirSync(abs).sort(); } catch { return; }
  for (const name of names) {
    if (listed.length >= LIST_CAP) { capped = true; return; }
    const childAbs = join(abs, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try { st = lstatSync(childAbs); } catch { continue; }
    if (st.isDirectory() && !st.isSymbolicLink()) { if (depth < 12) list(childAbs, childRel, depth + 1); else listed.push({ abs: childAbs, rel: childRel, kind: 'other' }); continue; }
    listed.push({ abs: childAbs, rel: childRel, kind: st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other', size: st.size });
  }
}

function walk(abs, rel, depth) {
  list(abs, rel, depth);
  const order = (e) => (FIRST.test(e.rel) ? 0 : 1);
  listed.sort((a, b) => order(a) - order(b) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const e of listed) {
    if (entries >= maxEntries) { capped = true; return; }
    entries++;
    if (e.kind !== 'file') { out({ path: e.rel, kind: e.kind }); continue; }
    files++;
    let f;
    try { f = readFile(e.abs, e.size); } catch { out({ path: e.rel, kind: 'other' }); continue; }
    if (copied >= totalCap) { capped = true; out({ path: e.rel, kind: 'file', bytes: f.size, sha256: f.sha256, omitted: true }); continue; }
    const data = f.data.subarray(0, Math.max(0, totalCap - copied));
    copied += data.length;
    out({ path: e.rel, kind: 'file', bytes: f.size, sha256: f.sha256, b64: data.toString('base64'), truncated: data.length < f.size });
  }
}

walk(root, '', 0);
out({ done: true, entries, files, bytes: copied, capped });
