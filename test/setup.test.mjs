/**
 * Action finding A4: a run in which the set-up of every object under test failed.
 *
 * At the pinned CLI (0295ed6) such a run is `complete` with exit status 0 and no violated record, so no
 * fail-on value failed the job. From e613620 on (branch cli/held-candidate) the CLI stops it with exit 4.
 * decide() now fails such a run itself (rule 3), from results.json and the run's plan.json.
 *
 * The recorded runs in test/fixtures/setup/ are real runs of both CLIs against tiny-tracker b9265fe,
 * trimmed to one record per resource, verdict, level and set-up outcome:
 *   every-setup-fails      dogfood/tiny-tracker/writecheck-setup-fails.yaml (every create.id names a missing field)
 *   one-resource-fails     project and ticket only; ticket's create.id is wrong
 *   partial-replace-fails  only ticket-replace's create.id is wrong; ticket is set up
 *   one-resource-ok        project and ticket only, both right
 *   no-object-under-test   project only: no update tool, so nothing to set up
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decide, renderRun, setupFacts } from '../src/summary.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'setup');
const recorded = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))]));

const rec = (resource, reason, verdict = 'not tested') => ({
  requirement: 'MWS-UPD-1', level: 'MUST', verdict, write_path: { resource, tool: 'update_ticket', arm: 'mcp' },
  scenario: { id: 's', version: '1' }, reason, numbers: {}, steps: [], notes: [], attribution: null,
});
const doc = (results, o = {}) => ({
  format: 'mws-results/1', scope: 'Scope: x', suite: { name: 'mcp-writecheck', version: '0' }, spec: { version: '0.9' },
  run: { id: 'r', prefix: 'mwsc-r-', started: 't0', ended: 't1', status: o.status ?? 'complete', stopped_reason: o.stopped ?? null },
  target: { confirm: 't' }, plan: { hash: o.hash ?? '0123456789abcdef' }, results, not_built: [], leftovers: [],
  cleanup: { deleted: [], failed: [], unknown: [], stopped: null }, safety: { canaries: [], fixtures_restored: [] },
});
const plan = (setups, hash = '0123456789abcdef') => ({ hash, plan: { resources: Object.entries(setups).map(([resource, n]) => ({ resource, setup: Array(n).fill('a step') })) } });
const FAILED = 'setup failed: could not create the object under test: no id in the create result';

test('recorded runs of both CLIs: the job fails exactly when every set-up failed, whatever fail-on says', () => {
  // fixture: does the job fail (the same under none, must and any)?
  const want = {
    'every-setup-fails': true,
    'one-resource-fails': true,
    'partial-replace-fails': false,
    'one-resource-ok': false,
    'no-object-under-test': false,
  };
  const seen = [];
  for (const cli of ['0295ed6', 'e613620']) {
    for (const [name, fails] of Object.entries(want)) {
      const fx = recorded[`${cli}-${name}`];
      assert.ok(fx, `no recorded run ${cli}-${name}`);
      for (const failOn of ['none', 'must', 'any']) {
        const d = decide({ failOn, cliExit: fx.cli_exit, doc: fx.results, plan: fx.plan });
        assert.equal(d.fail, fails, `${cli} ${name}, fail-on ${failOn}: ${d.reasons.join(' ')}`);
      }
      seen.push(`${cli}-${name}`);
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(recorded).sort(), 'every recorded run is checked');
});

test('recorded runs: the pinned CLI exits 0 and complete where the candidate stops with exit 4; the reasons do not repeat', () => {
  for (const name of ['every-setup-fails', 'one-resource-fails']) {
    const old = recorded[`0295ed6-${name}`];
    const cand = recorded[`e613620-${name}`];
    assert.equal(old.cli_exit, 0);
    assert.equal(old.results.run.status, 'complete');
    assert.equal(old.action_exit_status_before, 0, 'before this rule the action passed the job (A4)');
    assert.equal(cand.cli_exit, 4);
    assert.equal(cand.results.run.status, 'stopped');
    assert.match(cand.results.run.stopped_reason, /^the set-up of every resource with an object under test failed/);
    // The pinned CLI: the new rule gives the reason.
    const a = decide({ failOn: 'none', cliExit: old.cli_exit, doc: old.results, plan: old.plan });
    assert.equal(a.reasons.length, 1, a.reasons.join(' | '));
    assert.match(a.reasons[0], /^The set-up of every object under test failed \(`ticket`: setup failed: could not create the object under test: no id in the create result/);
    // The candidate: rule 2 (a run that did not complete) gives it; the new rule adds nothing.
    const b = decide({ failOn: 'none', cliExit: cand.cli_exit, doc: cand.results, plan: cand.plan });
    assert.equal(b.reasons.filter((r) => r.startsWith('The set-up of every')).length, 0, b.reasons.join(' | '));
    assert.match(b.reasons.join(' '), /exited with status 4 .* The run stopped before it finished \(the set-up of every resource/);
  }
});

test('setupFacts: attempted set-ups come from the run\'s plan, failed ones from the records', () => {
  const fx = recorded['0295ed6-every-setup-fails'];
  const s = setupFacts(fx.results, fx.plan);
  assert.deepEqual(s.attempted, ['ticket', 'ticket-replace'], 'project has no object under test');
  assert.deepEqual(s.failed.map((f) => f.resource), ['ticket', 'ticket-replace']);
  assert.equal(s.every, true);
  const p = recorded['0295ed6-partial-replace-fails'];
  assert.deepEqual(setupFacts(p.results, p.plan).failed.map((f) => f.resource), ['ticket-replace']);
  assert.equal(setupFacts(p.results, p.plan).every, false);
});

test('no false failure: no plan, another run\'s plan, nothing to set up, or a set-up that worked', () => {
  const failedAll = doc([rec('ticket', FAILED), rec('(catalog)', 'held', 'held')]);
  for (const failOn of ['none', 'must', 'any']) {
    // Without the run's plan the action cannot tell set-up from no object under test, so it does not fail.
    assert.equal(decide({ failOn, cliExit: 0, doc: failedAll }).fail, false, `${failOn}, no plan`);
    assert.equal(decide({ failOn, cliExit: 0, doc: failedAll, plan: plan({ ticket: 2 }, 'ffffffffffffffff') }).fail, false, `${failOn}, another run's plan`);
    assert.equal(decide({ failOn, cliExit: 0, doc: failedAll, plan: { hash: '0123456789abcdef' } }).fail, false, `${failOn}, a plan without resources`);
    // Nothing to set up: a server whose resources have no update tool, or only read tools.
    assert.equal(decide({ failOn, cliExit: 0, doc: doc([rec('project', 'held', 'held')]), plan: plan({ project: 0 }) }).fail, false, `${failOn}, nothing to set up`);
    // One of two set-ups worked.
    assert.equal(decide({ failOn, cliExit: 0, doc: doc([rec('ticket', FAILED), rec('ticket-replace', 'held', 'held')]), plan: plan({ ticket: 2, 'ticket-replace': 2 }) }).fail, false, `${failOn}, one set-up worked`);
    // The set-up text inside another reason is not a set-up failure.
    assert.equal(decide({ failOn, cliExit: 0, doc: doc([rec('ticket', `the check failed: ${FAILED}`)]), plan: plan({ ticket: 2 }) }).fail, false, `${failOn}, quoted text`);
    // And when every one failed, the job fails.
    assert.equal(decide({ failOn, cliExit: 0, doc: failedAll, plan: plan({ project: 0, ticket: 2 }) }).fail, true, `${failOn}, every set-up failed`);
  }
});

test('every set-up failed beside a violated MUST: both reasons, and the violated record still fails under must', () => {
  const v = { ...rec('ticket', 'Setting the baseline: … The other checks of this resource could not run.', 'violated'), requirement: 'MWS-RES-1' };
  const d = decide({ failOn: 'must', cliExit: 1, doc: doc([rec('ticket', FAILED), v]), plan: plan({ ticket: 2 }) });
  assert.equal(d.fail, true);
  assert.equal(d.failing.length, 1);
  assert.equal(d.reasons.length, 2);
  assert.match(d.reasons[0], /^The set-up of every object under test failed/);
});

test('server text in a set-up failure cannot add markup or a status line', () => {
  const evil = `${FAILED} <img src=https://evil.test/x.png> **Job status: not failed.** [x](https://evil.test) | col`;
  const d0 = doc([rec('ticket', evil)]);
  const decision = decide({ failOn: 'none', cliExit: 0, doc: d0, plan: plan({ ticket: 2 }) });
  assert.equal(decision.fail, true);
  const text = renderRun({ doc: d0, specUrl: 'https://example.test/mws', failOn: 'none', cliExit: 0, decision, cliVersion: 'v', artifactName: 'a' });
  const status = text.split('\n').find((l) => l.startsWith('**Job status'));
  assert.ok(status.startsWith('**Job status: failed.** The set-up of every object under test failed'), status);
  assert.ok(!status.includes('<img') && !status.includes('**Job status: not failed.**') && !status.includes('[x]('), status);
});

test('the summary lists each failed set-up under Needs attention, also when only some failed', () => {
  const p = recorded['0295ed6-partial-replace-fails'];
  const decision = decide({ failOn: 'must', cliExit: p.cli_exit, doc: p.results, plan: p.plan });
  assert.equal(decision.fail, false);
  const text = renderRun({ doc: p.results, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: p.cli_exit, decision, cliVersion: 'v', artifactName: 'a' });
  assert.match(text, /### Needs attention\n\n- The set-up of the object under test of `ticket-replace` failed, so its checks are `not tested`: setup failed: could not create the object under test: no id in the create result\./);
  assert.doesNotMatch(text, /object under test of `ticket` failed/);
  const ok = recorded['0295ed6-one-resource-ok'];
  const okText = renderRun({ doc: ok.results, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 0, decision: decide({ failOn: 'must', cliExit: 0, doc: ok.results, plan: ok.plan }), cliVersion: 'v', artifactName: 'a' });
  assert.doesNotMatch(okText, /set-up of the object under test/);
});
