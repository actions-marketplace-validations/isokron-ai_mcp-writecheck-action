#!/usr/bin/env node
/**
 * The installed package's configuration source, for the encrypted record. Ours, not target code: it
 * runs read-only from the CLI volume, inside a sandbox container of the target (user 10001, no
 * capability, read-only root, no network), after install and before set-up. It only reads the
 * installed files (no symlink is followed except the bin's own, which must stay under the work
 * folder; nothing but regular files is opened) and copies a selection into <out dir>:
 *
 *   1. the package manifest (npm: package.json; PyPI: the dist-info METADATA);
 *   2. README* and LICENSE* (also LICENCE*);
 *   3. the entry point that bins[0] resolves to (and, for a Python console script, its module);
 *   4. any file under 256 KiB whose path in the package matches config|settings|env|options;
 *
 * in that order, at most MAX_FILES files and MAX_TOTAL bytes; what does not fit is listed as
 * skipped. Each copy keeps its path relative to the work folder.
 *
 *   node config-source.mjs <work dir> <ecosystem> <package> <bin dir> <bin name or ""> <out dir>
 *
 * Prints one JSON line: { root, files: [{ path, sha256, bytes, rule }], skipped: [{ path, bytes, rule, why }],
 * skipped_more, total_bytes, why }. Exit 0, or 2 on a usage error.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export const MAX_FILES = 40;
export const MAX_TOTAL = 4 * 1024 * 1024;
export const CONFIG_MAX = 256 * 1024;
export const CONFIG_RE = /config|settings|env|options/i;
const WALK_MAX = 20_000;
const DEPTH_MAX = 24;
const SKIPPED_MAX = 200;

/** Read a regular file without following a symlink and without blocking on a fifo; null when it is not one. */
function readRegular(p, max) {
  let fd;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { why: 'not readable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { why: 'not a regular file' };
    if (st.size > max) return { why: 'over the size limit', bytes: st.size };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { buf: buf.subarray(0, off) };
  } finally {
    closeSync(fd);
  }
}

/** Regular files under `root` (lstat: symlinks are not followed), skipping folders `skip` names. */
function walk(root, skip = () => false) {
  const out = [];
  let seen = 0;
  const go = (dir, depth) => {
    if (depth > DEPTH_MAX) return;
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (++seen > WALK_MAX) return;
      const p = join(dir, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!skip(n, depth)) go(p, depth + 1); }
      else if (st.isFile()) out.push({ abs: p, size: st.size });
    }
  };
  go(root, 0);
  return out;
}

const norm = (s) => String(s).toLowerCase().replace(/[-_.]+/g, '-');

/** The PyPI package's dist-info folder and site-packages (in the venv the install made). */
function pypiDist(work, pkg) {
  const lib = join(work, 'venv', 'lib');
  if (!existsSync(lib)) return null;
  for (const py of readdirSync(lib).sort()) {
    const site = join(lib, py, 'site-packages');
    if (!existsSync(site)) continue;
    for (const d of readdirSync(site).sort()) {
      if (!d.endsWith('.dist-info')) continue;
      const meta = readRegular(join(site, d, 'METADATA'), CONFIG_MAX * 16);
      const name = meta.buf ? /^Name:\s*(.+)$/m.exec(meta.buf.toString('utf8'))?.[1]?.trim() : null;
      if (name && norm(name) === norm(pkg)) return { site, dist: join(site, d) };
    }
  }
  return null;
}

/** RECORD lines of a wheel: "path,hash,size", the path quoted when it has a comma. */
function recordPaths(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.startsWith('"') ? /^"((?:[^"]|"")*)"/.exec(line) : /^([^,]*)/.exec(line);
    if (m) out.push(m[1].replace(/""/g, '"'));
  }
  return out;
}

