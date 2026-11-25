#!/usr/bin/env node
/**
 * The pull-request proof of the writecheck lane (.github/workflows/loop-fixture.yml): judges each item's bundle,
 * as the worker-kit built it in a dry run (the unencrypted tar), with tool-qa's own ingest code at the pinned
 * commit (ingest/analyze.mjs analyzeBundle: manifest, identity, files, identity claims, controls and the forgery
 * checks, the field registry at its pinned sha256, the secret scan), then checks what each fixture item must show.
 *
 *   node loop/check-bundles.mjs --toolqa <tool-qa checkout> --out <driver out dir>
 *   env: ATTEMPT_ID, ITEMS (the shard's items), BUNDLE_<i> (the dry run's bundle-path for item i),
 *        GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_WORKFLOW_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT
 *
 * Expectations by subject: every bundle accepted; tiny-tracker (isokron-ai/mcp-write-safety) with its catalog
 * read, its plan hash the accepted one, and the full write test run to completion; kronicle-lite the same, built
 * from source in the build image with install egress to registry.npmjs.org only; pg-tracker (this repository's
 * PostgreSQL fixture) the same with every full-run result labelled hermetic; a subject with no npm or PyPI package with its skips recorded. Prints one line per check; exits 1 on the
 * first item that does not meet them (all items are still printed).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseItems } from './items.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const toolqa = resolve(opt('--toolqa') ?? 'toolqa-ingest');
const imp = (p) => import(pathToFileURL(join(toolqa, p)).href);
const { analyzeBundle } = await imp('ingest/analyze.mjs');
const { loadRegistry } = await imp('ingest/registry.mjs');
const { readTar } = await imp('worker-kit/tar.mjs');

const env = process.env;
const items = parseItems(env.ITEMS);
const registry = await loadRegistry();
const ref = env.GITHUB_WORKFLOW_REF ?? '';
const full = ref.slice(0, ref.lastIndexOf('@'));
const workflowFile = full.slice(String(env.GITHUB_REPOSITORY).length + 1);

const EXPECT = {
  'isokron-ai/mcp-write-safety': (r) => [
    ['catalog read', r.catalog?.found === true && r.catalog.tool_count >= 10],
    ['plan hash is the accepted one', r.plan?.hash !== null && r.plan?.drift === false],
    ['full write test ran to completion', r.full?.ran === true && r.full?.status === 'complete'],
  ],
  // WC12: the PostgreSQL fixture. The clean build, so no violated record at all; every result labelled hermetic.
  'isokron-ai/mcp-writecheck-action': (r, d, files) => {
    const obs = String(files.get('observations/writecheck.ndjson') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const cov = obs.find((o) => o.field === 'observation_coverage')?.value;
    const verdicts = obs.filter((o) => o.field === 'requirement_verdicts' && o.stage === 'full').flatMap((o) => o.value ?? []);
    const held = (req) => r.full?.verdicts?.some((x) => x.requirement === req && x.verdict === 'held');
    return [
      ['catalog read', r.catalog?.found === true && r.catalog.tool_count >= 8],
      ['plan hash is the accepted one', r.plan?.hash !== null && r.plan?.drift === false],
      ['full write test ran to completion', r.full?.ran === true && r.full?.status === 'complete'],
      ['no violated record in the clean build', r.full?.verdicts?.every((x) => x.verdict !== 'violated') === true],
      ['the PostgreSQL cells held (CONC-2, TGT-2, RETRY-2, UPD-1)', ['MWS-CONC-2', 'MWS-TGT-2', 'MWS-RETRY-2', 'MWS-UPD-1'].every(held)],
      ['installed in the build image, egress to registry.npmjs.org only', d?.install?.image === 'node24-build' && JSON.stringify(d?.install?.egress_hosts) === '["registry.npmjs.org"]' && d?.install?.egress_refused === 0],
      ['every full-run result is labelled hermetic (PostgreSQL)', cov?.backend_environment === 'hermetic' && cov?.backend_kind === 'postgresql' && verdicts.length > 0 && verdicts.every((x) => x.backend_environment === 'hermetic')],
    ];
  },
  'isokron-ai/kronicle-lite': (r, d) => [
    ['catalog read', r.catalog?.found === true && r.catalog.tool_count >= 1],
    ['plan hash is the accepted one', r.plan?.hash !== null && r.plan?.drift === false],
    ['full write test ran to completion', r.full?.ran === true && r.full?.status === 'complete'],
    // R-WC-09: better-sqlite3 built from source in the build image; the install reached registry.npmjs.org only.
    ['installed in the build image', d?.install?.image === 'node24-build'],
    ['install egress to registry.npmjs.org only', JSON.stringify(d?.install?.egress_hosts) === '["registry.npmjs.org"]' && d?.install?.egress_refused === 0],
  ],
};

let failed = 0;
for (const it of items) {
  const path = env[`BUNDLE_${it.index}`];
  const say = (ok, what) => { console.log(`item ${it.index} (${it.subject}): ${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };
  if (!path) { say(false, 'no bundle was built'); continue; }
  const plaintext = readFileSync(path);
  const exp = {
    attempt_id: env.ATTEMPT_ID, fence: it.fence, run_key: it.run_key, repo: env.GITHUB_REPOSITORY, workflow_file: workflowFile,
    workflow_sha: env.GITHUB_WORKFLOW_SHA, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
  const v = analyzeBundle(plaintext, { exp, registry });
  say(v.outcome === 'accepted', `ingest outcome ${v.outcome}${v.reason ? ` (${v.reason})` : ''}`);
  if (v.outcome !== 'accepted') console.log(JSON.stringify(v.problems ?? [], null, 1).slice(0, 4000));
  const files = new Map(readTar(plaintext).map((e) => [e.path, e.data]));
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  say(manifest.controls.length === 3 && manifest.controls.every((c) => c.observed === c.expected), `controls ${manifest.controls.map((c) => `${c.kind}=${c.observed}`).join(', ')}`);
  const res = files.get('results/writecheck.json');
  if (res) {
    const r = JSON.parse(res.toString('utf8'));
    console.log(`item ${it.index}: package ${r.package} ${r.resolved_version ?? ''}; steps ${r.steps.map((s) => `${s.step}=${s.exit}`).join(' ')}; catalog ${r.catalog.found ? `${r.catalog.tool_count} tools` : r.catalog.why}; plan ${r.plan.hash ?? '-'}${r.plan.drift ? ' (drift)' : ''}; full ${r.full.ran ? r.full.status : 'not run'}`);
    const d = files.get('logs/driver.json') ? JSON.parse(files.get('logs/driver.json').toString('utf8')) : null;
    if (d?.install) console.log(`item ${it.index}: install in ${d.install.image}, ${d.install.steps.map((s) => `${s.name}=${s.exit} ${s.ms} ms`).join(', ')}; egress ${JSON.stringify(d.install.egress_hosts)}`);
    for (const [what, ok] of (EXPECT[it.subject.toLowerCase()] ?? (() => []))(r, d, files)) say(ok, what);
  } else {
    say(manifest.skips.length > 0, `no results; skips ${manifest.skips.map((s) => `${s.stage}:${s.reason}`).join(', ')}`);
  }
  console.log(`item ${it.index}: ${manifest.files.length} files, observations ${v.report?.observations?.records ?? '-'} records`);
}
if (failed) { console.log(`::error title=loop-fixture::${failed} check(s) failed`); process.exitCode = 1; }
else console.log('every item meets its expectations');
