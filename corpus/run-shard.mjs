#!/usr/bin/env node
/**
 * Third-party corpus driver: runs mcp-writecheck against one shard of the corpus target list.
 * The same script runs in the public corpus workflow (dispatched in batches) (lane `ci`) and on IsoKron's own machine for
 * the long tail (lane `mac`), and writes the same record format in both places.
 *
 *   node corpus/run-shard.mjs --targets T.json --cli DIR --out DIR [--work DIR] [--lane ci|mac]
 *                             [--shard N --shards M] [--only ID,ID] [--cli-commit SHA]
 *                             [--consume-targets] [--images corpus/images.json] [--spec FILE]
 *
 * Isolation (every target is untrusted). No target code runs on the host. Each target's install,
 * set-up, CLI and server run in containers of a digest-pinned image (corpus/images.json), started
 * with `sandboxRunArgs`: user 10001, --cap-drop ALL, no-new-privileges, a read-only root, a tmpfs
 * /tmp, pid and memory limits, and only Docker volumes mounted (the target's own work volume, the
 * CLI read-only and the tools read-only). No bind mount of any host path: not the workspace,
 * RUNNER_TEMP, _actions, the home folder or the Docker socket. Install runs on a network with
 * egress; set-up, the CLI and the server run on an --internal network shared only with that
 * target's backends, which are digest-pinned too (backends alone may hold an allowlist of five
 * capabilities, by default all five; see BACKEND_CAPS). A set-up `fetch` step is fetched by our
 * helper on the install network and verified by sha256 before a sandbox container unpacks it with
 * no network. The server's stderr is kept, capped, by our stderr-tee for the encrypted bundle.
 * Outputs leave the work volume through a helper
 * that copies regular files and folders only, under a size cap. The host keeps the clear-text
 * target list, the secrets, the encrypt step and the upload; no container can reach them.
 *
 * Public-output rule (the corpus is not a findings channel): stdout carries only
 *
 *     automated candidate, unreviewed: not a finding
 *     run finished, exit N
 *
 * one "run finished" line per target, with no target name, no verdict and no record line.
 * Everything else (install logs, backend logs, the CLI's own output, the server's output,
 * results.json, report.md, the ledger, metadata) goes to files under --out, which the workflow
 * encrypts to the archive's public key before upload.
 *
 * N is the public exit of that target, never a verdict:
 *     0   the CLI ran to completion (CLI exit 0 or 1: exit 1 is a violated MUST, a verdict, so it
 *         is folded to 0 here; the real exit is in the encrypted metadata)
 *     2, 3, 4, 130   the CLI's own usage/manifest error, refusal, stopped run, interruption
 *     70  the CLI crashed (killed by a signal, or an exit status the CLI does not document)
 *     124 the target hit its time limit
 *     125 harness error (download, checksum, install, backend, set-up, a container that did not
 *         start, this script)
 * A CLI problem already recorded for a target in the list (`expect`) reports 0 and is kept in the
 * metadata as expected_cli_error; any other problem keeps its code.
 * The process exits 0 when every target's public exit is 0, and 1 otherwise: only our tool or
 * the harness turns a run red, never a target's verdict.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Jcs } from './jcs.mjs';
import { checkListedUrl } from './sandbox/fetch.mjs';

export const LABEL = 'automated candidate, unreviewed: not a finding';
export const RUN_FORMAT = 'isokron-corpus-run/3';
export const TARGETS_FORMAT = 'isokron-corpus-targets/2';
export const SANDBOX_USER = '10001:10001';
const CLI_DOCUMENTED = new Set([0, 1, 2, 3, 4, 130]);
/** `docker run` itself failed (daemon error, command not found or not executable). */
const DOCKER_RUN_FAILED = new Set([125, 126, 127]);
const say = (line) => process.stdout.write(`${line}\n`);
const here = dirname(fileURLToPath(import.meta.url));

/** In-container paths. /work is the target's own volume; /opt/mwsc and /opt/tools are read-only. */
export const P = { work: '/work', out: '/work/out', cli: '/opt/mwsc', tools: '/opt/tools', home: '/work/home', clean: '/clean' };
export const CLI_MAIN = `${P.cli}/dist/src/cli/main.js`;
/** Our own in-container helpers (corpus/sandbox/), read-only beside the CLI. Never target code. */
export const SANDBOX_TOOLS = `${P.cli}/_corpus`;
/**
 * CORPUS_INSTALL_CA_FILE (a machine behind a TLS-inspecting proxy; never set on CI): the CA, written once at shard set-up
 * into the CLI volume, which every target container mounts read-only, so no target code can alter it.
 */
export const INSTALL_CA = `${P.cli}/_corpus-ca/install-ca.pem`;
/** Where the server's stderr is kept (inside /work/out: copied out into the encrypted bundle only). */
export const STDERR_DIR = `${P.out}/server-stderr`;
/** Bytes of the server's stderr kept per server process (at most 16 processes per target). */
const STDERR_CAP = Number(process.env.CORPUS_STDERR_CAP || 4 * 1024 * 1024);
/**
 * Capabilities a backend may ask for (`backends[].cap_add` in the target list); everything else
 * stays dropped, and anything else in the list is refused when the list is loaded. Backends only:
 * containers that run target code (install, set-up, the CLI and the server under test) get none.
 */
export const BACKEND_CAPS = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']);
/**
 * A backend without `cap_add` gets exactly these: what the official database images (postgres,
 * redis, mongo, ...) need to take ownership of their data folder as root and then drop to their own
 * user. With `--cap-drop ALL` and none of them they exit at once (setresuid: Operation not permitted).
 */
