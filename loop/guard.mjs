#!/usr/bin/env node
// Kill switch of the writecheck loop worker (.github/workflows/corpus.yml). The same rules
// as isokron-ai/tool-qa's scripts/guard.mjs, read from this repository's (or the organisation's) variables:
//
//   LOOP_ENABLED              must be exactly "true", or the worker does nothing.
//   LOOP_PAUSE_UNTIL          optional ISO 8601 time; the worker does nothing until then. A value that cannot be
//                             read also stops it (fail safe).
//   LANE_WRITECHECK_ENABLED   optional per-lane switch; set and not "true" stops the lane. Unset or empty leaves it on.
//
//   node loop/guard.mjs [--lane writecheck]
//
// Writes proceed=true|false and reason=<code> to $GITHUB_OUTPUT (or prints them). A stopped worker exits 0, so a
// paused loop never shows as a failed run. When the worker may proceed, WORKER_KIT_REF must be a full commit SHA of
// isokron-ai/tool-qa and SANDBOX_REF one of isokron-ai/mcp-surface-corpus, neither the all-zero placeholder: otherwise
// the run fails here, before anything is read, with the reason. Exit 2 on a usage error. No imports beyond Node's own: the guard job checks out this file alone.
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER_REF = '0'.repeat(40);
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** An ISO 8601 time in ms, NaN when it cannot be read. A date alone means 00:00 UTC. */
export function parseIsoTime(raw) {
  const m = ISO_RE.exec(String(raw ?? '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(Number(y), month, 0)).getUTCDate()) return NaN;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return NaN;
  return Date.parse(String(raw).trim());
}

/** LANE_<LANE>_ENABLED for a lane name: writecheck -> LANE_WRITECHECK_ENABLED. */
export const laneVariable = (lane) => 'LANE_' + String(lane).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_ENABLED';

/** { proceed, reason } for the environment. reason: enabled, loop_disabled, paused, pause_unreadable, lane_disabled. */
export function evaluateGuard(env, { lane = 'writecheck', now = Date.now() } = {}) {
  if (env.LOOP_ENABLED !== 'true') return { proceed: false, reason: 'loop_disabled' };
  const pause = String(env.LOOP_PAUSE_UNTIL ?? '').trim();
  if (pause) {
    const until = parseIsoTime(pause);
    if (Number.isNaN(until)) return { proceed: false, reason: 'pause_unreadable' };
    if (until > now) return { proceed: false, reason: 'paused' };
  }
  const laneSwitch = String(env[laneVariable(lane)] ?? '').trim();
  if (laneSwitch && laneSwitch !== 'true') return { proceed: false, reason: 'lane_disabled' };
  return { proceed: true, reason: 'enabled' };
}

/** null when `ref` names a commit, else why not. */
export function refProblem(name, ref, repo) {
  if (!/^[0-9a-f]{40}$/.test(String(ref ?? ''))) return `${name} must be a full 40-character commit SHA of ${repo}`;
  if (ref === PLACEHOLDER_REF) return `${name} is still the all-zero placeholder: pin it to a commit of ${repo} first`;
  return null;
}
export const kitRefProblem = (ref) => refProblem('WORKER_KIT_REF', ref, 'isokron-ai/tool-qa');

export function main(argv, env, { out = process.stdout, now = Date.now() } = {}) {
  let lane = 'writecheck';
  if (argv.length === 2 && argv[0] === '--lane' && /^[a-z][a-z0-9-]{0,63}$/.test(argv[1])) lane = argv[1];
  else if (argv.length) { out.write('usage: node loop/guard.mjs [--lane <name>]\n'); return 2; }
  const g = evaluateGuard(env, { lane, now });
  const lines = 'proceed=' + g.proceed + '\nreason=' + g.reason + '\n';
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines); else out.write(lines);
  if (!g.proceed) { out.write('::notice title=' + lane + '::the loop is off for this lane (' + g.reason + '); nothing is read\n'); return 0; }
  const why = kitRefProblem(env.WORKER_KIT_REF) ?? refProblem('SANDBOX_REF', env.SANDBOX_REF, 'isokron-ai/mcp-surface-corpus');
  if (why) { out.write('::error title=' + lane + '::' + why + ' (loop/README.md)\n'); return 1; }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
