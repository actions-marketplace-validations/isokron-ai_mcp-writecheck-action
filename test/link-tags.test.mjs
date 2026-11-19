// Every link to isokron.ai that this repository shows to a person carries the channel tag of the place it appears in:
// utm_source and utm_medium, a fixed pair per surface. The table of all surfaces across the IsoKron repositories is
// docs/LINK-TAGS.md in the site's repository; the rows for this repository are repeated in SURFACES. This test fails when a link
// is untagged, carries another surface's tag or an unknown source, or when a file gains a link no surface covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SPEC_DEFAULT_URL, SPEC_LINK_TAG, requirementUrl } from '../contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Path (a file, or a folder ending in /) -> the tag its links carry; the first match wins. */
const SURFACES = [
  ['action.yml', 'writecheck-action', 'action'],
  ['contract.mjs', 'writecheck-action', 'action'],
  ['skills/', 'writecheck-action-skill', 'skill'],
  ['plugin/skills/', 'writecheck-action-skill', 'skill'],
  // set before the table existed: the plugin directory listing
  ['.claude-plugin/marketplace.json', 'claude-plugins', 'directory', 'skills'],
  ['plugin/.claude-plugin/plugin.json', 'claude-plugins', 'directory', 'skills'],
  ['plugin/README.md', 'claude-plugins', 'directory', 'skills'],
  ['README.md', 'writecheck-action-readme', 'readme'],
  ['TESTING.md', 'writecheck-action-readme', 'readme'],
  ['NOTES.md', 'writecheck-action-readme', 'readme'],
  ['RUNNER-TEST.md', 'writecheck-action-readme', 'readme'],
  ['SECURITY.md', 'writecheck-action-readme', 'readme'],
  ['corpus/README.md', 'writecheck-action-readme', 'readme'],
  ['dogfood/README.md', 'writecheck-action-readme', 'readme'],
  ['examples/', 'writecheck-action-readme', 'readme'],
];
/** Lines that name the default or quote a tagged link on purpose, with the tag they carry instead of the file's. */
const LINE_TAGS = [[/spec-url|`https:\/\/isokron\.ai\/mws\?utm_source=writecheck-action&utm_medium=action/, 'writecheck-action', 'action']];
const NOT_SCANNED = [/^test\//, /^corpus\/(?!README)/, /^\.github\/workflows\//, /^dogfood\/(?!README)/, /\.(png|svg|jpg)$/];
const URL_RE = /https:\/\/isokron\.ai(?![\w.-])([^\s)\]}>"'`#?]*)(\?[^\s)\]}>"'`#]*)?(#[^\s)\]}>"'`]*)?/g;

const files = (() => {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
})();

test('link tags: every isokron.ai link in the repository carries its surface tag', { skip: files.length === 0 && 'not a git checkout' }, () => {
  let links = 0;
  const seen = new Set();
  for (const f of files) {
    if (NOT_SCANNED.some((re) => re.test(f))) continue;
    let text;
    try { text = readFileSync(root + f, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(URL_RE)) {
        const surface = SURFACES.find(([p]) => f === p || (p.endsWith('/') && f.startsWith(p)));
        assert.ok(surface, `${f}:${i + 1} has a link to isokron.ai and no surface covers this file: ${m[0]}`);
        let [, source, medium, campaign] = surface;
        const over = LINE_TAGS.find(([re]) => re.test(line));
        if (over) [, source, medium] = over;
        const q = new URLSearchParams((m[2] ?? '').replace(/^\?/, '').replace(/[.,;:]+$/, ''));
        assert.equal(q.get('utm_source'), source, `${f}:${i + 1}: ${m[0]}`);
        assert.equal(q.get('utm_medium'), medium, `${f}:${i + 1}: ${m[0]}`);
        assert.deepEqual([...q.keys()].sort(), campaign ? ['utm_campaign', 'utm_medium', 'utm_source'] : ['utm_medium', 'utm_source'], `${f}:${i + 1}`);
        if (campaign) assert.equal(q.get('utm_campaign'), campaign);
        links++;
        seen.add(source);
      }
    });
  }
  assert.ok(links >= 30, `found ${links} links`);
  for (const s of ['writecheck-action', 'writecheck-action-readme', 'writecheck-action-skill', 'claude-plugins']) assert.ok(seen.has(s), `no link carries ${s}`);
});

test('link tags: the job summary links carry the Action tag before the anchor', () => {
  assert.equal(SPEC_DEFAULT_URL, 'https://isokron.ai/mws?' + SPEC_LINK_TAG);
  assert.equal(requirementUrl(SPEC_DEFAULT_URL, 'MWS-UPD-1'), 'https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-upd-1');
  assert.equal(requirementUrl('https://isokron.ai/mws', 'MWS-CONC-2'), 'https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-2');
  assert.equal(requirementUrl('https://isokron.ai/mws#old', 'MWS-CONC-2'), 'https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-2');
});

test('link tags: a URL the caller gives is used as given', () => {
  assert.equal(requirementUrl('https://example.org/spec', 'MWS-IN-1'), 'https://example.org/spec#mws-in-1');
  assert.equal(requirementUrl('https://isokron.ai/mws?utm_source=mine&utm_medium=x', 'MWS-IN-1'), 'https://isokron.ai/mws?utm_source=mine&utm_medium=x#mws-in-1');
});
