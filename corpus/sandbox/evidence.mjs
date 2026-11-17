#!/usr/bin/env node
/**
 * Evidence of a finished step, kept out of the target's reach. Ours, not target code: it runs read-only
 * from the CLI volume as the sandbox user with no network, after the step's container has exited (so no
 * target process is running), with the target's /work and a helper-only evidence volume mounted. It
 * moves the step's output from /work/out into the evidence volume: the config-source copy, the init
 * draft, the catalog's results folders, a full repeat's results/full-<i> and state/full-<i>. Regular
 * files and folders only (a symlink, fifo or device is never followed or opened; it is counted and left
 * behind to be removed). It prints the listing of what it moved:
 *
 *   node evidence.mjs <from dir> <to dir> <relative path>...
 *
 * A path is one of EVIDENCE_PATH; `results/catalog-*` stands for every results/catalog-<id> folder there
 * is. One JSON line: { files: [{ path, sha256, bytes }], sha256, skipped, missing, moved }. `sha256` is
 * listingHash(files); the host computes the same listing over the copied-out bundle (listTree) and
 * compares, so a change on the way shows.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The paths a move may name. */
export const EVIDENCE_PATH = /^(config-source|init-draft\.yaml|results\/catalog-\*|(results|state)\/full-\d{1,2})$/;

/** `results/catalog-*` expanded to the catalog folders under `from`; other paths as they are. */
export function expandPaths(from, rels) {
  return rels.flatMap((r) => {
    if (r !== 'results/catalog-*') return [r];
    let names = [];
    try { names = readdirSync(join(from, 'results')); } catch {}
    return names.filter((n) => n.startsWith('catalog-')).sort().map((n) => `results/${n}`);
  });
}

/** sha256 of an open regular file, read in chunks. */
function hashFile(p) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return null;
    const h = createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) { h.update(buf.subarray(0, n)); bytes += n; }
    return { sha256: h.digest('hex'), bytes };
  } finally {
    closeSync(fd);
  }
}

/** Every regular file under root/<rel> (lstat: no symlink followed), as relative paths, sorted. */
export function walkFiles(root, rels) {
  const files = [];
  let skipped = 0;
  const go = (rel) => {
    let st;
    try { st = lstatSync(join(root, rel)); } catch { return; }
    if (st.isDirectory()) {
      let names = [];
      try { names = readdirSync(join(root, rel)); } catch { skipped++; return; }
      for (const n of names) go(`${rel}/${n}`);
    } else if (st.isFile()) files.push(rel);
    else skipped++;
  };
  for (const r of rels) go(r);
  return { files: files.sort(), skipped };
}

/** The combined hash of a listing: sha256 of its canonical JSON (sorted by path). */
export function listingHash(files) {
  return createHash('sha256').update(JSON.stringify(files.map((f) => [f.path, f.sha256, f.bytes]))).digest('hex');
}

/** The listing of root/<rels> as it is now (used by the host on the copied-out bundle). */
export function listTree(root, rels) {
  const { files, skipped } = walkFiles(root, rels);
  const out = [];
  for (const path of files) {
    const h = hashFile(join(root, path));
    if (h) out.push({ path, ...h });
  }
  return { files: out, sha256: listingHash(out), skipped };
}

/** Move root/<rels> into dest (regular files and folders only), then list what is in dest. */
export function moveEvidence(from, to, relsIn) {
  const rels = expandPaths(from, relsIn);
  let skipped = 0;
  const missing = [];
  const copy = (rel) => {
    const src = join(from, rel);
    let st;
    try { st = lstatSync(src); } catch { return; }
    if (st.isDirectory()) {
      try { chmodSync(src, 0o700); } catch {}
      mkdirSync(join(to, rel), { recursive: true });
      let names = [];
      try { names = readdirSync(src); } catch { skipped++; return; }
      for (const n of names) copy(`${rel}/${n}`);
    } else if (st.isFile()) {
      try { chmodSync(src, 0o600); } catch {}
      mkdirSync(join(to, rel, '..'), { recursive: true });
      try { copyFileSync(src, join(to, rel), constants.COPYFILE_EXCL); } catch { skipped++; }
    } else skipped++;
  };
  for (const r of rels) {
    if (!existsSync(join(from, r))) { missing.push(r); continue; }
    copy(r);
    rmSync(join(from, r), { recursive: true, force: true });
  }
  const present = rels.filter((r) => !missing.includes(r));
  const l = listTree(to, present);
  return { files: l.files, sha256: l.sha256, skipped: skipped + l.skipped, missing, moved: present };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [from, to, ...rels] = process.argv.slice(2);
  if (!from || !to || !rels.length || rels.some((r) => !EVIDENCE_PATH.test(r))) {
    process.stderr.write('usage: evidence.mjs <from dir> <to dir> <path>... (config-source, init-draft.yaml, results/catalog-*, results|state/full-N)\n');
    process.exit(2);
  }
  const res = moveEvidence(from, to, rels);
  process.stdout.write(`${JSON.stringify(res)}\n`);
}