export const BACKEND_DEFAULT_CAPS = Object.freeze(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']);
/** Size cap for what one target's outputs may bring back to the host (bytes of tar). */
const COPY_OUT_CAP = Number(process.env.CORPUS_COPY_OUT_CAP || 1024 * 1024 * 1024);
/** Time limit of the copy-out helper. */
const COPY_OUT_MS = 600_000;
/** Per command: log bytes kept on the host, and stdout bytes kept in memory. Output past either is dropped. */
const LOG_CAP = Number(process.env.CORPUS_LOG_CAP || 64 * 1024 * 1024);
const BUF_CAP = Number(process.env.CORPUS_BUF_CAP || 16 * 1024 * 1024);
/** results.json larger than this is recorded by size only, never read into memory. */
const JSON_CAP = Number(process.env.CORPUS_JSON_CAP || 32 * 1024 * 1024);
/** results.json folders recorded per target at most (the folder names are target-writable). */
const RESULTS_MAX = 200;
/** Size cap of one set-up `fetch` tarball. */
const FETCH_CAP = Number(process.env.CORPUS_FETCH_CAP || 256 * 1024 * 1024);
if (!(Number.isSafeInteger(FETCH_CAP) && FETCH_CAP > 0)) throw new Error('CORPUS_FETCH_CAP must be a positive whole number of bytes');
/** Top-level names in /work that a set-up `fetch` may not unpack into (ours, or the install's). */
const RESERVED_DEST = new Set(['out', 'home', 'dl', 'pkg', 'venv', 'bin', 'python', 'lock.txt', 'writecheck.yaml', '.fetch']);
/** CPUs per sandbox or backend container (lowered to what the Docker server has). */
export const CPUS = 2;
/** Oldest Docker Engine accepted: before 26.0.0, --internal networks still resolved outside names (CVE-2024-29018). */
export const DOCKER_MIN = [26, 0, 0];
/** The only registry a hash-locked npm dependency may come from. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** The protocol revision the surface probe offers in `initialize` (the CLI's own PROTOCOL_VERSION at main 30fdddb). */
export const SURFACE_PROTOCOL = '2025-11-25';
/** Time limit of the surface probe (initialize and every tools/list page). */
const SURFACE_MS = Number(process.env.CORPUS_SURFACE_MS || 60_000);
/** Time limit of the small informational steps: the version probe, the config-source copy, one snapshot. */
const SMALL_STEP_MS = 120_000;
/** `full.repeats` and `full.timeout_s` bounds: three repeats of two hours fit one CI job (see SHARD_BUDGET_S). */
export const MAX_REPEATS = 5;
export const MAX_FULL_TIMEOUT_S = 7_200;
/** A target's own `timeout_s` (install to catalog) at most. */
export const MAX_TIMEOUT_S = 7_200;
/**
 * Lane ci: the planned time of one shard (the sum of its targets' limits, timeLimits().total_s) may not
 * pass this. The corpus job stops at 360 minutes (`timeout-minutes`, GitHub's hosted maximum); 30 are
 * left for checkout, build, set-up, copy-out, encryption and upload. CORPUS_SHARD_BUDGET_S overrides.
 */
export const SHARD_BUDGET_S = Number(process.env.CORPUS_SHARD_BUDGET_S || 330 * 60);
/**
 * The only ids that may be reused although they are in dropped[] (`reused_by_grandfathered: true`):
 * t08 was given to another package on 16 Nov 2026, the day before the never-reuse rule. No other id
 * may ever carry the flag; a dropped[] entry that does refuses the whole list.
 */
export const GRANDFATHERED_IDS = Object.freeze(['t08']);

/** The public exit of one target (see the header). Pure; unit-tested. */
export function publicExit(t) {
  if (t.status === 'timeout') return 124;
  if (t.status === 'harness_error') return 125;
  if (t.status === 'cli_crash') return 70;
  if (t.status === 'cli_error') return CLI_DOCUMENTED.has(t.cli_exit) ? t.cli_exit : 70;
  return 0; // completed, or expected_cli_error (a known CLI problem recorded in the target list)
}

/**
 * Classify one CLI step: completed (0/1), cli_error (2/3/4/130), cli_crash (signal or undocumented),
 * harness_error (the container did not start: docker run's own 125/126/127).
 */
export function classifyCli(step) {
  if (step.timed_out) return 'timeout';
  if (step.spawn_error) return 'harness_error';
  if (step.signal || step.exit === null) return 'cli_crash';
  if (step.exit === 0 || step.exit === 1) return 'completed';
  if (CLI_DOCUMENTED.has(step.exit)) return 'cli_error';
  if (step.container && DOCKER_RUN_FAILED.has(step.exit)) return 'harness_error';
  return 'cli_crash';
}

/** `{{name}}` templates in strings, arrays and objects. Unknown names are an error (harness). */
export function fill(v, vars) {
  if (typeof v === 'string') {
    return v.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, k) => {
      if (!(k in vars)) throw new HarnessError(`template variable ${k} is not set`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

/**
 * The CLI's own template names (`RESERVED_VARS` in mcp-write-safety packages/writecheck/src/core/manifest.ts).
 * The CLI fills these itself during a run, so the driver never touches them in a manifest.
 */
export const CLI_TEMPLATE_NAMES = Object.freeze(['prefix', 'id', 'field', 'value', 'object', 'version', 'key', 'scope', 'marker', 'ids', 'batch', 'missing_id', 'names_inserted', 'position', 'element_id', 'n']);

/** Names only the driver defines: a manifest that uses one the target does not set is a harness error. */
const DRIVER_NAME = /^(?:tdir|bin|host|pkgdir|host\d+|port\d+)$/;

/**
 * `{{name}}` templates in a hand-written manifest's text. The manifest also carries the CLI's own
 * templates ({{id}}, {{field}}, {{value}}, {{version}}, its `vars`, earlier results), which the CLI
 * renders during the run and which fail loudly there when unknown. So only the driver's names are
 * filled: the backends' hosts and ports, tdir, bin, pkgdir and the set-up captures. A CLI name is
 * never filled, even by a capture of the same name; any other name is left as written for the CLI.
 * A driver name the target does not set (e.g. {{host1}} with one backend) is still a harness error.
 */
export function fillManifest(text, vars) {
  return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (m, k) => {
    if (CLI_TEMPLATE_NAMES.includes(k)) return m;
    if (Object.hasOwn(vars, k)) return String(vars[k]);
    if (DRIVER_NAME.test(k)) throw new HarnessError(`template variable ${k} is not set`);
    return m;
  });
}

/**
 * The server command as the CLI starts it: through our stderr-tee (corpus/sandbox/stderr-tee.mjs),
 * which leaves stdin and stdout alone, forwards stderr to the CLI in full and keeps its first
 * `cap` bytes in STDERR_DIR. `node` resolves to the image's (the target's bin folder is last on PATH).
 */
export function serverWrap(command, cap = STDERR_CAP) {
  return ['node', `${SANDBOX_TOOLS}/stderr-tee.mjs`, STDERR_DIR, String(cap), '--', ...command];
}

/** The generic catalog manifest: the server block and a stub resource (catalog mode calls no tool). */
export function catalogManifest(command, envNames, confirm) {
  const q = (s) => JSON.stringify(s);
  return [
    '# Generated by corpus/run-shard.mjs: catalog and plan only. The stub resource is never called;',
    '# catalog mode reads tools/list and calls no tool. A full run needs a hand-written manifest.',
    'mws: "0.9"',
    'server:',
    `  stdio: [${command.map(q).join(', ')}]`,
    `  env_passthrough: [${envNames.map(q).join(', ')}]`,
    '  processes: separate',
    'target:',
    '  environment: test',
    `  confirm: ${q(confirm)}`,
    'resources:',
    '  - name: catalogstub',
    '    read: { tool: mwsc_catalog_stub, args: { id: "{{id}}" } }',
    '    fixture: { id: mwsc-catalog-stub, name: mwsc-catalog-stub }',
    '    cleanup: leave',
    '',
  ].join('\n');
}

export class HarnessError extends Error {}

const DIGEST_REF = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;
/** An image reference must be pinned by digest. */
export function checkPinned(ref, what) {
  if (typeof ref !== 'string' || !DIGEST_REF.test(ref)) throw new HarnessError(`${what}: image is not pinned by digest`);
  return ref;
}

/** A target id is used in container, volume and network names. */
export function checkId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new HarnessError('target id must match [a-z0-9][a-z0-9-]{0,31}');
  return id;
}

/** `linux-x64` or `linux-arm64`, from `docker version`'s server OS/arch. */
export function platformKey(osArch) {
  const [os, a] = String(osArch).trim().split('/');
  if (os !== 'linux') throw new HarnessError(`containers must be Linux, not ${os}`);
  const m = { amd64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' }[a];
  if (!m) throw new HarnessError(`unsupported container architecture ${a}`);
  return `linux-${m}`;
}

/**
 * The environment of the docker CLI processes this script starts: what docker needs to find its
 * daemon and config, nothing else. No GITHUB_*, no ACTIONS_*, no RUNNER_*, no token.
 */
export function dockerEnvFrom(env) {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];
  return Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/** The environment inside a target container (install, set-up, CLI, server). Fixed, plus `extra`. */
export function sandboxEnv(binDir, extra = {}) {
  return {
    // The target's own bin folder comes last: a package that ships a `node`, `npm`, `uv`, `sh` or `tar`
    // (the npm package `node` does) must not replace the tools that run the CLI and the install.
    PATH: [P.tools, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', binDir].filter(Boolean).join(':'),
    HOME: P.home, TMPDIR: '/tmp', XDG_CACHE_HOME: `${P.home}/.cache`, XDG_CONFIG_HOME: `${P.home}/.config`,
    npm_config_cache: `${P.home}/.npm`, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    UV_CACHE_DIR: `${P.home}/.cache/uv`, UV_PYTHON_INSTALL_DIR: `${P.work}/python`, UV_PYTHON_PREFERENCE: 'only-managed',
    PIP_CACHE_DIR: `${P.home}/.cache/pip`, NO_COLOR: '1', DO_NOT_TRACK: '1', CORPUS_SANDBOX: '1',
    ...extra,
  };
}

/**
 * `docker run` arguments for a container that runs target-controlled code. The flags are fixed here
 * and unit-tested; only volumes (never a bind mount), the network, the env and the command vary.
 */
export function sandboxRunArgs({ name, image, network, mounts, env = {}, labels = {}, workdir = P.work, stdin = false, cpus = CPUS, cmd }) {
  checkPinned(image, 'sandbox');
  const a = [
    'run', '--rm', '--name', name,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--user', SANDBOX_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=1g',
    '--pids-limit', '1024',
    '--memory', '4g', '--memory-swap', '4g',
    '--cpus', String(cpus),
    '--init',
    '--hostname', 'corpus',
    '--network', network,
    '--workdir', workdir,
  ];
  for (const m of mounts) {
    // The clean copy of /work (fresh state between full repeats) is for our helpers only.
    if (m.dst === P.clean) throw new HarnessError('a target container never mounts the clean copy');
    a.push('--mount', volumeMount(m));
  }
  for (const [k, v] of Object.entries(env)) a.push('--env', `${k}=${v}`);
  if (stdin) a.push('--interactive');
  a.push(image, ...cmd);
  return a;
}

/** Only named Docker volumes, by a name this script made; never a host path. */
export function volumeMount({ src, dst, ro = false }) {
  if (!/^corpus-[a-z0-9-]+$/.test(src)) throw new HarnessError('only corpus volumes are mounted');
  if (!/^\/(work|opt\/mwsc|opt\/tools|clean)$/.test(dst)) throw new HarnessError(`unexpected mount point ${dst}`);
  return `type=volume,src=${src},dst=${dst}${ro ? ',readonly' : ''}`;
}

/**
 * The capabilities of one backend: `cap_add` when the entry gives it (a subset of BACKEND_CAPS,
 * `[]` for none), BACKEND_DEFAULT_CAPS when it does not. Anything else is a harness error.
 */
export function backendCaps(b, what = 'backend') {
  if (b?.cap_add === undefined) return [...BACKEND_DEFAULT_CAPS];
  if (!Array.isArray(b.cap_add)) throw new HarnessError(`${what}: cap_add must be a list`);
  const seen = new Set();
  for (const c of b.cap_add) {
    if (typeof c !== 'string' || !BACKEND_CAPS.has(c)) throw new HarnessError(`${what}: capability ${typeof c === 'string' ? c.replace(/[^A-Za-z0-9_]/g, '?').slice(0, 32) : typeof c} is not allowed`);
    if (seen.has(c)) throw new HarnessError(`${what}: capability ${c} is listed twice`);
    seen.add(c);
  }
  return [...b.cap_add];
}

/**
 * Checks of one target entry that need no network and start nothing, run for every entry when the
 * list is loaded: a target that fails them is refused before anything of it is fetched or started.
 */
export function validateTarget(t, dropped = []) {
  checkId(t?.id);
  checkReuse(t.id, dropped);
  if (t.backends !== undefined && !Array.isArray(t.backends)) throw new HarnessError('backends must be a list');
  for (const [i, b] of (t.backends ?? []).entries()) {
    backendCaps(b, `backend ${i}`);
    if (b?.snapshot !== undefined) checkSnapshot(b.snapshot, `backend ${i}`);
  }
  if (t.setup !== undefined && !Array.isArray(t.setup)) throw new HarnessError('setup must be a list');
  for (const [k, s] of (t.setup ?? []).entries()) {
    if (typeof s === 'string') continue;
    checkFetch(s, `set-up ${k}`);
  }
  if (t.canary !== undefined && t.canary !== 'good' && t.canary !== 'bad') throw new HarnessError('canary must be "good" or "bad"');
  if (t.timeout_s !== undefined && !(Number.isInteger(t.timeout_s) && t.timeout_s >= 1 && t.timeout_s <= MAX_TIMEOUT_S)) throw new HarnessError(`timeout_s must be a whole number of seconds from 1 to ${MAX_TIMEOUT_S}`);
  if (t.full !== undefined) checkFull(t.full);
}

/**
 * `backends[].snapshot`: `{ exec: [argv...], user? }`, run with `docker exec` in the backend (like a
 * set-up step) before the first CLI step that writes and after the last; it prints the fixture's
 * state as text. Templates are filled like set-up's.
 */
export function checkSnapshot(s, what = 'backend') {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new HarnessError(`${what}: snapshot is { exec: [...], user? }`);
  for (const k of Object.keys(s)) if (k !== 'exec' && k !== 'user') throw new HarnessError(`${what}: snapshot has an unknown field`);
  if (!Array.isArray(s.exec) || !s.exec.length || s.exec.some((x) => typeof x !== 'string')) throw new HarnessError(`${what}: snapshot.exec must be a non-empty list of strings`);
  if (s.user !== undefined && (typeof s.user !== 'string' || !/^[A-Za-z0-9_.-]{1,32}(:[A-Za-z0-9_.-]{1,32})?$/.test(s.user))) throw new HarnessError(`${what}: snapshot.user`);
  return s;
}

/** `full.repeats` (1 to MAX_REPEATS, default 1) and `full.timeout_s` (seconds per repeat, 1 to MAX_FULL_TIMEOUT_S). */
export function checkFull(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new HarnessError('full must be an object');
  if (f.repeats !== undefined && !(Number.isInteger(f.repeats) && f.repeats >= 1 && f.repeats <= MAX_REPEATS)) throw new HarnessError(`full.repeats must be a whole number from 1 to ${MAX_REPEATS}`);
  if (f.timeout_s !== undefined && !(Number.isInteger(f.timeout_s) && f.timeout_s >= 1 && f.timeout_s <= MAX_FULL_TIMEOUT_S)) throw new HarnessError(`full.timeout_s must be a whole number of seconds from 1 to ${MAX_FULL_TIMEOUT_S}`);
  return f;
}

/**
 * The time limits of one target. `timeout_s` (or the list default, or 600) covers install, backends,
 * set-up and the init, plan and catalog steps. With `full.timeout_s`, each full repeat (its reset,
 * re-plan, snapshots and run) gets that many seconds of its own, so the whole target may take
 * timeout_s + repeats x full.timeout_s; without it, the repeats share what is left of timeout_s.
 */
export function timeLimits(t, defaults = {}) {
  const base = t.timeout_s ?? defaults.timeout_s ?? 600;
  const repeats = t.full?.plan_hash ? (t.full.repeats ?? 1) : 0;
  const full = t.full?.timeout_s ?? null;
  return { base_s: base, full_s: full, repeats, total_s: base + (full ? repeats * full : 0) };
}

/**
 * The list's `dropped[]`: each entry `{ id, dropped_at, reused_by_grandfathered?, ... }`. Checked when
 * the list is loaded; an entry outside this shape refuses the whole list (the never-reuse rule cannot
 * be applied without it). `reused_by_grandfathered: true` is accepted only for an id in
 * GRANDFATHERED_IDS (t08).
 */
export function checkDropped(dropped) {
  if (dropped === undefined) return [];
  if (!Array.isArray(dropped)) throw new HarnessError('dropped must be a list');
  for (const [i, d] of dropped.entries()) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new HarnessError(`dropped ${i}: not an object`);
    try { checkId(d.id); } catch { throw new HarnessError(`dropped ${i}: id must match [a-z0-9][a-z0-9-]{0,31}`); }
    if (typeof d.dropped_at !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(d.dropped_at)) throw new HarnessError(`dropped ${i} (${d.id}): dropped_at must be a date (YYYY-MM-DD or an ISO time)`);
    if (d.reused_by_grandfathered !== undefined && typeof d.reused_by_grandfathered !== 'boolean') throw new HarnessError(`dropped ${i} (${d.id}): reused_by_grandfathered must be true or false`);
    if (d.reused_by_grandfathered === true && !GRANDFATHERED_IDS.includes(d.id)) throw new HarnessError(`dropped ${i} (${d.id}): reused_by_grandfathered is only for ${GRANDFATHERED_IDS.join(', ')}`);
  }
  return dropped;
}

/**
 * Lane ci: the shard's planned time (the targets' timeLimits().total_s, in list order) against
 * SHARD_BUDGET_S. Throws a harness error naming the first target that passes it, so a list cannot plan
 * more than one job allows. Targets already refused at load (`invalid`) cost nothing.
 */
export function checkShardBudget(targets, defaults = {}, invalid = new Map(), budget = SHARD_BUDGET_S) {
  let sum = 0;
  for (const t of targets) {
    if (invalid.has(t.id)) continue;
    const s = timeLimits(t, defaults).total_s;
    if (!Number.isFinite(s) || s < 0) throw new HarnessError(`shard time budget: ${t.id} has no usable time limit`);
    sum += s;
    if (sum > budget) throw new HarnessError(`shard time budget: with ${t.id} this shard plans ${sum} s, over the ${budget} s one job allows (timeout_s + repeats x full.timeout_s)`);
  }
  return sum;
}

/** Never reuse an id: a target whose id was dropped is refused, unless every such entry is grandfathered. */
export function checkReuse(id, dropped = []) {
  const hits = dropped.filter((d) => d?.id === id);
  if (hits.some((d) => d.reused_by_grandfathered !== true)) throw new HarnessError(`id ${id} was dropped and is never reused`);
}

/**
 * List-level checks at load: the format, the targets list, dropped[], and every id's shape (a bad id
 * or dropped[] refuses the whole list). Each entry is then checked on its own: one that fails is
 * returned in `invalid` and refused, and the others run.
 */
export function validateList(list) {
  if (list?.format !== TARGETS_FORMAT) throw new HarnessError('the target list has another format');
  if (!Array.isArray(list.targets)) throw new HarnessError('the target list has no targets');
  const dropped = checkDropped(list.dropped);
  const invalid = new Map();
  for (const t of list.targets) {
    checkId(t?.id); // an id names folders and containers: a bad one refuses the whole list
    try { validateTarget(t, dropped); } catch (e) { invalid.set(t.id, `refused at load: ${e.message}`); }
  }
  return { invalid, dropped };
}

/** `name[:tag]@sha256:<hex>` into its tag part and digest; the digest is null for an unpinned reference. */
export function imageParts(ref) {
  const m = /^(.*)@(sha256:[0-9a-f]{64})$/.exec(String(ref ?? ''));
  return m ? { image_tag: m[1], image_digest: m[2] } : { image_tag: ref ?? null, image_digest: null };
}

/**
 * D5 fresh state, run by our helper as the sandbox user with no network. CLEAN_COPY: /work (read-only)
 * into /clean, without /work/out, after install and before any set-up. RESTORE_WORK: everything in
 * /work but out/ removed, then /clean copied back. tar keeps symlinks and special files as entries
 * (never follows or opens them); a failed create is caught through its status file.
 */
export const CLEAN_COPY = '{ tar -C /work --sparse --exclude=./out -cf - . ; echo $? > /clean/.create-status; } | tar -C /clean -xpf - '
  + '&& [ "$(cat /clean/.create-status)" = 0 ] && rm -f /clean/.create-status';
export const RESTORE_WORK = 'chmod -R u+rwX /work 2>/dev/null; '
  + 'for e in /work/* /work/.[!.]* /work/..?*; do { [ -e "$e" ] || [ -L "$e" ]; } || continue; [ "$e" = /work/out ] && continue; rm -rf "$e" || exit 1; done; '
  + '{ tar -C /clean --sparse -cf - . ; echo $? > /work/out/.restore-status; } | tar -C /work -xpf - '
  + '&& [ "$(cat /work/out/.restore-status)" = 0 ] && rm -f /work/out/.restore-status';

/** The version probe: what `node` and `python3` the server under test would get (the same PATH). */
export const VERSION_PROBE = 'v=$(node -v 2>/dev/null) && echo "node $v" || echo "node -"; '
  + 'if command -v python3 >/dev/null 2>&1; then v=$(python3 -V 2>&1) && echo "python $v" || echo "python -"; else echo "python none"; fi';

/** A version string as recorded: 64 characters at most. */
export const VERSION_STRING = /^v?\d[\w.+-]{0,62}$/;

/** The versions the version probe printed inside the target container (null with a reason otherwise). */
export function envVersions(r) {
  const out = {};
  const text = typeof r?.stdout === 'string' ? r.stdout : '';
  const failed = !r || r.timed_out || r.spawn_error || r.exit !== 0;
  const ran = `the version probe did not run (exit ${r?.exit ?? null}${r?.timed_out ? ', time limit' : ''})`;
  // The probe's container may run target code (a python3 the target ships), so its output is untrusted:
  // a version is kept only when it looks like one, 64 characters at most.
  const node = /^node (\S{1,64})\s*$/m.exec(text);
  out.node_version = node && VERSION_STRING.test(node[1]) ? node[1] : null;
  if (!out.node_version) out.node_version_why = failed ? ran : /^node -$/m.test(text) ? 'node -v failed in the target container' : 'node -v printed nothing recognisable as a version';
  const py = /^python Python (\S{1,64})\s*$/m.exec(text);
  out.python_version = py && VERSION_STRING.test(py[1]) ? py[1] : null;
  if (!out.python_version) out.python_version_why = failed ? ran : /^python none$/m.test(text) ? "python3 is not on the target container's PATH" : /^python -$/m.test(text) ? 'python3 -V failed in the target container' : 'python3 -V printed nothing recognisable as a version';
  return out;
}

const jcsOrWhy = (v) => {
  try { return { hash: sha256Jcs(v) }; } catch (e) { return { hash: null, why: e.message }; }
};

/**
 * surface.json from the probe's (untrusted) output: initialize and tools kept only as JSON objects,
 * the other fields type-checked and bounded. The time of capture is the probe's only when it is an
 * ISO time. Pure; unit-tested.
 */
export function surfaceDoc(p) {
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const transport = isObj(p.transport) ? Object.fromEntries(['stdout_bytes', 'non_json_lines', 'notifications', 'server_requests', 'exit', 'signal', 'over_cap']
    .filter((k) => Object.hasOwn(p.transport, k)).map((k) => { const v = p.transport[k]; return [k, Number.isSafeInteger(v) || typeof v === 'boolean' ? v : typeof v === 'string' ? v.slice(0, 16) : null]; })) : null;
  return {
    initialize: isObj(p.initialize) ? p.initialize : null,
    tools: isObj(p.tools) && Array.isArray(p.tools.tools) ? p.tools : null,
    captured_at: typeof p.captured_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(p.captured_at) ? p.captured_at : new Date().toISOString(),
    protocol_offered: SURFACE_PROTOCOL,
    initialize_error: str(p.initialize_error, 500),
    tools_error: str(p.tools_error, 500),
    pages: Number.isSafeInteger(p.pages) && p.pages >= 0 && p.pages <= SURFACE_BOUNDS.pages ? p.pages : null,
    transport,
  };
}

/** Annotation keys kept in meta.surface.tools[] (the MCP ToolAnnotations), with their value types. */
export const ANNOTATION_KEYS = Object.freeze({ title: 'string', readOnlyHint: 'boolean', destructiveHint: 'boolean', idempotentHint: 'boolean', openWorldHint: 'boolean' });
/** Bounds of what meta.surface keeps from the (untrusted) probe output. */
export const SURFACE_BOUNDS = Object.freeze({ tools: 1000, text: 256, keys: 64, pages: 100 });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A string from the probe kept as is only when short: else null with a reason (never cut). */
const shortStr = (v, max = SURFACE_BOUNDS.text) => (typeof v !== 'string' ? { v: null, why: v === undefined ? 'absent' : 'not a string' } : v.length > max ? { v: null, why: `over ${max} characters` } : { v });

/** `annotations` reduced to the known keys with values of their type; what was left out is counted. */
export function boundAnnotations(a) {
  if (a === undefined || a === null) return { annotations: null, annotations_why: 'absent' };
  if (!isObj(a)) return { annotations: null, annotations_why: 'not an object' };
  const out = {};
  let dropped = 0;
  for (const k of Object.keys(a)) {
    const type = Object.hasOwn(ANNOTATION_KEYS, k) ? ANNOTATION_KEYS[k] : null;
    const v = a[k];
    if (type && typeof v === type && (type !== 'string' || v.length <= SURFACE_BOUNDS.text)) out[k] = v;
    else dropped++;
  }
  return { annotations: out, ...(dropped ? { annotations_dropped: dropped } : {}) };
}

/**
 * `meta.surface` from the probe's output (`s`: { initialize, tools, pages, ... }). Pure; unit-tested.
 * The probe's stdout is untrusted (the server under test shares its container and user, and can
 * write to it through /proc), so every field is type-checked and bounded here; sha256_jcs is over
 * { initialize, tools } (RFC 8785), and only when both answered.
 */
export function surfaceMeta(s, file = 'surface.json') {
  if (!isObj(s) || !isObj(s.initialize)) {
    const e = isObj(s) && typeof s.initialize_error === 'string' ? s.initialize_error.slice(0, 300) : null;
    return { surface: null, surface_why: e ? `initialize: ${e}` : 'the surface probe gave no initialize result' };
  }
  const init = s.initialize;
  const toolsRes = isObj(s.tools) && Array.isArray(s.tools.tools) ? s.tools : null;
  const m = { file };
  if (toolsRes) {
    const h = jcsOrWhy({ initialize: init, tools: toolsRes });
    m.sha256_jcs = h.hash;
    if (!h.hash) m.sha256_jcs_why = h.why;
  } else {
    m.sha256_jcs = null;
    m.sha256_jcs_why = `tools/list did not answer: ${typeof s.tools_error === 'string' ? s.tools_error.slice(0, 300) : 'no result'}`;
  }
  const pv = shortStr(init.protocolVersion, 64);
  m.protocol_version = pv.v;
  if (pv.v === null) m.protocol_version_why = `initialize protocolVersion: ${pv.why}`;
  if (isObj(init.serverInfo)) {
    const n = shortStr(init.serverInfo.name);
    const v = shortStr(init.serverInfo.version, 64);
    m.server_info = { name: n.v, version: v.v, ...(n.v === null ? { name_why: n.why } : {}), ...(v.v === null ? { version_why: v.why } : {}) };
  } else {
    m.server_info = null;
    m.server_info_why = 'initialize gave no serverInfo';
  }
  if (isObj(init.capabilities)) {
    const keys = Object.keys(init.capabilities);
    m.capabilities_keys = keys.length <= SURFACE_BOUNDS.keys && keys.every((k) => k.length <= 64) ? keys.sort() : null;
    if (!m.capabilities_keys) m.capabilities_keys_why = `over ${SURFACE_BOUNDS.keys} keys or a key over 64 characters`;
  } else {
    m.capabilities_keys = null;
    m.capabilities_keys_why = 'initialize gave no capabilities object';
  }
  m.instructions_sha256 = typeof init.instructions === 'string' ? sha256Text(init.instructions) : null;
  if (m.instructions_sha256 === null) m.instructions_sha256_why = init.instructions === undefined ? 'the server gave no instructions' : 'instructions is not a string';
  const tools = toolsRes ? toolsRes.tools : null;
  m.tool_count = tools ? tools.length : null;
  if (!tools) m.tool_count_why = 'tools/list did not answer';
  m.tools = tools ? tools.slice(0, SURFACE_BOUNDS.tools).map((t) => {
    const o = isObj(t) ? t : {};
    const schema = (v) => (v === undefined || v === null ? { hash: null, why: 'absent' } : jcsOrWhy(v));
    const n = shortStr(o.name);
    const inS = schema(o.inputSchema);
    const outS = schema(o.outputSchema);
    return {
      name: n.v,
      ...(n.v === null ? { name_why: n.why } : {}),
      description_sha256: typeof o.description === 'string' ? sha256Text(o.description) : null,
      ...(typeof o.description === 'string' ? {} : { description_sha256_why: o.description === undefined ? 'absent' : 'not a string' }),
      input_schema_sha256_jcs: inS.hash,
      ...(inS.hash ? {} : { input_schema_sha256_jcs_why: inS.why }),
      output_schema_sha256_jcs: outS.hash,
      ...(outS.hash ? {} : { output_schema_sha256_jcs_why: outS.why }),
      ...boundAnnotations(o.annotations),
    };
  }) : null;
  if (tools && tools.length > SURFACE_BOUNDS.tools) m.tools_omitted = tools.length - SURFACE_BOUNDS.tools;
  if (s.pages !== undefined) {
    m.tools_pages = Number.isSafeInteger(s.pages) && s.pages >= 0 && s.pages <= SURFACE_BOUNDS.pages ? s.pages : null;
    if (m.tools_pages === null) m.tools_pages_why = `not a whole number from 0 to ${SURFACE_BOUNDS.pages}`;
  }
  return { surface: m };
}

/**
 * A set-up step of the `fetch` form: `{ fetch: { url, sha256, dest?, strip_components? } }`. The
 * tarball is fetched by our helper (allowlisted https hosts, every redirect checked), verified
 * against the pinned sha256, and only then unpacked into /work/<dest> (default `src`) in a sandbox
 * container with no network. So an entry needs no git. Returns the normalised step.
 */
export function checkFetch(s, what = 'set-up') {
  const f = s?.fetch;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).join() !== 'fetch' || !f || typeof f !== 'object' || Array.isArray(f)) {
    throw new HarnessError(`${what}: a set-up step is a shell line or { fetch: { url, sha256, dest, strip_components } }`);
  }
  for (const k of Object.keys(f)) if (!['url', 'sha256', 'dest', 'strip_components'].includes(k)) throw new HarnessError(`${what}: fetch has an unknown field`);
  if (typeof f.url !== 'string') throw new HarnessError(`${what}: fetch.url`);
  try { checkListedUrl(f.url); } catch (e) { throw new HarnessError(`${what}: ${e.message}`); }
  if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new HarnessError(`${what}: fetch.sha256 is required (64 lower-case hex)`);
  const dest = f.dest ?? 'src';
  if (typeof dest !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}){0,7}$/.test(dest) || RESERVED_DEST.has(dest.split('/')[0])) {
    throw new HarnessError(`${what}: fetch.dest must be a relative folder under /work, not one of ours`);
  }
  const strip = f.strip_components ?? 0;
  if (!Number.isInteger(strip) || strip < 0 || strip > 5) throw new HarnessError(`${what}: fetch.strip_components is 0 to 5`);
  return { url: f.url, sha256: f.sha256, dest, strip };
}

