#!/usr/bin/env node
/**
 * Fetches one pinned tarball for a target's set-up, in a helper container of the corpus (ours, not
 * target code; read-only in the CLI volume at /opt/mwsc/_corpus):
 *
 *   node fetch.mjs <url> <sha256> <out-file> <cap-bytes>
 *
 * Only https on the allowlisted hosts (FETCH_HOSTS), with every redirect checked against the same
 * list; no credentials, port, query or fragment. The body is streamed, counted against the cap and
 * hashed; the file is created exclusively (never through a symlink) and removed again unless its
 * sha256 is the pinned one. Prints `sha256 <hex> bytes <n>` and exits 0 only on a match. Nothing is
 * unpacked here: the driver unpacks a verified file in a sandbox container with no network.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Hosts a set-up `fetch` may use: source archives by commit, and the package registries. */
export const FETCH_HOSTS = Object.freeze(['github.com', 'codeload.github.com', 'registry.npmjs.org', 'files.pythonhosted.org']);
const GITHUB = new Set(['github.com', 'codeload.github.com']);
const MAX_REDIRECTS = 5;

/**
 * A fetch URL as the target list may give it. GitHub archives must name a 40-hex commit (a branch or
 * tag would move); the sha256 is the pin in every case. Throws with a reason; returns the URL.
 */
export function checkFetchUrl(raw, hosts = FETCH_HOSTS) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('fetch: not a URL'); }
  if (u.protocol !== 'https:') throw new Error('fetch: https only');
  if (u.username || u.password || u.port || u.search || u.hash) throw new Error('fetch: no credentials, port, query or fragment');
  if (!hosts.includes(u.hostname)) throw new Error(`fetch: host ${u.hostname} is not allowlisted`);
  if (u.pathname.includes('..') || u.pathname.includes('%')) throw new Error('fetch: path');
  return u;
}

/** The first URL as listed; a GitHub one must be pinned to a commit. */
export function checkListedUrl(raw, hosts = FETCH_HOSTS) {
  const u = checkFetchUrl(raw, hosts);
  if (GITHUB.has(u.hostname) && !/\/[0-9a-f]{40}(\.tar\.gz|\.tgz)?$/.test(u.pathname)) throw new Error('fetch: a GitHub archive must name a 40-hex commit');
  return u;
}

/**
 * Download `url` into `out` and check it against `sha256`. `fetchImpl` is the WHATWG fetch (tests
 * pass a stand-in). Returns { sha256, bytes }; throws on any refusal, leaving no file behind.
 */
export async function fetchVerified({ url, sha256, out, cap, fetchImpl = fetch, hosts = FETCH_HOSTS }) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error('fetch: sha256 must be 64 lower-case hex');
  let u = checkListedUrl(url, hosts);
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetchImpl(u.href, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    if (hop >= MAX_REDIRECTS) throw new Error('fetch: too many redirects');
    const loc = res.headers.get('location');
    if (!loc) throw new Error('fetch: redirect without a location');
    u = checkFetchUrl(new URL(loc, u).href, hosts);
  }
  if (res.status !== 200 || !res.body) throw new Error(`fetch: HTTP ${res.status}`);
  mkdirSync(dirname(out), { recursive: true });
  const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const h = createHash('sha256');
  let bytes = 0;
  let ok = false;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > cap) throw new Error(`fetch: larger than the cap (${cap} bytes)`);
      h.update(chunk);
      writeSync(fd, chunk);
    }
    const got = h.digest('hex');
    if (got !== sha256) throw new Error(`fetch: sha256 ${got} is not the pinned ${sha256}`);
    ok = true;
    return { sha256: got, bytes };
  } finally {
    closeSync(fd);
    if (!ok) { try { unlinkSync(out); } catch {} }
  }
}

async function main([url, sha256, out, cap]) {
  try {
    const r = await fetchVerified({ url, sha256, out, cap: Number(cap) });
    process.stdout.write(`sha256 ${r.sha256} bytes ${r.bytes}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(3);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