export function collect({ work: workIn, ecosystem, pkg, binDir: binIn, bin, outDir }) {
  const res = { root: null, files: [], skipped: [], skipped_more: 0, total_bytes: 0, why: null };
  // Paths are compared and made relative after resolving the work folder itself (the bin's target
  // is a realpath); a folder given under it keeps its place.
  let work;
  try { work = realpathSync(workIn); } catch { res.why = 'the work folder was not found'; return res; }
  const binDir = binIn === workIn || String(binIn).startsWith(`${workIn}/`) ? work + String(binIn).slice(workIn.length) : binIn;
  const inWork = (p) => p === work || p.startsWith(`${work}/`);
  let candidates = []; // { abs, size }
  let manifest = null;
  let dist = null;
  if (ecosystem === 'npm') {
    res.root = join(work, 'pkg', 'node_modules', pkg);
    if (!pkg || !inWork(res.root) || !existsSync(res.root)) { res.why = 'the installed package folder was not found'; return res; }
    // The package's own files: nested node_modules are its dependencies, not its source.
    candidates = walk(res.root, (n) => n === 'node_modules' || n === '.git');
    manifest = join(res.root, 'package.json');
  } else if (ecosystem === 'pypi') {
    const d = pypiDist(work, pkg);
    if (!d) { res.why = 'the installed distribution (dist-info) was not found'; return res; }
    res.root = d.site;
    dist = d.dist;
    const rec = readRegular(join(d.dist, 'RECORD'), 16 * 1024 * 1024);
    const paths = rec.buf ? recordPaths(rec.buf.toString('utf8')) : [];
    for (const p of paths) {
      if (p.startsWith('/') || p.split('/').includes('..')) continue; // scripts outside site-packages: bins[0] covers the one we need
      const abs = join(d.site, p);
      try { const st = lstatSync(abs); if (st.isFile()) candidates.push({ abs, size: st.size }); } catch {}
    }
    manifest = join(d.dist, 'METADATA');
  } else if (ecosystem === 'binary') {
    res.root = binDir;
    if (!inWork(binDir) || !existsSync(binDir)) { res.why = 'the unpacked folder was not found'; return res; }
    candidates = walk(binDir, (n) => n === '.git');
  } else {
    res.why = `unknown ecosystem ${ecosystem}`;
    return res;
  }

  const relRoot = (abs) => relative(res.root, abs);
  const picks = []; // { abs, rule, max }
  if (manifest) picks.push({ abs: manifest, rule: 'manifest' });
  const byDepth = (a, b) => relRoot(a.abs).split('/').length - relRoot(b.abs).split('/').length || (a.abs < b.abs ? -1 : 1);
  for (const c of candidates.filter((c) => /^readme/i.test(basename(c.abs))).sort(byDepth)) picks.push({ abs: c.abs, rule: 'readme' });
  for (const c of candidates.filter((c) => /^licen[cs]e/i.test(basename(c.abs))).sort(byDepth)) picks.push({ abs: c.abs, rule: 'license' });
  if (bin) {
    const link = join(binDir, bin);
    let real = null;
    try { real = realpathSync(link); } catch {}
    if (real && inWork(real)) {
      picks.push({ abs: real, rule: 'entry' });
      // A Python console script is a small wrapper: its module is the entry point proper.
      if (dist) {
        const ep = readRegular(join(dist, 'entry_points.txt'), CONFIG_MAX);
        const sec = ep.buf ? /^\[console_scripts\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(ep.buf.toString('utf8'))?.[1] ?? '' : '';
        const line = sec.split(/\r?\n/).map((l) => /^\s*([^=\s]+)\s*=\s*([A-Za-z0-9_.]+)/.exec(l)).find((m) => m && m[1] === bin);
        if (line) {
          const mod = line[2].split('.');
          for (const f of [`${join(res.root, ...mod)}.py`, join(res.root, ...mod, '__init__.py')]) {
            if (existsSync(f)) { picks.push({ abs: f, rule: 'entry' }); break; }
          }
        }
      }
    } else {
      res.skipped.push({ path: relative(work, link), bytes: null, rule: 'entry', why: real ? 'resolves outside the work folder' : 'does not resolve' });
    }
  }
  // The path inside the package: for PyPI the first folder (the module or dist-info, named after the
  // package) is left out, so a package called "*-config-*" does not match with every file.
  const inPkg = (abs) => (dist ? relRoot(abs).split('/').slice(1).join('/') || relRoot(abs) : relRoot(abs));
  for (const c of candidates.filter((c) => CONFIG_RE.test(inPkg(c.abs))).sort((a, b) => (a.abs < b.abs ? -1 : 1))) picks.push({ abs: c.abs, rule: 'config', max: CONFIG_MAX - 1 });

  const done = new Set();
  const skip = (s) => { if (res.skipped.length < SKIPPED_MAX) res.skipped.push(s); else res.skipped_more++; };
  for (const p of picks) {
    if (done.has(p.abs)) continue;
    done.add(p.abs);
    const path = relative(work, p.abs);
    if (!path || path.startsWith('..') || path.startsWith('/')) continue;
    if (res.files.length >= MAX_FILES) { skip({ path, bytes: null, rule: p.rule, why: 'file limit' }); continue; }
    const r = readRegular(p.abs, Math.min(p.max ?? Infinity, MAX_TOTAL - res.total_bytes));
    if (!r.buf) {
      const why = r.why === 'over the size limit' ? (p.rule === 'config' && r.bytes >= CONFIG_MAX ? 'config file over 256 KiB' : 'size limit') : r.why;
      skip({ path, bytes: r.bytes ?? null, rule: p.rule, why });
      continue;
    }
    const dest = join(outDir, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, r.buf, { mode: 0o644 });
    res.total_bytes += r.buf.length;
    res.files.push({ path, sha256: createHash('sha256').update(r.buf).digest('hex'), bytes: r.buf.length, rule: p.rule });
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [work, ecosystem, pkg, binDir, bin, outDir] = process.argv.slice(2);
  if (!work || !ecosystem || binDir === undefined || bin === undefined || !outDir) {
    process.stderr.write('usage: config-source.mjs <work dir> <ecosystem> <package> <bin dir> <bin name or ""> <out dir>\n');
    process.exit(2);
  }
  let res;
  try {
    res = collect({ work, ecosystem, pkg, binDir, bin, outDir });
  } catch (e) {
    res = { root: null, files: [], skipped: [], skipped_more: 0, total_bytes: 0, why: `collect failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  process.stdout.write(`${JSON.stringify(res)}\n`);
}
