// The skips of one writecheck item, each with the fault side tool-qa's ingest records (worker-kit/contract.mjs
// SKIP_FAULTS, R-COV-01 there): `tool` (our own limit: a launch path we do not have yet, our time budget, our harness),
// `subject` (the server itself, shown by its own install output), `infra` (a rate limit or an outage of someone else)
// or `policy` (we chose not to run it). Every skip says its fault (R-WC-24): left out, ingest would record the reason's
// default, which is "unknown" for no_runnable_artifact, timeout_start and install_failed_registry, counted with ours
// but never said to be ours.
//
// A subject is put down as at fault only with evidence our own environment cannot explain: a package-level error in
// its own install output (no such package or version, no bin). Anything else that stops an install (our proxy refused
// a host, our time or memory limit, a native build in our image) is ours.
//
// Only Node's standard library.

/** The fault of each skip reason this worker emits where the reason alone decides it. */
export const REASON_FAULT = Object.freeze({
  // The subject is not in the seed this lane reads, or names a fixture it is not: we chose not to run it.
  policy_excluded: 'policy',
  // No package of a kind this lane installs (OCI images, crates, MCPB, NuGet): our limit, never the server's.
  no_runnable_artifact: 'tool',
  // The server is offered over streamable HTTP only, or (a fixture's init) started over HTTP: this lane starts stdio.
  unsupported_transport: 'tool',
  // The sandbox evidence was incomplete: a container left no syscall trace, the firewall log was unreadable.
  trace_unavailable: 'tool',
  // Our harness failed around the unit (a helper, the proxy, the bridge, Docker): retryable, and ours.
  tool_error: 'tool',
});

/**
 * Package-level errors in an install's own output: the registry has no such package or version, or the package has
 * nothing to run. Only these put an install failure down to the subject.
 */
export const SUBJECT_INSTALL_ERRORS = Object.freeze([
  /npm (?:ERR!|error) code (?:E404|ETARGET|ENOVERSIONS)\b/,
  /\bNo matching distribution found for\b/,
  /\bCould not find a version that satisfies the requirement\b/,
]);

/**
 * The fault of a failed install: `tool` when our proxy refused a host the install asked for, or our time limit or
 * memory limit stopped it; `subject` when its entry step found nothing to run or its output shows a package-level
 * error (SUBJECT_INSTALL_ERRORS); else `tool` (a native build, an engine mismatch, anything without evidence).
 */
export function installFault(inst, logText = '') {
  if (!inst) return 'tool';
  if ((inst.egress ?? []).some((e) => e && e.allowed === false)) return 'tool';
  if (inst.timed_out) return 'tool';
  const failed = (inst.steps ?? []).find((s) => s.exit !== 0) ?? null;
  if (failed && (failed.timed_out || failed.exit === 124 || failed.exit === 137)) return 'tool';
  // The entry helper ran and the package declares no bin it could start (msc sandbox/npm-entry.mjs).
  if (failed === null && (inst.steps ?? []).some((s) => s.name === 'entry')) return 'subject';
  if (failed && failed.name === 'entry') return 'subject';
  const text = String(logText).slice(-256 * 1024);
  if (SUBJECT_INSTALL_ERRORS.some((re) => re.test(text))) return 'subject';
  return 'tool';
}

/**
 * The skips of one item and the driver's notes on them. Inputs (all optional but `resolved`):
 *   resolved      loop/items.mjs resolveSubject's answer ({ skip } or the launch)
 *   notStarted    the shard used its time budget before the item started
 *   res           the unit's result (run-items.mjs runUnit): { error, install, steps, fullRan }
 *   unit          { init, full } of the unit
 *   stages        which stages ran
 *   evidenceComplete  false when the sandbox evidence is incomplete (the ci lane)
 *   installLog    the install's own output, for installFault
 * Returns { skips, notes } where notes holds skip_detail, init_detail and full_detail for logs/driver.json.
 */
export function itemSkips({ resolved, notStarted = false, res = null, unit = {}, stages = {}, evidenceComplete = true, installLog = '' }) {
  const skips = [];
  const notes = {};
  const add = (stage, reason, fault, extra = {}) => skips.push({ stage, reason, fault, ...extra, evidence: 'logs/driver.json' });
  if (resolved?.skip) {
    const fault = resolved.skip.fault ?? REASON_FAULT[resolved.skip.reason];
    for (const st of ['install', 'init', 'plan', 'catalog']) add(st, resolved.skip.reason, fault, resolved.skip.retryable ? { retryable: true } : {});
    notes.skip_detail = resolved.skip.detail;
    return { skips, notes };
  }
  if (notStarted) {
    // Our shard budget ran out before this item: ours, and it may run in a later shard.
    for (const st of ['install', 'init', 'plan', 'catalog']) add(st, 'timeout_start', 'tool', { retryable: true });
    notes.skip_detail = 'not started: the shard used its time budget first';
    return { skips, notes };
  }
  if (!res) return { skips, notes };
  if (res.error === 'harness') {
    for (const st of ['install', 'init', 'plan', 'catalog'].filter((x) => !stages[x])) add(st, 'tool_error', 'tool', { retryable: true });
  } else if (res.install && !res.install.ok) {
    const reason = res.install.timed_out ? 'timeout_start' : 'install_failed_registry';
    const fault = installFault(res.install, installLog);
    for (const st of ['init', 'plan', 'catalog']) add(st, reason, fault);
  }
  // The stages that did not run are recorded too: init where the fixture's server is not started over stdio, and the
  // full write test wherever it did not start (never for a third-party server; for a fixture, only under the plan hash
  // a person accepted).
  if (res.error !== 'harness' && res.install?.ok) {
    if (!stages.init && unit.init === false) {
      add('init', 'unsupported_transport', 'tool');
      notes.init_detail = 'the fixture server is started over streamable HTTP by its manifest; init drafts from a stdio command';
    }
    if (!res.fullRan) {
      add('full', 'policy_excluded', 'policy');
      notes.full_detail = !unit.full ? 'a third-party server is never given a manifest that writes' : 'the plan hash is not the accepted one (or the plan did not run), so the full write test did not start';
    }
  }
  if (!evidenceComplete) add('catalog', 'trace_unavailable', 'tool');
  return { skips, notes };
}