/** `docker run -d` arguments for one backend: digest-pinned, on the target's internal network only. */
export function backendRunArgs({ name, image, network, alias, env = {}, args = [], capAdd = [], labels = {}, cpus = CPUS }) {
  checkPinned(image, 'backend');
  for (const c of capAdd) if (!BACKEND_CAPS.has(c)) throw new HarnessError(`backend capability ${c} is not allowed`);
  return [
    'run', '-d', '--name', name,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--network', network, '--network-alias', alias,
    // no-new-privileges and the full drop come first; only the allowlisted adds follow.
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL', ...capAdd.flatMap((c) => ['--cap-add', c]),
    '--pids-limit', '1024', '--memory', '2g', '--cpus', String(cpus),
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    image, ...args,
  ];
}

/**
 * R2-5: an npm lock may fetch only from the npm registry, with an integrity hash for every package.
 * The one exception is the target itself, `file:artifact.tgz` (the artifact whose sha256 the host
 * checked). Bundled packages come inside their parent's tarball. No link, git, URL or folder entry.
 */
export function checkNpmLock(t) {
  let pj;
  let pl;
  try {
    pj = JSON.parse(t.lock.package_json);
    pl = JSON.parse(t.lock.package_lock);
  } catch {
    throw new HarnessError('npm lock is not JSON');
  }
  const own = { [t.package]: 'file:artifact.tgz' };
  const same = (a) => a && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(own);
  if (!same(pj?.dependencies) || Object.keys(pj).some((k) => !['private', 'name', 'version', 'dependencies'].includes(k))) {
    throw new HarnessError('npm lock: package.json must depend on the target artifact only');
  }
  const pk = pl?.packages;
  if (!(pl?.lockfileVersion >= 2) || !pk || typeof pk !== 'object' || Array.isArray(pk)) throw new HarnessError('npm lock: lockfileVersion 2 or 3 with packages');
  if (!same(pk['']?.dependencies)) throw new HarnessError('npm lock: the root must depend on the target artifact only');
  for (const [k, e] of Object.entries(pk)) {
    if (k === '') continue;
    if (!e || typeof e !== 'object' || e.link) throw new HarnessError('npm lock: a link entry');
    if (k === `node_modules/${t.package}`) {
      if (e.resolved !== 'file:artifact.tgz') throw new HarnessError('npm lock: the target must resolve to the checked artifact');
      continue;
    }
    if (e.inBundle === true && e.resolved === undefined) continue;
    if (typeof e.resolved !== 'string' || !e.resolved.startsWith(NPM_REGISTRY)) throw new HarnessError(`npm lock: a package resolves outside ${NPM_REGISTRY}`);
    if (typeof e.integrity !== 'string' || !/^sha(1|256|384|512)-[A-Za-z0-9+/=]+$/.test(e.integrity)) throw new HarnessError('npm lock: a package has no integrity hash');
  }
}

/**
 * R2-5: a PyPI lock is `name[extras]==version [; marker]` with one or more sha256 hashes per
 * requirement, and nothing else: no direct URL (`name @ ...`), no option line (index, find-links,
 * editable), no file or VCS reference. Comments and blank lines are ignored.
 */
export function checkPypiLock(text) {
  const reqs = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean);
  for (const r of reqs) {
    const hashes = r.match(/(^|\s)--hash=sha256:[0-9a-f]{64}(?=\s|$)/g) ?? [];
    const rest = r.replace(/(^|\s)--hash=sha256:[0-9a-f]{64}(?=\s|$)/g, ' ').trim();
    const [spec, ...marker] = rest.split(';');
    const ok = hashes.length > 0
      && /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]*\])?==[A-Za-z0-9.+!_-]+$/.test(spec.trim())
      && marker.length <= 1 && !/[@\\]|:\/\/|(^|\s)-/.test(marker.join(';'));
    if (!ok) throw new HarnessError('pypi lock: only name==version requirements with sha256 hashes');
  }
}

/**
 * R2-3: on a Mac (Docker Desktop or colima), the install network reaches the Mac's own loopback
 * and LAN, and no guard can run inside the runtime's VM. So no target code may run there while it
 * has egress: targets that need install scripts or a build run on the CI lane's runners only. This
 * holds for lane `mac`, and for any lane when the driver itself runs on macOS.
 */
