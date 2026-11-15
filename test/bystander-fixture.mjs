#!/usr/bin/env node
/**
 * A test environment in which a run of mcp-writecheck loses objects it did not create, for the
 * local test of the action. tiny-tracker cannot produce one: its selector tool stays inside the
 * project it is given, and the CLI's loader refuses a selector not bound to the tester's own
 * container. The CLI's own regression suite has such a server (case S1 of
 * test/regression/safety-169b0cb.test.ts); this script starts it outside the test runner.
 *
 *   node test/bystander-fixture.mjs <built packages/writecheck> <out dir>
 *
 * It starts the fixture backend, seeds two tickets the tester did not create (B1, B2) in the
 * default project `inbox`, writes <out dir>/bystander.yaml, prints one JSON line
 * { manifest, confirm, env } and waits. On SIGTERM it writes <out dir>/bystander-left.json (the
 * bystanders still in the backend, the ground truth) and exits.
 *
 * The server deletes the default project's tickets when the selector is omitted
 * (empty-selector-matches-all, empty-falls-to-default). The manifest opts in to the empty forms
 * (selector.send_empty_forms), as a manifest may only for a disposable backend; this one lives in
 * memory and ends with the script.
 *
 * It needs the CLI's compiled tests (dist/test/regression), which `npm run build` produces in a
 * checkout of the CLI. It is a test aid only; the action does not use it.
 */

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [cliDir, outDir] = process.argv.slice(2);
if (!cliDir || !outDir) {
  process.stderr.write('usage: bystander-fixture.mjs <built packages/writecheck> <out dir>\n');
  process.exit(2);
}
const reg = (f) => import(pathToFileURL(join(resolve(cliDir), 'dist', 'test', 'regression', f)).href);
const { ShapeBackend } = await reg('backend.js');
const { head, TRACKER_GUARD, CONFIRM } = await reg('harness.js');
const { PROJECT, PATCH_UPDATE, ASSIGNEE_STATUS, ticket } = await reg('tracker-fixture.js');

const BYSTANDERS = ['B1', 'B2'];
const backend = new ShapeBackend({});
const url = await backend.start();
for (const id of BYSTANDERS) backend.seed('tickets', { id, scope: 'inbox', title: `customer ticket ${id}`, status: 'open', assignee: 'carol', priority: 2, note: null, paused: false, labels: [], meta: {} });

// The manifest of case S1, with the opt-in.
const manifest = `${head({ guard: TRACKER_GUARD })}
resources:
${PROJECT}${ticket({
  scope: true,
  update: PATCH_UPDATE,
  fields: ASSIGNEE_STATUS,
  extra: `    selector:
      tool: tickets_delete
      args: { project: "{{scope}}" }
      narrow: { title_prefix: "{{marker}}" }
      send_empty_forms: true
      forms:
        - { name: omitted, args: {} }
        - { name: empty, args: { title_prefix: "" } }
`,
})}`;
const manifestPath = join(resolve(outDir), 'bystander.yaml');
writeFileSync(manifestPath, manifest);

const env = { SHAPE_URL: url, SHAPE_PROFILE: 'tracker', SHAPE_OPTS: 'empty-selector-matches-all,empty-falls-to-default', SHAPE_CALL_LOG: join(resolve(outDir), 'bystander-calls.jsonl') };
process.stdout.write(JSON.stringify({ manifest: manifestPath, confirm: CONFIRM, env }) + '\n');

const stop = async () => {
  const left = backend.all('tickets').filter((t) => BYSTANDERS.includes(String(t.id))).map((t) => String(t.id));
  writeFileSync(join(resolve(outDir), 'bystander-left.json'), JSON.stringify({ seeded: BYSTANDERS, left }) + '\n');
  await backend.stop();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
