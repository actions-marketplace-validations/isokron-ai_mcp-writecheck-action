// The skips of one writecheck item, each with the fault side tool-qa's ingest records (worker-kit/contract.mjs
// SKIP_FAULTS, R-COV-01 there): `tool` (our own limit: a launch path we do not have yet, our time budget, our harness),
// `subject` (the server itself, shown by its own install output), `infra` (a rate limit or an outage of someone else)
// or `policy` (we chose not to run it). Every skip says its fault (R-WC-24): left out, ingest would record the reason's
// default, which is "unknown" for no_runnable_artifact, timeout_start and install_failed_registry, counted with ours
// but never said to be ours.
//
// A subject is put down as at fault only with evidence our own environment cannot explain: a package-level error in
// its own install output that no code of the package could have printed (no such package or version), or a package
// that declares nothing to run. Anything else that stops an install (our proxy refused a host, our time or memory
// limit, a native build in our image, an entry answer of ours, no evidence) is ours.
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
 * The entry step's own answer, as a code (R-WC-30). msc's sandbox/npm-entry.mjs prints { error: <sentence> } and exits 1;
 * its stdout is kept out of the install log, so the driver passes this code on (run-items.mjs install). Only
 * "declares_no_bin" (no bin field and no main at all, and no bin name asked for) is the package's own lack; a bin of
 * another name (the name comes from our mapping, not from the package), a package.json we could not read, a bin
 * outside the package, any other exit code (125, 126, 127, 139: Docker, the image, a crash) or an answer that does not
 * parse is ours.
 */
export function entryErrorCode(j, exit) {
  if (exit !== 1 && exit !== 0) return 'entry_crashed';
  if (exit === 0) return 'entry_unreadable';
  const e = typeof j?.error === 'string' ? j.error : null;
  if (e === 'the package declares no bin') return 'declares_no_bin';
  if (e === 'the package has no bin of that name') return 'no_bin_of_that_name';
  return 'entry_failed';
}

/** Whose each entry code is: only the package's own lack of anything to run is the subject's. */
export const ENTRY_FAULT = Object.freeze({
  declares_no_bin: 'subject',
});

/** Signs in an install's output that the network, a proxy, or pip's Python-version filter got in the way. */
const PIP_NOT_THE_PACKAGE = /Retrying|Connection|Max retries|Temporary failure|Ignored the following versions|ProxyError|SSLError|timed out|Read timed out|ConnectTimeout|Name or service not known|Could not fetch URL/i;
/** Signs that code of the package (or of a dependency) ran during the pip install: a build backend, setup.py. */
const PIP_CODE_RAN = /Building wheel|Preparing metadata|Getting requirements to build|Running setup\.py|Installing build dependencies|Building editable/i;
const pipName = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Whether an install's own output proves a package-level error (R-WC-31), read only where no code of the package could
 * have written it:
 *   npm, with install scripts off only: the final error block npm printed (the last contiguous run of "npm error" lines)
 *     carries code E404, ETARGET or ENOVERSIONS. With scripts on, a lifecycle script could print anything: no evidence.
 *   PyPI: pip says "(from versions: none)" and "No matching distribution found for <the package itself>", no build of
 *     anything ran, and nothing shows the network, the proxy or a Python-version filter in the way.
 */
export function packageErrorShown(inst, logText) {
  const text = String(logText ?? '').slice(-256 * 1024);
  if (inst?.kind === 'npm') {
    if (inst.scripts !== false) return false;
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
    const isErr = (l) => /^npm (?:ERR!|error) /.test(l);
    let last = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (isErr(lines[i])) { last = i; break; }
    if (last < 0) return false;
    let first = last;
    while (first > 0 && isErr(lines[first - 1])) first--;
    // Nothing npm printed after its error block.
    if (lines.slice(last + 1).some((l) => /^npm /.test(l))) return false;
    return lines.slice(first, last + 1).some((l) => /^npm (?:ERR!|error) code (?:E404|ETARGET|ENOVERSIONS)$/.test(l));
  }
  if (inst?.kind === 'pypi') {
    if (PIP_NOT_THE_PACKAGE.test(text) || PIP_CODE_RAN.test(text)) return false;
    const m = /^ERROR: No matching distribution found for ([A-Za-z0-9._-]+)\s*$/m.exec(text);
    if (!m || !inst.package || pipName(m[1]) !== pipName(inst.package)) return false;
    return new RegExp(`^ERROR: Could not find a version that satisfies the requirement ${m[1].replace(/[.]/g, '\\.')} \\(from versions: none\\)\\s*$`, 'm').test(text);
  }
  return false;
}

/**
 * The fault of a failed install: `subject` only for the package's own lack (ENTRY_FAULT) or a package-level error its
 * output proves (packageErrorShown); everything else is `tool`: our proxy refusing a host, our time or memory limit,
 * a container that died, a native build, an entry answer of ours, and any failure without evidence (R-WC-26, R-WC-30,
 * R-WC-31).
 */
export function installFault(inst, logText = '') {
  if (!inst) return 'tool';
  if ((inst.egress ?? []).some((e) => e && e.allowed === false)) return 'tool';
  if (inst.timed_out) return 'tool';
  const failed = (inst.steps ?? []).find((s) => s.exit !== 0) ?? null;
  if (failed && (failed.timed_out || failed.exit === 124 || failed.exit === 137)) return 'tool';
  if (inst.entry_error) return ENTRY_FAULT[inst.entry_error] ?? 'tool';
  if (!failed || failed.name !== 'install') return 'tool';
  return packageErrorShown(inst, logText) ? 'subject' : 'tool';
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