export function checkLane(t, lane, hostOs = platform()) {
  if ((lane === 'mac' || hostOs === 'darwin') && (t.install_scripts || t.allow_build)) {
    throw new HarnessError('lane mac: install_scripts and allow_build targets run on the CI runners only (their code would run with egress)');
  }
}

/** R2-4: the Docker Engine must be 26.0.0 or later (CVE-2024-29018). `v` is the server version. */
export function checkDockerVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  const n = m ? m.slice(1).map(Number) : null;
  const older = !n || n[0] < DOCKER_MIN[0] || (n[0] === DOCKER_MIN[0] && (n[1] < DOCKER_MIN[1] || (n[1] === DOCKER_MIN[1] && n[2] < DOCKER_MIN[2])));
  if (older) throw new HarnessError(`Docker Engine ${String(v).trim() || 'unknown'} is older than ${DOCKER_MIN.join('.')}`);
  return true;
}

/**
 * The install commands for one target, in order, each run in its own sandbox container.
 * `net` is `egress` (registries reachable) or `none`. Files are written into the volume first.
 * Hash-locked (M4): npm targets install with `npm ci` from the package-lock.json pinned in the list;
 * PyPI targets with `uv pip install --require-hashes` from the lock pinned for this platform.
 */
export function installPlan(t, plat) {
  const files = [];
  const steps = [];
  if (t.ecosystem === 'npm') {
    if (!t.lock?.package_json || !t.lock?.package_lock) throw new HarnessError('npm target is not hash-locked (lock.package_json, lock.package_lock)');
    checkNpmLock(t);
    files.push({ path: `${P.work}/pkg/artifact.tgz`, artifact: true });
    files.push({ path: `${P.work}/pkg/package.json`, text: t.lock.package_json });
    files.push({ path: `${P.work}/pkg/package-lock.json`, text: t.lock.package_lock });
    steps.push({ name: 'install', net: 'egress', workdir: `${P.work}/pkg`, cmd: ['npm', 'ci', '--no-audit', '--no-fund', '--loglevel=error', ...(t.install_scripts ? [] : ['--ignore-scripts'])] });
    steps.push({ name: 'deps', net: 'none', workdir: `${P.work}/pkg`, cmd: ['npm', 'ls', '--all', '--json'], capture: 'deps.json', mayFail: true });
    return { files, steps, bin: `${P.work}/pkg/node_modules/.bin`, pkgdir: `${P.work}/pkg/node_modules/${t.package}` };
  }
  if (t.ecosystem === 'pypi') {
    const lock = t.lock?.pypi?.[plat];
    if (typeof lock !== 'string') throw new HarnessError(`pypi target is not hash-locked for ${plat} (lock.pypi.${plat})`);
    checkPypiLock(lock);
    const file = t.artifact?.file;
    if (!/^[A-Za-z0-9._+-]+\.(whl|tar\.gz|zip)$/.test(file ?? '')) throw new HarnessError('pypi artifact file name');
    const py = `${P.work}/venv/bin/python`;
    const binary = t.allow_build ? [] : ['--only-binary', ':all:'];
    files.push({ path: `${P.work}/dl/${file}`, artifact: true });
    files.push({ path: `${P.work}/lock.txt`, text: lock });
    steps.push({ name: 'install', net: 'egress', cmd: ['uv', 'venv', '--quiet', '--python', t.python ?? '3.12', `${P.work}/venv`] });
    if (lock.trim()) steps.push({ name: 'install', net: 'egress', cmd: ['uv', 'pip', 'install', '--quiet', '--python', py, '--require-hashes', '--no-deps', ...binary, '-r', `${P.work}/lock.txt`] });
    // The target itself: the artifact whose sha256 the host checked, with no dependency resolution.
    steps.push({ name: 'install', net: 'none', cmd: ['uv', 'pip', 'install', '--quiet', '--offline', '--python', py, '--no-deps', ...(file.endsWith('.whl') ? binary : []), `${P.work}/dl/${file}`] });
    steps.push({ name: 'deps', net: 'none', cmd: ['uv', 'pip', 'freeze', '--python', py], capture: 'deps.txt', mayFail: true });
    return { files, steps, bin: `${P.work}/venv/bin`, pkgdir: null, needsUv: true };
  }
  if (t.ecosystem === 'binary') {
    const a = t.artifact?.[plat];
    if (!a) throw new HarnessError(`no artifact for ${plat}`);
    if (!/^[A-Za-z0-9._+-]+\.(tar\.gz|tgz)$/.test(a.file ?? '')) throw new HarnessError('binary artifact file name');
    files.push({ path: `${P.work}/dl/${a.file}`, artifact: true });
    steps.push({ name: 'install', net: 'none', cmd: ['sh', '-c', 'mkdir -p "$2" && tar -xzf "$1" -C "$2" --no-same-owner', 'sh', `${P.work}/dl/${a.file}`, `${P.work}/bin`] });
    return { files, steps, bin: `${P.work}/bin`, pkgdir: null };
  }
  throw new HarnessError(`unknown ecosystem ${t.ecosystem}`);
}

/**
 * The order targets run in, shuffled per run (L2): the public "run finished, exit N" lines then
 * say nothing about which target of the list a line belongs to. The seed is kept in the encrypted
 * shard.json, so the order can be rebuilt. Deterministic for a seed; unit-tested.
 */
export function shuffled(list, seedHex) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const h = createHash('sha256').update(`${seedHex}:${i}`).digest();
    const j = h.readUInt32BE(0) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The artifact entry for this platform (binary targets have one per platform). */
function artifactFor(t, plat) {
  return t.ecosystem === 'binary' ? t.artifact?.[plat] : t.artifact;
}

function args(argv) {
  const o = { lane: 'ci', shard: 1, shards: 1, only: null, work: null, cliCommit: null, consumeTargets: false, images: join(here, 'images.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new HarnessError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--targets') o.targets = v();
    else if (a === '--cli') o.cli = v();
    else if (a === '--out') o.out = v();
    else if (a === '--work') o.work = v();
    else if (a === '--lane') o.lane = v();
    else if (a === '--shard') o.shard = Number(v());
    else if (a === '--shards') o.shards = Number(v());
    else if (a === '--only') o.only = v().split(',').filter(Boolean);
    else if (a === '--cli-commit') o.cliCommit = v();
    else if (a === '--consume-targets') o.consumeTargets = true;
    else if (a === '--images') o.images = v();
    else if (a === '--spec') o.spec = v();
    else throw new HarnessError(`unknown option ${a}`);
  }
  for (const k of ['targets', 'cli', 'out']) if (!o[k]) throw new HarnessError(`--${k} is required`);
  if (!(o.shard >= 1 && o.shard <= o.shards)) throw new HarnessError('--shard must be between 1 and --shards');
  return o;
}

/** sha256 of a file, read in 1 MiB chunks (a target-written file can be as large as the copy-out cap). */
function sha256File(f) {
  const h = createHash('sha256');
  const fd = openSync(f, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * The two fields the driver keeps from a (target-writable) results.json: `run.status` (a string of 64
 * characters at most) and `run.writes` (a finite number), each null with a reason otherwise. A file
 * over `cap` bytes is not read. The parsed document is dropped at once; nothing else of it is kept.
 */
export function readRunFields(f, cap = JSON_CAP) {
  if (lstatSync(f).size > cap) return { too_large: true, status: null, writes: null, why: `over ${cap} bytes: not read` };
  const run = (() => { const d = safeJson(readFileSync(f, 'utf8')); return d && typeof d === 'object' && d.run && typeof d.run === 'object' ? d.run : null; })();
  if (!run) return { too_large: false, status: null, writes: null, why: 'no run object (not JSON, or no run)' };
  const status = typeof run.status === 'string' && run.status.length <= 64 ? run.status : null;
  const writes = typeof run.writes === 'number' && Number.isFinite(run.writes) ? run.writes : null;
  return { too_large: false, status, writes, ...(status === null ? { status_why: 'run.status is not a string of 64 characters at most' } : {}), ...(writes === null ? { writes_why: 'results.json has no finite run.writes' } : {}) };
}
const sha256Text = (s) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

/**
 * Run a command with all output to a log file, in its own process group, bounded by `deadline`
 * (ms since epoch). Never throws; returns { exit, signal, timed_out, spawn_error, ms, stdout }.
 * `onTimeout` runs once when the deadline passes (a container is removed there: killing the docker
 * client alone would leave the container running). `keepStdout: 'buffer'` keeps raw bytes.
 */
function run(cmd, argv, { cwd, env, log, deadline, keepStdout = false, input = null, onTimeout = null, logStdout = true, raw = false }) {
  return new Promise((done) => {
    const t0 = Date.now();
    const out = createWriteStream(log, { flags: 'a' });
    out.write(`\n$ ${[cmd, ...argv].join(' ')}\n# at ${now()}\n`);
    const chunks = [];
    let logged = 0;
    let buffered = 0;
    let dropped = 0;
    let seen = 0;
    // Up to the cap and then nothing: a cut chunk keeps its head, so the log stays one prefix.
    const toLog = (c) => {
      const keep = Math.max(0, Math.min(c.length, LOG_CAP - logged));
      if (keep) { logged += keep; out.write(keep === c.length ? c : c.subarray(0, keep)); }
      dropped += c.length - keep;
    };
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      out.end(`# spawn error: ${e.message}\n`);
      return done({ exit: null, signal: null, timed_out: false, spawn_error: e.message, ms: 0, stdout: '' });
    }
    if (input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.stdout.on('data', (c) => {
      seen += c.length;
      // 'buffer' is ours only (docker cp of a pinned image's file); text captures of target steps are capped.
      if (keepStdout === 'buffer') chunks.push(c);
      else if (keepStdout && buffered < BUF_CAP) {
        const keep = Math.min(c.length, BUF_CAP - buffered);
        buffered += keep;
        chunks.push(keep === c.length ? c : c.subarray(0, keep));
      }
      // A capture written to its own file (surface, snapshot) is not copied into the log as well.
      if (keepStdout !== 'buffer' && logStdout) toLog(c);
    });
    child.stderr.on('data', (c) => toLog(c));
    let timedOut = false;
    const left = Math.max(1000, deadline - Date.now());
    const timer = setTimeout(() => {
      timedOut = true;
      if (onTimeout) onTimeout();
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 15_000).unref();
    }, left);
    let spawnError = null;
    child.on('error', (e) => { spawnError = e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Anything the step left behind in its process group dies with it: an orphan would outlive
      // the job and the runner prints its process name in the public log.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      out.end(`${dropped ? `\n# ${dropped} bytes of output dropped (log cap)\n` : ''}${logStdout ? '' : `# ${seen} bytes of stdout captured, not logged\n`}# exit ${code} signal ${signal}${timedOut ? ' (time limit)' : ''} after ${Date.now() - t0} ms\n`);
      const buf = Buffer.concat(chunks);
      done({ exit: code, signal, timed_out: timedOut, spawn_error: spawnError, ms: Date.now() - t0, stdout: keepStdout === 'buffer' || raw ? buf : buf.toString('utf8'), stdout_truncated: keepStdout !== 'buffer' && !!keepStdout && seen > buffered });
    });
  });
}

async function must(step, what) {
  const r = await step;
  if (r.timed_out) throw Object.assign(new HarnessError(`${what}: time limit`), { timeout: true });
  if (r.spawn_error || r.exit !== 0) throw new HarnessError(`${what}: exit ${r.exit} signal ${r.signal} ${r.spawn_error ?? ''}`.trim());
  return r;
}

async function download(url, sha256, log) {
  let buf;
  if (url.startsWith('file://')) buf = readFileSync(new URL(url)); // local artifacts (tests, a mirror)
  else if (url.startsWith('https://')) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new HarnessError(`download: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else throw new HarnessError('download: only https:// and file:// artifacts');
  const got = createHash('sha256').update(buf).digest('hex');
  writeFileSync(log, `download ${url}\nsha256 ${got}\n`, { flag: 'a' });
  if (got !== sha256) throw new HarnessError(`checksum: artifact sha256 ${got} is not the pinned ${sha256}`);
  return { buf, sha256: got };
}

/**
 * Docker plumbing for one shard. Every container, volume and network carries the label
 * isokron.corpus.run=<runId>, so the end of the shard (and the workflow's last sweep) removes all.
 */
class Docker {
  constructor(ctx, log) {
    this.ctx = ctx;
    this.env = dockerEnvFrom(process.env);
    this.log = log;
    this.n = 0;
  }

  labels(extra = {}) {
    return { 'isokron.corpus.run': this.ctx.runId, ...extra };
  }

  d(argv, opts = {}) {
    return run('docker', argv, { cwd: this.ctx.out, env: this.env, log: opts.log ?? this.log, deadline: opts.deadline ?? Date.now() + 300_000, keepStdout: opts.keepStdout ?? false, input: opts.input ?? null, onTimeout: opts.onTimeout ?? null, logStdout: opts.logStdout ?? true, raw: opts.raw ?? false });
  }

  /** Remove a container now, without waiting (at a time limit: killing the client leaves it running). */
  kill(name) {
    spawn('docker', ['rm', '-f', name], { env: this.env, stdio: 'ignore' }).on('error', () => {});
  }

  /**
   * One of our helper containers, named and labelled with its target (R2-10), so a helper stuck
   * on something the target planted (a fifo at a path we write) is removed at the deadline and
   * found by the per-target sweep.
   */
  async helper(h, opts) {
    const name = `corpus-${this.ctx.runId}-${h.target ?? 'shard'}-h${++this.n}`;
    const r = await this.d(this.helperArgs({ ...h, name }), { ...opts, onTimeout: () => this.kill(name) });
    if (r.timed_out) await this.d(['rm', '-f', name], { log: opts.log });
    return r;
  }

  /** A sandbox container running `cmd`; removed (with its processes) at the deadline. */
  async sandbox({ log, deadline, network, mounts, env, cmd, workdir, input = null, keepStdout = false, logStdout = true, target }) {
    const name = `corpus-${this.ctx.runId}-${target}-${++this.n}`;
    const argv = sandboxRunArgs({ name, image: this.ctx.images.runtime, network, mounts, env, workdir, stdin: input !== null, labels: this.labels({ 'isokron.corpus.target': target }), cpus: this.ctx.cpus, cmd });
    const r = await run('docker', argv, {
      cwd: this.ctx.out, env: this.env, log, deadline, keepStdout, input, logStdout,
      onTimeout: () => this.kill(name),
    });
    if (r.timed_out) await this.d(['rm', '-f', name], { log });
    return { ...r, container: true };
  }

  /** Ours, not target code: root without capabilities except CHOWN, no network, fixed command. */
  helperArgs({ mounts, cmd, stdin = false, chown = false, user = '0:0', name = null, target = null, network = 'none', env = {} }) {
    return [
      'run', '--rm', ...(name ? ['--name', name] : []),
      ...Object.entries(this.labels(target ? { 'isokron.corpus.target': target } : {})).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      '--user', user, '--cap-drop', 'ALL', ...(chown ? ['--cap-add', 'CHOWN'] : []),
      // Only the set-up fetch helper (ours, no target code running) is given the install network.
      '--security-opt', 'no-new-privileges', '--read-only', '--network', network,
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      ...mounts.flatMap((m) => ['--mount', volumeMount(m)]),
      ...(stdin ? ['--interactive'] : []),
      this.ctx.images.runtime, ...cmd,
    ];
  }

  /**
   * A digest-pinned image, pulled only when it is not here already (a digest names its content, so
   * a local copy is the same image). Returns the local image id.
   */
  async image(ref, log, what) {
    checkPinned(ref, what);
    let id = await this.d(['image', 'inspect', '--format', '{{.Id}}', ref], { log, keepStdout: true });
    if (id.exit !== 0) {
      await must(this.d(['pull', '-q', ref], { log, deadline: Date.now() + 600_000 }), `${what} pull`);
      id = await must(this.d(['image', 'inspect', '--format', '{{.Id}}', ref], { log, keepStdout: true }), `${what} inspect`);
    }
    return id.stdout.trim();
  }

  async volume(name, log) {
    await must(this.d(['volume', 'create', ...Object.entries(this.labels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]), name], { log }), 'volume');
    return name;
  }

  async network(name, internal, log) {
    await must(this.d(['network', 'create', ...(internal ? ['--internal'] : []), '--driver', 'bridge',
      '--opt', 'com.docker.network.bridge.enable_icc=true',
      ...Object.entries(this.labels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]), name], { log }), 'network');
    const r = await this.d(['network', 'inspect', '--format', '{{.Internal}}', name], { log, keepStdout: true });
    const isInternal = r.stdout.trim() === 'true';
    if (isInternal !== internal) throw new HarnessError(`network ${internal ? 'is not internal' : 'is internal'}`);
    return { name, internal: isInternal };
  }

  /** Remove everything this shard (or one target, with `target`) created. */
  async sweep(log, target = null) {
    const f = ['--filter', `label=isokron.corpus.run=${this.ctx.runId}`, ...(target ? ['--filter', `label=isokron.corpus.target=${target}`] : [])];
    const ids = (await this.d(['ps', '-aq', ...f], { log, keepStdout: true })).stdout.split('\n').filter(Boolean);
    if (ids.length) await this.d(['rm', '-f', '-v', ...ids], { log });
    if (target) return;
    const nets = (await this.d(['network', 'ls', '-q', ...f], { log, keepStdout: true })).stdout.split('\n').filter(Boolean);
    if (nets.length) await this.d(['network', 'rm', ...nets], { log });
    const vols = (await this.d(['volume', 'ls', '-q', ...f], { log, keepStdout: true })).stdout.split('\n').filter(Boolean);
    if (vols.length) await this.d(['volume', 'rm', '-f', ...vols], { log });
  }
}

/** Remove anything under `dir` that is not a regular file or a folder (symlinks, fifos, devices). */
export function keepRegular(dir) {
  let removed = 0;
  if (!existsSync(dir)) return removed;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = lstatSync(p);
    if (s.isDirectory()) removed += keepRegular(p);
    else if (!s.isFile()) {
      rmSync(p, { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Bring /work/out back to the host: a helper (no network, read-only volume) tars regular files and
 * folders only; the host extracts with no owner and no modes, under COPY_OUT_CAP bytes.
 */
function copyOut(dk, vol, dest, log, target) {
  mkdirSync(dest, { recursive: true });
  const name = `corpus-${dk.ctx.runId}-${target}-h${++dk.n}`;
  const argv = dk.helperArgs({
    name, target,
    user: SANDBOX_USER,
    mounts: [{ src: vol, dst: P.work, ro: true }],
    cmd: ['sh', '-c', 'cd /work/out 2>/dev/null || exit 0; find . -mindepth 1 \\( -type f -o -type d \\) -print0 | tar --null --no-recursion -cf - -T -'],
  });
  return new Promise((done) => {
    const lg = createWriteStream(log, { flags: 'a' });
    lg.write(`\n$ docker ${argv.join(' ')} | tar -x\n`);
    const src = spawn('docker', argv, { env: dk.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-f', '-', '--no-same-owner', '--no-same-permissions', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let bytes = 0;
    let capped = false;
    let timedOut = false;
    // The helper reads only regular files and folders, but a stuck one is removed (R2-10).
    const timer = setTimeout(() => { timedOut = true; dk.kill(name); src.kill('SIGKILL'); tar.stdin.destroy(); }, COPY_OUT_MS);
    src.stderr.on('data', (c) => lg.write(c));
    tar.stderr.on('data', (c) => lg.write(c));
    tar.stdin.on('error', () => {});
    src.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > COPY_OUT_CAP) {
        if (!capped) { capped = true; src.kill('SIGKILL'); tar.stdin.destroy(); }
        return;
      }
      tar.stdin.write(c);
    });
    src.stdout.on('end', () => tar.stdin.end());
    let n = 0;
    let srcExit = null;
    let tarExit = null;
    const fin = () => {
      if (++n < 2) return;
      clearTimeout(timer);
      const removed = keepRegular(dest);
      lg.end(`# copy-out ${bytes} bytes, helper exit ${srcExit}, tar exit ${tarExit}${capped ? ', over the cap' : ''}${timedOut ? ', time limit' : ''}, ${removed} non-regular removed\n`);
      done({ bytes, capped, timed_out: timedOut, ok: srcExit === 0 && tarExit === 0 && !capped && !timedOut, removed });
    };
    src.on('error', () => { srcExit = -1; fin(); });
    src.on('close', (c) => { srcExit = c; fin(); });
    tar.on('close', (c) => { tarExit = c; fin(); });
  });
}

/**
 * The bin whose entry point the config-source copy follows: `bins[0]` from the list when it is a
 * plain file name, else the server command's first word when it names a file in the bin folder.
 */
export function entryBin(t, binDir, command0) {
  const ok = (n) => typeof n === 'string' && /^[A-Za-z0-9@._+-]{1,214}$/.test(n) && n !== '.' && n !== '..';
  if (Array.isArray(t.bins) && ok(t.bins[0])) return { bin: t.bins[0], from: 'bins[0]' };
  if (typeof command0 === 'string' && command0.startsWith(`${binDir}/`) && ok(command0.slice(binDir.length + 1))) return { bin: command0.slice(binDir.length + 1), from: 'server.command[0]' };
  return { bin: null, from: null, why: 'neither bins[0] nor the server command names a file in the bin folder' };
}

/**
 * `meta.config_source` from the helper's listing. The listing is read as untrusted input (its
 * container holds the installed target's files): entries are type-checked and bounded, and an entry
 * whose path could leave the folder is dropped.
 */
export function configSourceMeta(listing, step = {}) {
  if (!listing || typeof listing !== 'object' || !Array.isArray(listing.files)) {
    return { config_source: null, config_source_why: `the config-source helper gave no listing (exit ${step.exit ?? null}${step.timed_out ? ', time limit' : ''})` };
  }
  const rule = (r) => (['manifest', 'readme', 'license', 'entry', 'config'].includes(r) ? r : null);
  const files = listing.files.slice(0, 40)
    .filter((f) => f && safeRel(f.path) && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && rule(f.rule))
    .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, rule: f.rule, file: `sandbox/config-source/${f.path}` }));
  if (!files.length && typeof listing.why === 'string') return { config_source: null, config_source_why: listing.why.slice(0, 300) };
  const skipped = (Array.isArray(listing.skipped) ? listing.skipped : []).slice(0, 200).filter((x) => x && typeof x === 'object').map((x) => ({
    path: typeof x.path === 'string' && x.path.length <= 4096 ? x.path : null,
    bytes: Number.isSafeInteger(x.bytes) ? x.bytes : null,
    rule: rule(x.rule),
    why: typeof x.why === 'string' ? x.why.slice(0, 64) : null,
  }));
  const more = Number.isSafeInteger(listing.skipped_more) && listing.skipped_more > 0 ? listing.skipped_more : 0;
  return { config_source: files, config_source_skipped: skipped, ...(more ? { config_source_skipped_more: more } : {}) };
}

/** A config-source listing entry's path: relative, inside the work folder, nothing to climb out with. */
const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.startsWith('/') && !p.split('/').some((x) => x === '..' || x === '' || x === '.') && !/[\0\n\r]/.test(p);

/** One target. Returns its metadata record; never throws. */
async function runTarget(t, o, ctx, dk) {
  const odir = resolve(o.out, t.id);
  mkdirSync(join(odir, 'logs'), { recursive: true });
  const L = (n) => join(odir, 'logs', `${n}.log`);
  const lim = timeLimits(t, ctx.defaults);
  const deadline = Date.now() + lim.base_s * 1000;
  const notYet = (what) => `not ${what} (the target stopped before it)`;
  const meta = {
    format: RUN_FORMAT,
    label: LABEL,
    target: {
      id: t.id, name: t.name, ecosystem: t.ecosystem, package: t.package, version: t.version,
      artifact: t.artifact ?? null, source: t.source ?? null, license: t.license ?? null,
      manifest_kind: t.full ? 'hand-written (full)' : 'generic catalog',
      lock_sha256: t.lock ? sha256Text(JSON.stringify(t.lock)) : null,
    },
    cli: ctx.cli,
    spec: ctx.spec,
    runner: ctx.runner,
    images: ctx.imageInfo,
    sandbox_tools_sha256: ctx.sandboxTools ?? null,
    isolation: ctx.isolation,
    github: ctx.github,
    lane: o.lane,
    started: now(),
    ended: null,
    // The whole target's limit; `time_limits` says how it is made up (D8).
    timeout_s: lim.total_s,
    time_limits: lim,
    artifact_sha256_verified: null,
    networks: {},
    backends: [],
    setup_fetch: [],
    deps: null,
    manifest_sha256: null,
    init_draft_sha256: null,
    steps: [],
    status: 'completed',
    cli_exit: null,
    harness_error: null,
    copy_out: null,
    results: [],
    canary: t.canary ?? null,
    env: {
      node_version: null, node_version_why: notYet('probed'),
      python_version: null, python_version_why: notYet('probed'),
      ...ctx.env,
      backends: (Array.isArray(t.backends) ? t.backends : []).map((b) => {
        const p = imageParts(b?.image);
        return { image_tag: typeof b?.image_tag === 'string' ? b.image_tag : p.image_tag, image_digest: p.image_digest, ...(p.image_digest ? {} : { image_digest_why: 'the image is not pinned by digest' }) };
      }),
      images: [{ role: 'runtime', ...imageParts(ctx.images.runtime) }],
    },
    surface: null,
    surface_why: notYet('probed'),
    config_source: null,
    config_source_why: notYet('collected'),
    backend_state: [],
    full_runs: [],
  };
  const tag = `${ctx.runId}-${t.id}`;
  const backendName = (i) => `corpus-${tag}-b${i}`;
  let vol = null;
  let cleanVol = null;
  try {
    if (ctx.invalid?.has(t.id)) throw new HarnessError(ctx.invalid.get(t.id));
    validateTarget(t, ctx.dropped);
    checkLane(t, o.lane);
    // D3: one record per backend with a snapshot, filled when the snapshots are taken.
    const snapping = (t.backends ?? []).map((b, i) => [i, b]).filter(([, b]) => b.snapshot);
    const states = new Map();
    for (const [i] of snapping) {
      const e = { backend: i, before: null, before_why: 'no CLI step that writes ran', after: null, after_why: 'no CLI step that writes ran' };
      if (lim.repeats > 1) e.repeats = [];
      meta.backend_state.push(e);
      states.set(i, e);
    }
    // 1. The artifact, on the host: downloaded and checked against the pinned sha256. Never run here.
    const plan = installPlan(t, ctx.plat);
    if (plan.needsUv) meta.env.images.push({ role: 'uv', ...imageParts(ctx.images.uv) });
    const art = artifactFor(t, ctx.plat);
    const dl = await download(art.url, art.sha256, L('install'));
    meta.artifact_sha256_verified = dl.sha256;
    if (plan.needsUv) await ctx.ensureTools();

    // 2. The target's volume and networks: egress for install only, internal for the rest.
    vol = await dk.volume(`corpus-${tag}`, L('install'));
    await must(dk.helper({ target: t.id, chown: true, mounts: [{ src: vol, dst: P.work }], cmd: ['sh', '-c', 'mkdir -p /work/home /work/out /work/dl /work/pkg && chmod 700 /work && chown -R 10001:10001 /work'] }, { log: L('install'), deadline }), 'volume set-up');
    const egress = await dk.network(`corpus-${tag}-egress`, false, L('install'));
    const internal = await dk.network(`corpus-${tag}-run`, true, L('install'));
    meta.networks = { install: { internal: egress.internal }, run: { internal: internal.internal } };
    const mounts = [{ src: vol, dst: P.work }, { src: ctx.cliVol, dst: P.cli, ro: true }, ...(ctx.toolsVol ? [{ src: ctx.toolsVol, dst: P.tools, ro: true }] : [])];
    const put = (path, buf, log, d = deadline) => must(dk.helper({ target: t.id, user: SANDBOX_USER, mounts: [{ src: vol, dst: P.work }], stdin: true, cmd: ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path] }, { log, input: buf, deadline: d }), `write ${path.split('/').pop()}`);

    // 3. Install, in sandbox containers. Only the `egress` steps have a network that leaves the host.
    for (const f of plan.files) await put(f.path, f.artifact ? dl.buf : Buffer.from(f.text), L('install'));
    const envInstall = sandboxEnv(plan.bin);
    if (ctx.installCa) {
      // A machine behind a TLS-inspecting proxy (not GitHub's runners): its CA, for install and fetch only. It lives on the
      // read-only CLI volume (written at shard set-up), not in /work, so target install code cannot alter it.
      Object.assign(envInstall, { SSL_CERT_FILE: INSTALL_CA, NODE_EXTRA_CA_CERTS: INSTALL_CA });
      meta.install_ca = ctx.installCa;
    }
    for (const s of plan.steps) {
      const net = s.net === 'egress' ? egress.name : 'none';
      const r = await dk.sandbox({ log: L(s.capture ? 'deps' : 'install'), deadline, network: net, mounts, env: envInstall, workdir: s.workdir ?? P.work, cmd: s.cmd, keepStdout: !!s.capture, target: t.id });
      if (s.capture) {
        writeFileSync(join(odir, s.capture), r.stdout);
        meta.deps = { file: s.capture, sha256: sha256Text(r.stdout) };
      }
      if (!s.mayFail) await must(Promise.resolve(r), s.name);
    }
    const vars = { tdir: P.work, bin: plan.bin, host: '127.0.0.1' };
    if (plan.pkgdir) vars.pkgdir = plan.pkgdir;

    // 3b. D2 and D4, for the record only (neither decides the status): the node and python3 the
    //     server under test gets, and the installed package's configuration source. Both run in a
    //     sandbox container of this target with no network, after install and before any set-up.
    const small = () => Math.min(deadline, Date.now() + SMALL_STEP_MS);
    const ev = await dk.sandbox({ log: L('env'), deadline: small(), network: 'none', mounts, env: sandboxEnv(plan.bin), cmd: ['sh', '-c', VERSION_PROBE], keepStdout: true, target: t.id });
    delete meta.env.node_version_why;
    delete meta.env.python_version_why;
    Object.assign(meta.env, envVersions(ev));
    let command0;
    try { command0 = fill(t.server?.command?.[0], vars); } catch {}
    const eb = entryBin(t, plan.bin, command0);
    const cs = await dk.sandbox({ log: L('config-source'), deadline: small(), network: 'none', mounts, env: sandboxEnv(plan.bin), target: t.id, keepStdout: true,
      cmd: ['node', `${SANDBOX_TOOLS}/config-source.mjs`, P.work, String(t.ecosystem), String(t.package ?? ''), plan.bin, eb.bin ?? '', `${P.out}/config-source`] });
    delete meta.config_source_why;
    meta.config_source_entry = eb;
    Object.assign(meta, configSourceMeta(safeJson(cs.stdout.trim().split('\n').pop() ?? ''), cs));

    // 3c. D5: with repeats, a clean copy of /work as install left it (before any set-up or server
    //     start), in a volume of its own that no target container mounts. Each later repeat starts
    //     from it again (restoreWork). Our helper copies with tar as the sandbox user, no network,
    //     symlinks and special files as they are (never followed or opened).
    let clean = null;
    if (lim.repeats > 1) {
      try {
        const cv = await dk.volume(`corpus-${tag}-clean`, L('fresh-state'));
        cleanVol = cv;
        await must(dk.helper({ target: t.id, chown: true, mounts: [{ src: cv, dst: P.clean }], cmd: ['sh', '-c', 'chmod 700 /clean && chown 10001:10001 /clean'] }, { log: L('fresh-state'), deadline: small() }), 'clean copy set-up');
        await must(dk.helper({ target: t.id, user: SANDBOX_USER, mounts: [{ src: vol, dst: P.work, ro: true }, { src: cv, dst: P.clean }], cmd: ['sh', '-c', CLEAN_COPY] }, { log: L('fresh-state'), deadline: Math.min(deadline, Date.now() + 600_000) }), 'clean copy');
        clean = cv;
      } catch (e) {
        if (e.timeout) throw e;
        meta.fresh_state_why = `no clean copy of /work: ${String(e.message).slice(0, 200)}`;
      }
    }

    // 4. Backends: digest-pinned, on the internal network only, reachable as b0, b1, ... A backend is
    //    started (and, between full repeats, started again from its image) by startBackend.
    const startBackend = async (i, b, bm, d, v) => {
      const name = backendName(i);
      const image = checkPinned(b.image, `backend ${i}`);
      const capAdd = backendCaps(b, `backend ${i}`);
      const argv = backendRunArgs({ name, image, network: internal.name, alias: `b${i}`, env: fill(b.env ?? {}, v), args: fill(b.args ?? [], v), capAdd, labels: dk.labels({ 'isokron.corpus.target': t.id }), cpus: ctx.cpus });
      const blog = L(`backend-${i}`);
      // A backend that did not come up: its own output (docker logs, capped like every command's log)
      // and its state go into backend-N.log, in the encrypted bundle, before the teardown removes it.
      const backendFailed = async (why) => {
        bm.ready = false;
        await dk.d(['inspect', '--format', 'state {{.State.Status}} exit {{.State.ExitCode}} oom {{.State.OOMKilled}} error {{.State.Error}}', name], { log: blog, deadline: Date.now() + 30_000 });
        await dk.d(['logs', '--timestamps', name], { log: blog, deadline: Date.now() + 60_000 });
        bm.log = `logs/backend-${i}.log`;
        throw new HarnessError(why);
      };
      const started = await dk.d(argv, { log: blog, deadline: d });
      if (started.timed_out) throw Object.assign(new HarnessError(`backend ${i} start: time limit`), { timeout: true });
      if (started.spawn_error || started.exit !== 0) await backendFailed(`backend ${i} start: exit ${started.exit}`);
      const waitUntil = Math.min(d, Date.now() + (b.wait_timeout_s ?? 120) * 1000);
      let ok = !b.wait;
      while (!ok && Date.now() < waitUntil) {
        const w = await dk.d(['exec', name, ...fill(b.wait, v)], { log: blog, deadline: d });
        ok = w.exit === 0;
        if (!ok) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!ok) await backendFailed(`backend ${i} not ready`);
      const captured = {};
      for (const s of b.setup ?? []) {
        const r = await dk.d(['exec', ...(s.user ? ['-u', s.user] : []), name, ...fill(s.exec, v)], { log: blog, deadline: d, keepStdout: !!s.capture });
        if (r.timed_out) throw Object.assign(new HarnessError(`backend ${i} set-up: time limit`), { timeout: true });
        if (r.spawn_error || r.exit !== 0) await backendFailed(`backend ${i} set-up: exit ${r.exit}`);
        if (s.capture) v[s.capture] = captured[s.capture] = r.stdout.trim().split('\n').pop();
      }
      bm.ready = true;
      return captured;
    };
    for (const [i, b] of (t.backends ?? []).entries()) {
      const image = checkPinned(b.image, `backend ${i}`);
      const imageId = await dk.image(image, L(`backend-${i}`), `backend ${i}`);
      vars[`host${i}`] = `b${i}`;
      vars[`port${i}`] = String(b.port);
      if (i === 0) vars.host = 'b0';
      const capAdd = backendCaps(b, `backend ${i}`);
      const bm = { image, image_id: imageId, container_port: b.port, cap_add: capAdd, cap_add_default: b.cap_add === undefined, ready: null };
      meta.backends.push(bm);
      await startBackend(i, b, bm, deadline, vars);
    }
    /**
     * D5: fresh state between full repeats. Re-running a seed against the used database could fail
     * (CREATE TABLE twice) or leave the last repeat's rows, so each backend is removed with its
     * anonymous volumes and started again from its pinned image, waited for, and seeded by the same
     * `setup` steps. Returns the names of set-up captures whose value changed: the manifest was filled
     * with the first values, so a repeat with other values would not test the same fixture.
     */
    const resetBackends = async (d) => {
      const v = { ...vars };
      const changed = [];
      for (const [i, b] of (t.backends ?? []).entries()) {
        await dk.d(['rm', '-f', '-v', backendName(i)], { log: L(`backend-${i}`), deadline: d });
        const bm = meta.backends[i];
        bm.resets = (bm.resets ?? 0) + 1;
        const got = await startBackend(i, b, bm, d, v);
        for (const [k, x] of Object.entries(got)) if (x !== vars[k]) changed.push(k);
      }
      return changed;
    };

    // 5. Set-up in the target's work folder, in a sandbox container on the internal network.
    const command = fill(t.server.command, vars);
    const senv = fill(t.server.env ?? {}, vars);
    const envRun = sandboxEnv(plan.bin, senv);
    // runSetup runs the list's set-up steps; again before every full repeat after the first (D5).
    const runSetup = async (d, first) => {
      for (const [k, line] of (t.setup ?? []).entries()) {
        if (typeof line !== 'string') {
          // B: a pinned tarball instead of a git step. Our helper fetches it on the install network
          // (no target code runs meanwhile: every sandbox container of the target has exited) and
          // verifies its sha256; only a verified file is unpacked, by tar in a sandbox container with
          // no network, as data. The driver checks the helper's sha256 line against the pin as well.
          const f = checkFetch(line, `set-up ${k}`);
          const file = `${P.work}/.fetch/${k}.tgz`;
          const caEnv = envInstall.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: envInstall.NODE_EXTRA_CA_CERTS } : {};
          const r = await dk.helper({ target: t.id, user: SANDBOX_USER, network: egress.name, env: caEnv, mounts: [{ src: vol, dst: P.work }, { src: ctx.cliVol, dst: P.cli, ro: true }],
            cmd: ['node', `${SANDBOX_TOOLS}/fetch.mjs`, f.url, f.sha256, file, String(FETCH_CAP)] }, { log: L('setup'), deadline: d, keepStdout: true });
          if (r.timed_out) throw Object.assign(new HarnessError(`set-up ${k} fetch: time limit`), { timeout: true });
          if (r.spawn_error || r.exit !== 0) throw new HarnessError(`set-up ${k} fetch: refused or failed (exit ${r.exit})`);
          const got = /^sha256 ([0-9a-f]{64}) bytes (\d+)$/m.exec(r.stdout);
          if (!got || got[1] !== f.sha256) throw new HarnessError(`set-up ${k} fetch: sha256 is not the pinned one`);
          if (first) meta.setup_fetch.push({ step: k, url: f.url, sha256: got[1], bytes: Number(got[2]), dest: f.dest, strip_components: f.strip });
          await must(dk.sandbox({ log: L('setup'), deadline: d, network: 'none', mounts, env: envRun, target: t.id,
            cmd: ['sh', '-c', 'mkdir -p "$2" && tar -xzf "$1" -C "$2" --no-same-owner --no-same-permissions --strip-components="$3" && rm -f "$1"', 'sh', file, `${P.work}/${f.dest}`, String(f.strip)] }), `set-up ${k} unpack`);
          continue;
        }
        await must(dk.sandbox({ log: L('setup'), deadline: d, network: internal.name, mounts, env: { ...envRun, TDIR: P.work }, cmd: ['sh', '-c', fill(line, vars)], target: t.id }), 'set-up');
      }
    };
    await runSetup(deadline, true);

    // 5b. D1: the server surface (initialize and tools/list, nothing else), by our probe in a sandbox
    //     container like the CLI's, starting the same server. For the record only; the probe's
    //     output is written by the host to surface.json and never printed.
    const sv = await dk.sandbox({ log: L('surface'), deadline: Math.min(deadline, Date.now() + SURFACE_MS + 30_000), network: internal.name, mounts, env: envRun, target: t.id, keepStdout: true, logStdout: false,
      cmd: ['node', `${SANDBOX_TOOLS}/surface.mjs`, SURFACE_PROTOCOL, String(SURFACE_MS), '--', ...command] });
    // The probe's stdout is untrusted (the server shares its container and user): surfaceDoc
    // type-checks it, and nothing here may stop the target (a hostile, deeply nested answer that
    // cannot be serialised gives surface: null with the reason).
    delete meta.surface_why;
    try {
      const probe = safeJson(sv.stdout.trim().split('\n').pop() ?? '');
      if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
        meta.surface_why = `the surface probe gave no answer (exit ${sv.exit}${sv.timed_out ? ', time limit' : ''}${sv.stdout_truncated ? ', output over the capture cap' : ''})`;
      } else {
        const doc = surfaceDoc(probe);
        const sm = surfaceMeta(doc, 'surface.json');
        writeFileSync(join(odir, 'surface.json'), JSON.stringify(doc) + '\n');
        Object.assign(meta, sm);
        if (meta.surface) meta.surface.step = { exit: sv.exit, ms: sv.ms, timed_out: sv.timed_out };
      }
    } catch (e) {
      rmSync(join(odir, 'surface.json'), { force: true });
      meta.surface = null;
      meta.surface_why = `the surface probe's answer could not be recorded: ${String(e?.message ?? e).slice(0, 200)}`;
    }

    // 6. The manifests: the init draft (archived as data), then the one the CLI runs.
    const cliStep = async (name, argv, d = deadline) => {
      const r = await dk.sandbox({ log: L(name), deadline: d, network: internal.name, mounts, env: envRun, cmd: ['node', CLI_MAIN, ...argv], keepStdout: true, target: t.id });
      const step = { step: name, exit: r.exit, signal: r.signal, timed_out: r.timed_out, spawn_error: r.spawn_error, container: true, ms: r.ms };
      meta.steps.push(step);
      return { r, step };
    };
    // The server's stderr is kept (C1): init and catalog start it through serverWrap. A hand-written
    // full manifest is run as written (its plan hash was accepted by a person), so it is not wrapped.
    if (t.init !== false) {
      const { step } = await cliStep('init', ['init', '--out', `${P.out}/init-draft.yaml`, ...Object.keys(senv).flatMap((k) => ['--env', k]), '--', ...serverWrap(command)]);
      step.informational = true; // init's result is data: a draft that fails is recorded, not judged
    }
    const manifestText = t.full?.manifest ? fillManifest(t.full.manifest, vars) : catalogManifest(serverWrap(command), Object.keys(senv), `mwsv-corpus-${t.id}`);
    await put(`${P.work}/writecheck.yaml`, Buffer.from(manifestText), L('plan'));
    writeFileSync(join(odir, 'writecheck.yaml'), manifestText);
    meta.manifest_sha256 = sha256Text(manifestText);
    const manifest = `${P.work}/writecheck.yaml`;

    // D3: the backends' state as text, before the first CLI step that writes and after the last.
    // With repeats, also before and after each repeat (backend-N-full-I-before.txt / -after.txt).
    const takeSnapshots = async (when, rep, d) => {
      for (const [i, b] of snapping) {
        const e = states.get(i);
        const r = await dk.d(['exec', ...(b.snapshot.user ? ['-u', b.snapshot.user] : []), backendName(i), ...fill(b.snapshot.exec, vars)],
          { log: L(`backend-${i}`), deadline: Math.min(d, Date.now() + SMALL_STEP_MS), keepStdout: true, logStdout: false, raw: true });
        const ok = !r.timed_out && !r.spawn_error && r.exit === 0;
        const why = ok ? null : `snapshot exec: exit ${r.exit}${r.timed_out ? ' (time limit)' : ''}`;
        const rec = (file) => {
          writeFileSync(join(odir, file), r.stdout);
          return { file, sha256: createHash('sha256').update(r.stdout).digest('hex'), bytes: r.stdout.length, ...(r.stdout_truncated ? { truncated: true } : {}) };
        };
        const contract = `backend-${i}-${when}.txt`;
        if (when === 'after' || rep === 1) {
          if (ok) {
            e[when] = rec(contract);
            delete e[`${when}_why`];
          } else {
            rmSync(join(odir, contract), { force: true });
            e[when] = null;
            e[`${when}_why`] = why;
          }
        }
        if (e.repeats) {
          let er = e.repeats.find((x) => x.i === rep);
          if (!er) e.repeats.push((er = { i: rep }));
          er[when] = ok ? rec(`backend-${i}-full-${rep}-${when}.txt`) : null;
          if (!ok) er[`${when}_why`] = why;
        }
      }
    };

    // 7. plan, catalog, and full where a person accepted the plan hash. The first CLI step that does
    //    not complete decides the target's status; later steps still run when they can.
    const decisive = [];
    const planStep = await cliStep('plan', ['plan', '-m', manifest]);
    meta.plan_hash = (/^plan hash: ([0-9a-f]{16})$/m.exec(planStep.r.stdout) ?? [])[1] ?? null;
    decisive.push(planStep.step);
    const cat = await cliStep('catalog', ['catalog', '-m', manifest, '--out', `${P.out}/results`]);
    decisive.push(cat.step);
    if (t.full && t.full.plan_hash) {
      if (meta.plan_hash !== t.full.plan_hash) {
        meta.plan_drift = { accepted: t.full.plan_hash, seen: meta.plan_hash };
      } else {
        // D5: `full.repeats` runs against fresh state, each into results/full-<i>/ with its own state
        // folder. Every repeat after the first is planned again first and refused unless its plan
        // hash is the accepted one (the same for every repeat).
        for (let i = 1; i <= lim.repeats; i++) {
          const rd = lim.full_s ? Date.now() + lim.full_s * 1000 : deadline;
          const fr = { i, results_dir: `sandbox/results/full-${i}`, cli_exit: null, writes: null, status: null, plan_hash: null, fresh_state: null };
          meta.full_runs.push(fr);
          if (i > 1) {
            // Fresh state: /work back to its clean copy, the backends started again and seeded, the
            // list's set-up run again, the manifest written again. A step that fails stops the target
            // (harness error) and is named in this repeat's `why`.
            try {
              if (clean) await must(dk.helper({ target: t.id, user: SANDBOX_USER, mounts: [{ src: vol, dst: P.work }, { src: clean, dst: P.clean, ro: true }], cmd: ['sh', '-c', RESTORE_WORK] }, { log: L('fresh-state'), deadline: rd }), `restore /work for repeat ${i}`);
              if (t.backends?.length) {
                const changed = await resetBackends(rd);
                if (changed.length) {
                  fr.status = 'not_started';
                  fr.fresh_state = false;
                  fr.fresh_state_why = fr.why = `a set-up capture changed after the reset (${changed.join(', ')})`;
                  break;
                }
              }
              await runSetup(rd, false);
              await put(`${P.work}/writecheck.yaml`, Buffer.from(manifestText), L(`plan-${i}`), rd);
            } catch (e) {
              fr.fresh_state = false;
              fr.why = `reset before repeat ${i}: ${String(e?.message ?? e).slice(0, 200)}`;
              throw e;
            }
            fr.reset = [clean ? '/work restored from its clean copy' : null, t.backends?.length ? 'backends started again from their images and seeded' : null, t.setup?.length ? 'set-up run again' : null].filter(Boolean).join('; ') || 'nothing to reset';
            fr.fresh_state = !!clean;
            if (!clean) fr.fresh_state_why = meta.fresh_state_why ?? 'no clean copy of /work';
            const p = await cliStep(`plan-${i}`, ['plan', '-m', manifest], rd);
            fr.plan_hash = (/^plan hash: ([0-9a-f]{16})$/m.exec(p.r.stdout) ?? [])[1] ?? null;
            if (classifyCli(p.step) !== 'completed') {
              decisive.push(p.step);
              fr.status = 'not_started';
              fr.why = `plan-${i} did not complete`;
              break;
            }
            if (fr.plan_hash !== t.full.plan_hash) {
              fr.status = 'not_started';
              fr.why = 'the plan hash is not the accepted one; no later repeat runs';
              meta.plan_drift_repeat = { i, accepted: t.full.plan_hash, seen: fr.plan_hash };
              break;
            }
          } else {
            fr.plan_hash = meta.plan_hash;
            fr.fresh_state = true; // the state install, set-up and the seeds left; no full run before it
          }
          await takeSnapshots('before', i, rd);
          const full = await cliStep(i === 1 ? 'full' : `full-${i}`, ['run', '-m', manifest, '--confirm-target', t.full.confirm, '--plan-hash', t.full.plan_hash, '--out', `${P.out}/results/full-${i}`, '--state', `${P.out}/state/full-${i}`], rd);
          decisive.push(full.step);
          fr.cli_exit = full.step.exit;
          fr.status = classifyCli(full.step);
          fr.ms = full.step.ms;
          await takeSnapshots('after', i, rd);
        }
      }
    }
    for (const s of decisive) {
      const c = classifyCli(s);
      if (c !== 'completed') {
        meta.status = c;
        meta.cli_exit = s.exit;
        meta.failed_step = s.step;
        break;
      }
      meta.cli_exit = Math.max(meta.cli_exit ?? 0, s.exit ?? 0);
    }
    // A known CLI problem on this target (t.expect: { step, exit, error: regex, issue }) is recorded
    // as expected and does not turn the shard red, so a new problem stays visible; when it stops
    // happening the target is marked for the expectation to be removed (the dogfood pattern).
    if (t.expect) {
      const lg = join(odir, 'logs', `${t.expect.step}.log`);
      const err = existsSync(lg) ? ([...readFileSync(lg, 'utf8').matchAll(/^error: .*$/gm)].pop()?.[0] ?? '') : '';
      const hit = meta.failed_step === t.expect.step && meta.cli_exit === t.expect.exit && new RegExp(t.expect.error).test(err);
      if (hit) meta.status = 'expected_cli_error';
      else if (meta.status === 'completed') meta.expectation_flipped = t.expect.issue ?? true;
      meta.expect = t.expect;
    }
  } catch (e) {
    meta.status = e.timeout ? 'timeout' : 'harness_error';
    meta.harness_error = String(e.message ?? e);
  } finally {
    for (const fr of meta.full_runs) {
      if (fr.status !== null) continue;
      fr.status = 'not_started';
      fr.why ??= meta.harness_error ? `the target stopped: ${meta.status}` : 'the target stopped';
      if (fr.fresh_state === null) fr.fresh_state_why ??= 'the repeat did not start';
    }
    try { await finishTarget(); } catch (e) {
      // One target's output must never stop the shard: record it and go on to the next target.
      meta.status = 'harness_error';
      meta.harness_error = `record: ${String(e?.message ?? e).slice(0, 200)}`;
    }
    meta.public_exit = publicExit(meta);
    meta.ended = now();
    writeMeta();
  }
  return meta;

  /**
   * meta.json, whatever is in it: a record that cannot be serialised or written turns this target into
   * a harness error with a minimal record, and never stops the shard.
   */
  function writeMeta() {
    let text;
    try {
      text = JSON.stringify(meta, null, 2) + '\n';
    } catch (e) {
      meta.status = 'harness_error';
      meta.harness_error = `record: meta.json could not be serialised: ${String(e?.message ?? e).slice(0, 200)}`;
      meta.public_exit = publicExit(meta);
      text = JSON.stringify({ format: meta.format, label: meta.label, target: { id: t.id }, status: meta.status, harness_error: meta.harness_error, public_exit: meta.public_exit, started: meta.started, ended: meta.ended }, null, 2) + '\n';
    }
    try {
      writeFileSync(join(odir, 'meta.json'), text);
    } catch (e) {
      meta.status = 'harness_error';
      meta.harness_error = `record: meta.json could not be written: ${String(e?.message ?? e).slice(0, 200)}`;
      meta.public_exit = publicExit(meta);
    }
  }

  async function finishTarget() {
    const lg = L('teardown');
    for (const [i] of (t.backends ?? []).entries()) {
      await dk.d(['logs', backendName(i)], { log: lg, deadline: Date.now() + 60_000 });
    }
    // Every container of this target (backends, and any sandbox still running) goes first, so the
    // copy below reads a volume nothing can write any more.
    await dk.sweep(lg, t.id);
    if (vol) {
      // The CLI's results folders, the ledger of a full run, the init draft: target-writable data,
      // kept under sandbox/ so that it can never replace meta.json or a log of ours.
      const c = await copyOut(dk, vol, join(odir, 'sandbox'), lg, t.id);
      meta.copy_out = { bytes: c.bytes, over_cap: c.capped, timed_out: c.timed_out, non_regular_removed: c.removed };
      if (!c.ok && meta.status === 'completed') {
        meta.status = 'harness_error';
        meta.harness_error = c.capped ? 'copy-out: over the size cap' : c.timed_out ? 'copy-out: time limit' : 'copy-out failed';
      }
      await dk.d(['volume', 'rm', '-f', vol], { log: lg });
    }
    if (cleanVol) {
      await dk.d(['volume', 'rm', '-f', cleanVol], { log: lg });
    }
    for (const n of ['egress', 'run']) await dk.d(['network', 'rm', `corpus-${tag}-${n}`], { log: lg });
    // The server's stderr, as the stderr-tee kept it (sizes and hashes only in meta; the files stay
    // in sandbox/server-stderr/, in the encrypted bundle). Target-writable data like the rest.
    const sdir = join(odir, 'sandbox', 'server-stderr');
    if (existsSync(sdir) && lstatSync(sdir).isDirectory()) {
      meta.server_stderr = readdirSync(sdir).sort().filter((f) => lstatSync(join(sdir, f)).isFile())
        .map((f) => ({ file: `sandbox/server-stderr/${f}`, bytes: lstatSync(join(sdir, f)).size, sha256: sha256File(join(sdir, f)) }));
    }
    const draft = join(odir, 'sandbox', 'init-draft.yaml');
    if (existsSync(draft) && lstatSync(draft).isFile()) meta.init_draft_sha256 = sha256File(draft);
    // results/<run>/results.json, and one level deeper for the full repeats (results/full-<i>/<run>/).
    // Only run.status and run.writes are kept of each results.json (readRunFields), and at most
    // RESULTS_MAX folders are recorded: the folders and files are target-writable.
    const fields = new Map();
    const take = (rel) => {
      const f = join(odir, rel, 'results.json');
      if (!existsSync(f) || !lstatSync(f).isFile()) return false;
      if (meta.results.length >= RESULTS_MAX) {
        meta.results_omitted = (meta.results_omitted ?? 0) + 1;
        return true;
      }
      const rf = readRunFields(f);
      fields.set(rel, rf);
      meta.results.push({ folder: rel, sha256: sha256File(f), status: rf.too_large ? 'too large to read' : rf.status });
      return true;
    };
    const rdir = join(odir, 'sandbox', 'results');
    if (existsSync(rdir) && lstatSync(rdir).isDirectory()) {
      for (const r of readdirSync(rdir)) {
        if (take(`sandbox/results/${r}`)) continue;
        const sub = join(rdir, r);
        if (/^full-\d+$/.test(r) && lstatSync(sub).isDirectory()) for (const x of readdirSync(sub).sort()) take(`sandbox/results/${r}/${x}`);
      }
    }
    for (const fr of meta.full_runs) {
      const mine = meta.results.filter((x) => x.folder.startsWith(`${fr.results_dir}/`));
      if (mine.length !== 1) {
        fr.writes = null;
        fr.writes_why = mine.length ? 'more than one results folder' : 'no results.json';
        continue;
      }
      const rf = fields.get(mine[0].folder);
      fr.results = mine[0].folder;
      fr.run_status = mine[0].status;
      fr.writes = rf.writes;
      if (fr.writes === null) fr.writes_why = rf.writes_why ?? rf.why;
    }
    // D4: each copied config-source file, as it came back (the server under test ran later with
    // /work writable, so a change after the copy is recorded, never hidden).
    for (const f of meta.config_source ?? []) {
      const p = join(odir, 'sandbox', 'config-source', ...f.path.split('/'));
      let now256 = null;
      try { if (lstatSync(p).isFile()) now256 = sha256File(p); } catch {}
      if (now256 !== f.sha256) {
        f.changed_after_copy = true;
        f.sha256_in_bundle = now256;
      }
    }
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Tar of the built CLI package (what the containers need: package.json, dist, schema, runtime deps). */
function cliTar(cliDir) {
  return new Promise((done, fail) => {
    const parts = ['package.json', 'dist', 'schema', 'node_modules'].filter((p) => existsSync(join(cliDir, p)));
    const c = spawn('tar', ['-C', cliDir, '--exclude=node_modules/typescript', '--exclude=node_modules/@types', '--exclude=node_modules/.cache', '-cf', '-', ...parts], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    c.stdout.on('data', (x) => chunks.push(x));
    c.on('error', fail);
    c.on('close', (code) => (code === 0 ? done(Buffer.concat(chunks)) : fail(new HarnessError('CLI tar failed'))));
  });
}

/** Tar of corpus/sandbox/*.mjs (our helpers that run inside containers), and its sha256. */
function sandboxToolsTar() {
  const dir = join(here, 'sandbox');
  const files = readdirSync(dir).filter((f) => /^[a-z-]+\.mjs$/.test(f)).sort();
  return new Promise((done, fail) => {
    const c = spawn('tar', ['-C', dir, '-cf', '-', ...files], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    c.stdout.on('data', (x) => chunks.push(x));
    c.on('error', fail);
    c.on('close', (code) => {
      if (code !== 0) return fail(new HarnessError('sandbox tools tar failed'));
      done({ buf: Buffer.concat(chunks), sha256: Object.fromEntries(files.map((f) => [f, sha256File(join(dir, f))])) });
    });
  });
}

async function context(o) {
  const cliDir = resolve(o.cli);
  const cliEntry = join(cliDir, 'dist', 'src', 'cli', 'main.js');
  if (!existsSync(cliEntry)) throw new HarnessError('the CLI entry script is missing');
  const sink = join(o.out, '_shard', 'context.log');
  const dl = Date.now() + 120_000;
  // Our own CLI, on the host, for its version and requirement list only (no target is involved).
  const q = async (cmd, argv, env = dockerEnvFrom(process.env)) => (await run(cmd, argv, { cwd: o.out, env, log: sink, deadline: dl, keepStdout: true })).stdout.trim();
  const version = await q(process.execPath, [cliEntry, 'version']);
  const reqs = await q(process.execPath, [cliEntry, 'requirements']);
  let commit = o.cliCommit;
  if (!commit) commit = (await q('git', ['-C', cliDir, 'rev-parse', 'HEAD'])) || null;
  const images = JSON.parse(readFileSync(o.images, 'utf8'));
  for (const k of ['runtime', 'uv']) checkPinned(images[k], `images.json ${k}`);
  // D2: the CLI build carries no spec document, only the name of the text it follows (SPEC_TEXT in
  // its requirements module). The workflow checks out spec/mws.md from the same CLI commit, beside
  // the package; its sha256 is recorded (--spec names another file).
  const specFile = o.spec ? resolve(o.spec) : join(cliDir, '..', '..', 'spec', 'mws.md');
  const specOk = existsSync(specFile) && lstatSync(specFile).isFile();
  const reqJs = join(cliDir, 'dist', 'src', 'requirements.js');
  // spec_ref: the reference the CLI build says it follows (SPEC_TEXT, e.g. spec/0.9-review@15f71e5).
  const specRef = existsSync(reqJs) ? (/SPEC_TEXT = ['"]([\w./@:+-]{1,200})['"]/.exec(readFileSync(reqJs, 'utf8')) ?? [])[1] ?? null : null;
  const runner = {
    lane: o.lane,
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    runner_os: process.env.RUNNER_OS ?? null,
    runner_arch: process.env.RUNNER_ARCH ?? null,
    platform: `${platform()} ${release()} ${arch()}`,
    os_version: platform() === 'darwin' ? await q('sw_vers', ['-productVersion']) : await q('sh', ['-c', '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || true']),
    node: process.version,
    docker: await q('docker', ['version', '--format', '{{.Server.Version}}']),
  };
  return {
    o,
    out: o.out,
    cliDir,
    cli: { commit, version, entry_sha256: sha256File(cliEntry), requirements_sha256: sha256Text(reqs) },
    spec: { version: (/\(MWS ([0-9.]+)\)/.exec(version) ?? [])[1] ?? null, requirements: reqs.split('\n').filter((l) => /^MWS-/.test(l.trim())).length },
    runner,
    images,
    github: process.env.GITHUB_RUN_ID
      ? { repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA, workflow: process.env.GITHUB_WORKFLOW, event: process.env.GITHUB_EVENT_NAME }
      : null,
    runId: ((process.env.GITHUB_RUN_ID ?? `l${Date.now().toString(36)}`) + `s${o.shard}`).toLowerCase().replace(/[^a-z0-9]/g, ''),
    env: {
      docker_server_version: runner.docker || null,
      ...(runner.docker ? {} : { docker_server_version_why: 'docker version printed nothing' }),
      runner_image: runner.image_os && runner.image_version ? `${runner.image_os}/${runner.image_version}` : null,
      ...(runner.image_os && runner.image_version ? {} : { runner_image_why: 'not a GitHub-hosted runner (ImageOS and ImageVersion are not set)' }),
      cli_commit: commit ?? null,
      ...(commit ? {} : { cli_commit_why: 'no --cli-commit and the CLI folder is not a git checkout' }),
      cli_version: (/ (\d+\.\d+\.\d+[^\s)]*)/.exec(version) ?? [])[1] ?? null,
      ...(/ \d+\.\d+\.\d+/.test(version) ? {} : { cli_version_why: 'the CLI printed no version' }),
      spec_sha256: specOk ? sha256File(specFile) : null,
      ...(specOk ? { spec_file: o.spec ? 'given with --spec' : 'spec/mws.md at the CLI commit' } : { spec_sha256_why: 'no spec document beside the CLI package (the CLI build itself carries none)' }),
      // Key on spec_ref (the text the CLI follows). spec_sha256 hashes spec/mws.md at the CLI commit,
      // which can be a later text than spec_ref names.
      spec_ref: specRef,
      ...(specRef ? {} : { spec_ref_why: 'the CLI build names no SPEC_TEXT' }),
    },
    isolation: { kind: 'container', user: SANDBOX_USER, cap_drop: 'ALL', no_new_privileges: true, read_only_root: true, mounts: 'named volumes only', install_network: 'bridge (egress)', run_network: 'internal', cpus: null, backend_cap_allowlist: [...BACKEND_CAPS], server_stderr_cap: STDERR_CAP },
  };
}

/** Shard set-up on the Docker side: platform, pinned images pulled, the CLI volume. */
async function prepareDocker(ctx, dk) {
  const log = join(ctx.out, '_shard', 'docker.log');
  const v = await dk.d(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], { log, keepStdout: true });
  if (v.exit !== 0) throw new HarnessError('docker is not available');
  ctx.plat = platformKey(v.stdout);
  ctx.runner.container_platform = ctx.plat;
  checkDockerVersion(ctx.runner.docker);
  const ncpu = Number((await dk.d(['info', '--format', '{{.NCPU}}'], { log, keepStdout: true })).stdout.trim());
  ctx.cpus = Number.isInteger(ncpu) && ncpu >= 1 ? Math.min(CPUS, ncpu) : 1;
  ctx.isolation.cpus = ctx.cpus;
  ctx.imageInfo = {};
  // uv is fetched only when a PyPI target needs it (ensureTools).
  ctx.imageInfo.runtime = { ref: ctx.images.runtime, id: await dk.image(ctx.images.runtime, log, 'runtime image') };
  // The CLI, read-only in every target container. Copied through stdin: no host path is mounted.
  ctx.cliVol = await dk.volume(`corpus-${ctx.runId}-cli`, log);
  const tarBuf = await cliTar(ctx.cliDir);
  await must(dk.helper({ mounts: [{ src: ctx.cliVol, dst: P.cli }], stdin: true, cmd: ['tar', '-x', '-f', '-', '--no-same-owner', '-C', P.cli] }, { log, input: tarBuf }), 'CLI volume');
  // Our in-container helpers (corpus/sandbox/), read-only beside the CLI.
  const tools = await sandboxToolsTar();
  ctx.sandboxTools = tools.sha256;
  await must(dk.helper({ mounts: [{ src: ctx.cliVol, dst: P.cli }], stdin: true, cmd: ['sh', '-c', 'mkdir -p "$1" && tar -x -f - --no-same-owner -C "$1"', 'sh', SANDBOX_TOOLS] }, { log, input: tools.buf }), 'sandbox tools');
  ctx.installCa = null;
  if (process.env.CORPUS_INSTALL_CA_FILE) {
    // The CA goes on the CLI volume (read-only in every target container), readable by the sandbox user, before any target runs.
    const ca = readFileSync(process.env.CORPUS_INSTALL_CA_FILE);
    await must(dk.helper({ mounts: [{ src: ctx.cliVol, dst: P.cli }], stdin: true, cmd: ['sh', '-c', 'd=$(dirname "$1") && mkdir -p "$d" && cat > "$1" && chmod 0755 "$d" && chmod 0444 "$1"', 'sh', INSTALL_CA] }, { log, input: ca }), 'install CA');
    ctx.installCa = sha256Text(ca);
  }
  ctx.toolsVol = null;
  let toolsReady = null;
  ctx.ensureTools = () => {
    toolsReady ??= (async () => {
      const ref = ctx.images.uv;
      ctx.imageInfo.uv = { ref, id: await dk.image(ref, log, 'uv image') };
      const vol = await dk.volume(`corpus-${ctx.runId}-tools`, log);
      const c = `corpus-${ctx.runId}-uvsrc`;
      await must(dk.d(['create', '--name', c, ...Object.entries(dk.labels()).flatMap(([k, val]) => ['--label', `${k}=${val}`]), ref], { log }), 'uv create');
      const t = await must(dk.d(['cp', `${c}:/uv`, '-'], { log, keepStdout: 'buffer' }), 'uv copy');
      await dk.d(['rm', '-f', c], { log });
      await must(dk.helper({ mounts: [{ src: vol, dst: P.tools }], stdin: true, cmd: ['tar', '-x', '-f', '-', '--no-same-owner', '-C', P.tools] }, { log, input: t.stdout }), 'tools volume');
      ctx.toolsVol = vol;
    })();
    return toolsReady;
  };
}

async function main() {
  let o;
  let failed = false;
  let dk = null;
  say(LABEL);
  try {
    o = args(process.argv.slice(2));
    mkdirSync(join(o.out, '_shard'), { recursive: true });
    const raw = readFileSync(o.targets);
    if (o.consumeTargets) rmSync(o.targets, { force: true }); // no clear-text list on disk while targets run
    const list = JSON.parse(raw.toString('utf8'));
    // Every entry is checked at load (capabilities, set-up forms, snapshots, repeats, a dropped id):
    // one that fails is refused before anything of it is fetched or started; the others run.
    const { invalid, dropped } = validateList(list);
    const seed = process.env.CORPUS_ORDER_SEED || randomBytes(16).toString('hex');
    const inShard = list.targets
      .filter((t) => (t.lane ?? 'ci') === o.lane && t.enabled !== false)
      .filter((t) => !o.only || o.only.includes(t.id))
      .filter((_, i) => i % o.shards === o.shard - 1);
    // D8: on the CI lane, the shard's planned time must fit one job (SHARD_BUDGET_S), before anything runs.
    if (o.lane === 'ci') checkShardBudget(inShard, list.defaults ?? {}, invalid);
    const mine = shuffled(inShard, seed);
    const ctx = await context(o);
    ctx.defaults = list.defaults ?? {};
    ctx.invalid = invalid;
    ctx.dropped = dropped;
    dk = new Docker(ctx, join(o.out, '_shard', 'docker.log'));
    await prepareDocker(ctx, dk);
    const shard = { format: RUN_FORMAT, label: LABEL, lane: o.lane, shard: o.shard, shards: o.shards, targets_list_sha256: createHash('sha256').update(raw).digest('hex'), targets_list_updated: list.updated ?? null, order_seed: seed, order: mine.map((t) => t.id), cli: ctx.cli, spec: ctx.spec, runner: ctx.runner, images: ctx.imageInfo, sandbox_tools_sha256: ctx.sandboxTools, isolation: ctx.isolation, github: ctx.github, started: now(), targets: [] };
    for (const t of mine) {
      let m;
      try {
        m = await runTarget(t, o, ctx, dk);
      } catch (e) {
        // runTarget records and returns; should it ever throw, this target alone is lost, not the shard.
        try { writeFileSync(join(o.out, '_shard', `target-error-${t.id}.txt`), `${now()}\n${e?.stack ?? e}\n`); } catch {}
        m = { status: 'harness_error', cli_exit: null, public_exit: 125, results: [] };
      }
      shard.targets.push({ id: t.id, status: m.status, cli_exit: m.cli_exit, public_exit: m.public_exit, results: m.results.map((r) => r.sha256) });
      say(`run finished, exit ${m.public_exit}`);
      if (m.public_exit !== 0) failed = true;
    }
    shard.ended = now();
    writeFileSync(join(o.out, '_shard', 'shard.json'), JSON.stringify(shard, null, 2) + '\n');
  } catch (e) {
    // A harness failure: the message may name a target, so it goes to a file, not to the log.
    try {
      const out = o?.out ?? '.';
      mkdirSync(join(out, '_shard'), { recursive: true });
      writeFileSync(join(out, '_shard', 'harness-error.txt'), `${now()}\n${e?.stack ?? e}\n`);
    } catch {}
    say('run finished, exit 125');
    failed = true;
  } finally {
    if (dk) await dk.sweep(join(o.out, '_shard', 'docker.log')).catch(() => {});
  }
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // An unexpected rejection must not print a stack (it can carry a target's name).
  process.on('uncaughtException', () => { say('run finished, exit 125'); process.exit(1); });
  process.on('unhandledRejection', () => { say('run finished, exit 125'); process.exit(1); });
  main();
}
