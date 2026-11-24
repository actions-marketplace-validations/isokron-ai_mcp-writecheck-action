#!/usr/bin/env node
/**
 * The writecheck loop worker's driver: one shard of items from tool-qa's pump, each run through mcp-writecheck in
 * the hardened sandbox of isokron-ai/mcp-surface-corpus, with one result bundle per item.
 *
 *   node loop/run-items.mjs --msc <mcp-surface-corpus checkout> --cli <built packages/writecheck>
 *                           --seed <tool-qa history/seed-v1.json> --out <dir> [--lane ci|local]
 *   env: ITEMS, ATTEMPT_ID, SHARD_ID (the dispatch inputs), CLI_REF, SANDBOX_REF, GITHUB_SHA, GITHUB_OUTPUT
 *
 * The sandbox is mcp-surface-corpus's, used as a library from a checkout at a pinned commit (src/docker.mjs,
 * src/sandbox-run.mjs, src/sandbox-net.mjs, src/runsc.mjs, src/telemetry.mjs, src/targets.mjs and its sandbox/
 * helpers): gVisor (runsc) for every container, user 65534, every capability dropped, a read-only root, limits,
 * named volumes only, an environment of the names the harness sets, an install network whose only way out is the
 * allowlist proxy to the package registry, and a run network with no way out at all (every name resolves to the
 * network logger; the host firewall logs and drops the rest). The workflow runs its self test first.
 *
 * Per item: the subject is mapped to a package (loop/items.mjs), installed in the sandbox, and the CLI runs in
 * the sandbox next to the server it starts, on the run network: init (tools/list), plan (no tool call) and
 * catalog (tools/list only, MWS-ANN-4). For IsoKron's own fixture servers (loop/fixtures.json) whose plan hash a
 * person accepted, also the full write test, against a disposable backend inside the same container. Nothing
 * reaches a real external system: the run network has no egress, and a third-party server is never given a
 * manifest that writes.
 *
 * Controls, once per shard before any item, and copied into every bundle: the forgery control
 * (loop/sandbox/forgery-server.mjs) must come out "contained"; tiny-tracker with a known defect must have its
 * defect detected (known_bad), and without it the same requirement must hold (known_good). If a control fails the
 * driver exits 1 and writes no bundle: nothing is uploaded.
 *
 * Output: <out>/<i>/bundle/ and <out>/<i>/meta.json for every item, and has_<i>, fence_<i>, run_key_<i> in
 * GITHUB_OUTPUT. The log prints positions and codes only, never a subject's output.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { FIXTURE_MANIFEST, InputError, catalogManifest, checkId, loadFixtures, loadSeed, parseItems, resolveSubject } from './items.mjs';
import { ndjson, observations, planHash, publicSummary, summarize } from './summary.mjs';
import { BundleFiles, buildMeta, forgeryVerdict, knownBadVerdict, knownGoodVerdict, parseCollected, safeRawPath } from './bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const say = (line) => process.stdout.write(`${line}\n`);

const TOOLS = '/opt/surface';
const NODE = `${TOOLS}/node/node`;
const CLI_MAIN = `${TOOLS}/wc/dist/src/cli/main.js`;
const LOOP = `${TOOLS}/loop`;
const OUTD = '/work/out';
const MANIFEST = `${OUTD}/writecheck.yaml`;
const PROXY_PORT = 8080;
/** The bridge's port in the server's container (split runs). */
const BRIDGE_PORT = 7300;
const MS = { install: 300_000, setup: 120_000, step: 150_000, full: 900_000, helper: 120_000 };
/** No item starts after this long (the pump's lease for 10 items is 46 minutes; the job stops at 45). */
const SHARD_BUDGET_MS = Number(process.env.LOOP_SHARD_BUDGET_S || 26 * 60) * 1000;
const COLLECT = { file: 4 * 1024 * 1024, total: 24 * 1024 * 1024, entries: 2000 };
/** Each control's captured bytes, copied into every bundle of the shard, stay small. */
const CONTROL_RAW = { fileCap: 1024 * 1024, totalCap: 3 * 1024 * 1024 };

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** The folders of mcp-surface-corpus that go into the tools volume: its in-container helpers and what they import. */
export const MSC_TOOL_DIRS = ['sandbox', 'src'];

/**
 * Relative imports of the .mjs files under `dir` (the staged tools volume) that name a file not there, as
 * "<importer> -> <specifier>". R-WC-01: the network logger imports ../src/dns.mjs, and a volume without src/ made
 * every unit fail at the logger's start.
 */
export function missingImports(dir) {
  const out = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (!existsSync(resolve(dirname(p), spec))) out.push(`${relative(dir, p)} -> ${spec}`);
      }
    }
  };
  walk(dir);
  return out;
}
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function parseArgs(argv) {
  const o = { lane: 'local' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--msc', '--cli', '--seed', '--out', '--lane', '--fixtures'].includes(k) || v === undefined) throw new InputError(`unknown or incomplete argument ${k}`);
    o[k.slice(2)] = v; i++;
  }
  for (const k of ['msc', 'cli', 'seed', 'out']) if (!o[k]) throw new InputError(`--${k} is required`);
  if (!['ci', 'local'].includes(o.lane)) throw new InputError('--lane is ci or local');
  o.fixtures ??= join(here, 'fixtures.json');
  return o;
}

/** The modules of mcp-surface-corpus the driver uses, and every name it takes from them (R-WC-02). */
export const MSC_MODULES = ['src/docker.mjs', 'src/sandbox-run.mjs', 'src/sandbox-net.mjs', 'src/sandbox-env.mjs', 'src/runsc.mjs', 'src/telemetry.mjs', 'src/targets.mjs'];
export const MSC_NEEDS = [
  'Docker', 'HarnessError', 'LIMITS', 'NETS', 'RUNTIME', 'Telemetry', 'checkDockerVersion', 'checkPinned', 'fromProxy', 'helperRunArgs',
  'hostDropsFor', 'isPublicIp4', 'jsonLines', 'launchPlan', 'loadRunscConfig', 'preflight', 'readHostLog', 'rolesOn', 'sandboxRunArgs',
  'settingsDigest', 'settingsManifest', 'startNetlogOn', 'stopNetlog', 'sweepTraces', 'takeTrace', 'watchTraces', 'writeDrops', 'writeNetlog',
];

/** mcp-surface-corpus's sandbox library, from a checkout at a pinned commit; every name the driver uses must be there. */
async function loadMsc(dir) {
  const mods = await Promise.all(MSC_MODULES.map((p) => import(pathToFileURL(join(dir, p)).href)));
  const M = Object.assign({}, ...mods);
  const missing = MSC_NEEDS.filter((n) => M[n] === undefined);
  if (missing.length) throw new Error(`mcp-surface-corpus at this commit does not export ${missing.join(', ')}`);
  return { ...M, dir, images: JSON.parse(readFileSync(join(dir, 'images.json'), 'utf8')) };
}

const runEnv = (extra = {}) => ({ HOME: '/tmp/home', TMPDIR: '/tmp', NO_COLOR: '1', DO_NOT_TRACK: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', npm_config_update_notifier: 'false', SURFACE_SANDBOX: '1', ...extra });

class Shard {
  constructor({ o, M, env }) {
    this.o = o; this.M = M; this.env = env;
    this.runId = randomBytes(6).toString('hex');
    this.out = resolve(o.out);
    this.shardDir = join(this.out, '_shard');
    mkdirSync(join(this.shardDir, 'cid'), { recursive: true });
    this.cidDir = join(this.shardDir, 'cid');
    this.cfg = M.loadRunscConfig(join(M.dir, 'gvisor.json'));
    this.dk = new M.Docker({ runId: this.runId, log: join(this.shardDir, 'docker.log') });
    this.tel = new M.Telemetry(join(this.shardDir, 'telemetry.jsonl'), { run: this.runId });
    this.missing = null;
    this.hostLog = false;
  }

  name(tag, what) { return this.dk.name(tag, what); }

  writeSettings(argv, meta) {
    const manifest = this.M.settingsManifest(argv, { role: meta.role });
    this.tel.write('settings', { digest: this.M.settingsDigest(manifest), manifest }, meta);
  }

  /** A target container's `container` record and its trace summary (or a trace_unavailable skip). */
  async recordContainer({ id, t0, exit = null, signal = null, timedOut = false, meta }) {
    const summary = id ? await this.M.takeTrace(this.cfg, id, { waitMs: 5000 }) : null;
    this.tel.write('container', { runtime: summary ? this.M.RUNTIME : 'unknown', exit: Number.isInteger(exit) ? exit : null, signal: signal ? String(signal).slice(0, 20) : null, timed_out: !!timedOut, oom_killed: null, ms: Date.now() - t0 }, meta);
    if (summary) {
      if (!this.tel.tryWrite('trace_summary', { summary }, { source: 'runsc', ...meta })) this.missing?.push(`a syscall trace record (${meta.role})`);
    } else {
      this.tel.write('skip', { reason: 'trace_unavailable', detail: 'runsc wrote no syscall trace for this container' }, meta);
      this.missing?.push(`a syscall trace (${meta.role})`);
    }
  }

  recordDrops(t0, subject) {
    if (!this.hostLog) return false;
    const log = this.M.readHostLog(Math.floor(t0 / 1000) - 1);
    if (!log.ok) { this.tel.write('skip', { reason: 'host_log_unavailable', detail: 'the kernel log could not be read for this unit' }, { subject }); return false; }
    this.M.writeDrops(this.tel, this.M.hostDropsFor(log.text, { since: t0 / 1000, until: Date.now() / 1000 }), { subject, roles: { ...this.M.rolesOn('install'), ...this.M.rolesOn('run') } });
    return true;
  }

  readCid(file) { try { const s = readFileSync(file, 'utf8').trim(); return /^[0-9a-f]{64}$/.test(s) ? s : null; } catch { return null; } }

  async prepare() {
    const v = await this.dk.d(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'], { keepStdout: true });
    if (v.exit !== 0) throw new this.M.HarnessError('docker is not available');
    const [ver, osArch] = v.stdout.toString().trim().split(' ');
    this.M.checkDockerVersion(ver);
    if (!String(osArch).startsWith('linux/')) throw new this.M.HarnessError('containers must be Linux');
    const ncpu = Number((await this.dk.d(['info', '--format', '{{.NCPU}}'], { keepStdout: true, logStdout: false })).stdout.toString().trim());
    this.cpus = Number.isInteger(ncpu) && ncpu >= 1 ? Math.min(this.M.LIMITS.cpus, ncpu) : 1;
    this.images = this.M.images;
    for (const k of ['node24', 'node22', 'python']) this.M.checkPinned(this.images[k], k);
    await this.dk.image(this.images.node24, 'node24');
  }

  async preflight() {
    const pf = await this.M.preflight(this.dk, {
      cfg: this.cfg, arch: arch(), image: this.images.node24, cmd: ['node', '-e', 'console.log(process.getuid(), process.getgid())'], expect: '65534 65534',
      tel: this.tel, labels: this.dk.labels(), needHostLog: this.o.lane === 'ci', strict: this.o.lane === 'ci',
    });
    if (!pf.ok) throw new this.M.HarnessError(`the sandbox is not there (${pf.reason})`);
    this.hostLog = pf.hostLog;
  }

  /** Our in-container code (mcp-surface-corpus's sandbox/ helpers, loop/sandbox/, the CLI) and Node, read-only everywhere. */
  async prepareTools() {
    this.toolsVol = await this.dk.volume(`surface-${this.runId}-tools`);
    const stage = mkdtempSync(join(tmpdir(), 'wc-tools-'));
    try {
      // mcp-surface-corpus's helpers (the network logger, the egress proxy, the npm entry reader) import its src/.
      for (const d of MSC_TOOL_DIRS) cpSync(join(this.M.dir, d), join(stage, d), { recursive: true });
      cpSync(join(here, 'sandbox'), join(stage, 'loop'), { recursive: true });
      mkdirSync(join(stage, 'wc', 'node_modules'), { recursive: true });
      cpSync(join(this.o.cli, 'dist'), join(stage, 'wc', 'dist'), { recursive: true });
      cpSync(join(this.o.cli, 'package.json'), join(stage, 'wc', 'package.json'));
      cpSync(join(this.o.cli, 'node_modules', 'yaml'), join(stage, 'wc', 'node_modules', 'yaml'), { recursive: true });
      const unresolved = missingImports(stage);
      if (unresolved.length) throw new this.M.HarnessError(`the tools volume would miss what its code imports: ${unresolved.slice(0, 5).join(', ')}`);
      const tar = spawnSync('tar', ['-C', stage, '-cf', '-', '--owner=0', '--group=0', '--mode=a+rX,go-w', ...MSC_TOOL_DIRS, 'loop', 'wc'], { maxBuffer: 256 * 1024 * 1024 });
      if (tar.status !== 0) throw new this.M.HarnessError('packing the tools failed');
      this.toolsSha = sha256(tar.stdout);
      await this.dk.must(this.dk.d(this.M.helperRunArgs({ name: this.name(null, 'h'), image: this.images.node24, user: '0:0', labels: this.dk.labels(), stdin: true, mounts: [{ src: this.toolsVol, dst: TOOLS }], cmd: ['tar', '-x', '-f', '-', '--no-same-owner', '-C', TOOLS] }), { input: tar.stdout, deadline: Date.now() + MS.helper }), 'tools volume');
    } finally { rmSync(stage, { recursive: true, force: true }); }
    // Node for the CLI in every image (the PyPI image has none): the node24 image's own binary. Both images are
    // Debian 12 with libstdc++, which is all it links against.
    await this.dk.must(this.dk.d(this.M.helperRunArgs({ name: this.name(null, 'h'), image: this.images.node24, user: '0:0', labels: this.dk.labels(), mounts: [{ src: this.toolsVol, dst: TOOLS }], cmd: ['sh', '-c', `mkdir -p ${TOOLS}/node && cp /usr/local/bin/node ${NODE} && chmod 0555 ${NODE}`] }), { deadline: Date.now() + MS.helper }), 'node for the CLI');
    this.outNet = await this.dk.network(`surface-${this.runId}-out`, false);
  }

  async resolveRegistries(names) {
    const out = [];
    for (const n of names) {
      let addrs = [];
      try { addrs = (await lookup(n, { all: true, family: 4 })).map((a) => a.address); } catch { /* reported below */ }
      const pub = [...new Set(addrs.filter(this.M.isPublicIp4))].slice(0, 8);
      if (!pub.length) throw new this.M.HarnessError(`the registry ${String(n).slice(0, 60)} has no public IPv4 address`);
      out.push(...pub.map((ip) => [n, ip]));
    }
    return out;
  }

  /** A helper container of ours (never target code): node24 image, no network unless named. */
  helper(tag, o, opts = {}) {
    return this.dk.d(this.M.helperRunArgs({ name: this.name(tag, 'h'), image: this.images.node24, labels: this.dk.labels(tag), cpus: this.cpus, ...o }), { deadline: Date.now() + MS.helper, ...opts });
  }

  /**
   * Install one launch block in the sandbox (mcp-surface-corpus's install path): the install network with the
   * network logger at .2 and the allowlist proxy at .3 as its only way out, the install container at .4.
   */
  async install(u, work, deadline) {
    const M = this.M;
    const plan = M.launchPlan(u.launch);
    if (u.lock) {
      // A fixture installs from its committed lockfile (loop/fixtures/<name>/), every tarball checked against the
      // lock's integrity by npm ci; the package itself must match the integrity pinned in loop/fixtures.json.
      const tar = spawnSync('tar', ['-C', u.lock, '-cf', '-', '--owner=0', '--group=0', 'package.json', 'package-lock.json'], { maxBuffer: 16 * 1024 * 1024 });
      if (tar.status !== 0) throw new M.HarnessError('packing the fixture lockfile failed');
      await this.dk.must(this.helper(u.tag, { stdin: true, mounts: [{ src: work, dst: '/work' }], cmd: ['sh', '-c', 'mkdir -p /work/pkg && tar -x -f - --no-same-owner -C /work/pkg'] }, { input: tar.stdout }), 'fixture lockfile');
      plan.install = [
        { name: 'install', cmd: ['npm', 'ci', '--prefix', '/work/pkg', '--no-audit', '--no-fund', '--loglevel=error', '--omit=dev', ...(u.launch.install_scripts ? [] : ['--ignore-scripts'])] },
        { name: 'entry', cmd: ['node', `${TOOLS}/sandbox/npm-entry.mjs`, '/work/pkg', u.launch.package, u.launch.bin ?? ''], out: 'entry.json' },
      ];
    }
    const image = this.images[plan.image];
    await this.dk.image(image, plan.image);
    const inst = { kind: u.launch.kind, steps: [], ok: false, image: plan.image, resolved_version: null, egress: [] };
    const registries = [...plan.registries, ...(u.installHosts ?? [])];
    const inNet = await this.dk.network(`surface-${this.runId}-${u.tag}-in`, true, u.tag, { sandbox: 'install' });
    const netlog = await M.startNetlogOn(u.tdk, { net: 'install', network: inNet, image: this.images.node24, toolsVol: this.toolsVol, labels: this.dk.labels(u.tag), target: u.tag });
    const proxy = this.name(u.tag, 'proxy');
    let proxyUp = false;
    let entry = null;
    try {
      const publicHosts = await this.resolveRegistries(registries);
      const proxyArgs = M.helperRunArgs({ name: proxy, image: this.images.node24, network: this.outNet, create: true, labels: this.dk.labels(u.tag), memory: '256m', publicHosts, mounts: [{ src: this.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${TOOLS}/sandbox/egress-proxy.mjs`, String(PROXY_PORT), ...registries] });
      this.writeSettings(proxyArgs, { subject: u.tag, role: 'proxy' });
      await this.dk.must(u.tdk.d(proxyArgs), 'egress proxy');
      proxyUp = true;
      await this.dk.must(u.tdk.d(['network', 'connect', '--ip', M.NETS.install.proxy, inNet, proxy]), 'egress proxy network');
      await this.dk.must(u.tdk.d(['start', proxy]), 'egress proxy start');
      for (let until = Date.now() + 30_000; ;) {
        const pl = await u.tdk.d(['logs', proxy], { keepStdout: true, logStdout: false, cap: 64 * 1024, deadline: Date.now() + 10_000 });
        if (M.jsonLines(pl.stdout).some((x) => Number.isInteger(x.listening))) break;
        if (Date.now() >= until) throw new M.HarnessError('the egress proxy did not start');
        await sleep(250);
      }
      const proxyUrl = `http://${M.NETS.install.proxy}:${PROXY_PORT}`;
      let ok = true;
      for (const step of plan.install) {
        if (Date.now() >= deadline) { ok = false; inst.timed_out = true; break; }
        const s1 = Date.now();
        const name = this.name(u.tag, 'i');
        const cidfile = join(this.cidDir, `${name}.cid`);
        const env = {
          HOME: '/work/home', TMPDIR: '/tmp', NO_COLOR: '1', DO_NOT_TRACK: '1', SURFACE_SANDBOX: '1', CI: '1',
          npm_config_cache: '/work/home/.npm', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
          PIP_CACHE_DIR: '/work/home/.cache/pip', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1',
          HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '', no_proxy: '',
          // An install script that fetches a prebuilt binary (a fixture's native module) reads npm's proxy settings.
          npm_config_proxy: proxyUrl, npm_config_https_proxy: proxyUrl,
          ...(step.env ?? {}),
        };
        const argv = M.sandboxRunArgs({ name, image, network: inNet, ip: M.NETS.install.target, resolv: 'install', cidfile, labels: this.dk.labels(u.tag), cpus: this.cpus, workdir: '/work', mounts: [{ src: work, dst: '/work' }, { src: this.toolsVol, dst: TOOLS, ro: true }], env, cmd: step.cmd });
        this.writeSettings(argv, { subject: u.tag, role: 'install' });
        const r = await u.tdk.d(argv, { deadline: Math.min(deadline, Date.now() + MS.install), keepStdout: !!step.out, logStdout: !step.out, cap: 1024 * 1024, onTimeout: () => this.dk.kill(name) });
        await this.recordContainer({ id: this.readCid(cidfile), t0: s1, exit: r.exit, signal: r.signal, timedOut: r.timed_out, meta: { subject: u.tag, role: 'install' } });
        inst.steps.push({ name: step.name, exit: r.exit, timed_out: r.timed_out, ms: Date.now() - s1 });
        if (step.out && step.name === 'entry') {
          let j = null;
          try { j = JSON.parse(r.stdout.toString('utf8')); } catch { /* checked below */ }
          entry = j && typeof j.script === 'string' && j.script.startsWith('/work/pkg/') && !/[\u0000\n]/.test(j.script) ? j : null;
        }
        if (r.exit !== 0 || (step.name === 'entry' && !entry)) { ok = false; if (r.timed_out) inst.timed_out = true; break; }
      }
      inst.ok = ok;
    } finally {
      try { M.writeNetlog(this.tel, await M.stopNetlog(u.tdk, netlog), { subject: u.tag, roles: M.rolesOn('install') }); } finally { await this.dk.kill(netlog); }
      if (proxyUp) {
        const pl = await u.tdk.d(['logs', proxy], { keepStdout: true, logStdout: false, cap: 4 * 1024 * 1024 });
        for (const e of M.jsonLines(pl.stdout).slice(0, 5000)) {
          const x = M.fromProxy(e);
          if (x) { this.tel.tryWrite(x[0], x[1], { source: 'proxy', subject: u.tag, role: 'proxy' }); inst.egress.push({ host: x[1].host, allowed: x[1].allowed }); }
        }
      }
      await this.dk.kill(proxy);
      await this.dk.d(['network', 'rm', inNet], { deadline: Date.now() + 60_000 });
    }
    if (entry && typeof entry.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(entry.version)) inst.resolved_version = entry.version;
    return { inst, plan, entry };
  }

  /** A volume of our own for one unit, /work, with home, lock and out folders owned by the sandbox user. */
  async workVolume(tag) {
    const work = await this.dk.volume(`surface-${this.runId}-${tag}-work`, tag);
    await this.dk.must(this.helper(tag, { user: '0:0', mounts: [{ src: work, dst: '/work' }], capAdd: ['CHOWN'], cmd: ['sh', '-c', 'mkdir -p /work/home /work/lock /work/out && chown -R 65534:65534 /work'] }), 'work volume');
    return work;
  }

  /** Writes a file into the unit's /work/out through a helper (stdin), as the sandbox user. */
  async put(tag, work, path, text) {
    await this.dk.must(this.helper(tag, { stdin: true, mounts: [{ src: work, dst: '/work' }], cmd: ['sh', '-c', 'cat > "$1"', 'sh', path] }, { input: Buffer.from(text) }), 'write a file into the work volume');
  }

  /** The run network (one at a time: its subnet is fixed) with the network logger at .2, for fn(network). */
  async withRunNet(u, fn) {
    const network = await this.dk.network(this.name(u.tag, 'run'), true, u.tag, { sandbox: 'run' });
    let netlog = null;
    try {
      netlog = await this.M.startNetlogOn(u.tdk, { net: 'run', network, image: this.images.node24, toolsVol: this.toolsVol, labels: this.dk.labels(u.tag), target: u.tag });
      return await fn(network);
    } finally {
      if (netlog) {
        try { this.M.writeNetlog(this.tel, await this.M.stopNetlog(u.tdk, netlog), { subject: u.tag, roles: this.M.rolesOn('run', { target: 'server' }) }); } finally { await this.dk.kill(netlog); }
      }
      await this.dk.d(['network', 'rm', network], { deadline: Date.now() + 60_000 });
    }
  }

  /**
   * One step in a sandbox container at .3 of the run network: the CLI (and the server it starts) or a fixture's
   * set-up. Its output (the CLI's and the server's) goes to raw/steps/<step>.log only.
   */
  async sandboxStep(u, { network, work, image, step, cmd, env, timeoutMs, keepStdout = false, record }) {
    const name = this.name(u.tag, 's');
    const cidfile = join(this.cidDir, `${name}.cid`);
    const argv = this.M.sandboxRunArgs({ name, image, network, ip: this.M.NETS.run.target, resolv: 'run', cidfile, labels: this.dk.labels(u.tag), cpus: this.cpus, workdir: OUTD, mounts: [{ src: work, dst: '/work' }, { src: this.toolsVol, dst: TOOLS, ro: true }], env, cmd });
    this.writeSettings(argv, { subject: u.tag, role: 'server' });
    const log = join(u.stepDir, `${step}.log`);
    const t0 = Date.now();
    const r = await this.dk.d(argv, { log, deadline: Date.now() + timeoutMs, keepStdout, cap: 1024 * 1024, logCap: 4 * 1024 * 1024, onTimeout: () => this.dk.kill(name) });
    await this.dk.kill(name);
    await this.recordContainer({ id: this.readCid(cidfile), t0, exit: r.exit, signal: r.signal, timedOut: r.timed_out, meta: { subject: u.tag, role: 'server' } });
    const s = { step, exit: r.exit, timed_out: r.timed_out, ms: Date.now() - t0 };
    record.push(s);
    return { r, s };
  }

  /**
   * A split run (R-WC-05), for every subject and for the forgery control: the server under test runs in a sandbox
   * container of its own at .3 of the run network, behind our bridge (loop/sandbox/bridge.mjs), with its install
   * volume read-only and nothing else of ours; the CLI runs in another sandbox container at .4, as our helper, with
   * the output volume that the server's container never mounts, and reaches the server over TCP through our relay
   * (loop/sandbox/relay.mjs) as if it were a stdio server. Two gVisor sandboxes: the server cannot see the CLI's
   * files or processes, write to its stdout, or signal or trace it. Its only channel to the CLI is the protocol.
   */
  async splitRun(u, { work, image, serverCmd, res, unitDeadline }) {
    const M = this.M;
    const out = await this.dk.volume(`surface-${this.runId}-${u.tag}-out`, u.tag);
    await this.dk.must(this.helper(u.tag, { user: '0:0', mounts: [{ src: out, dst: OUTD }], capAdd: ['CHOWN'], cmd: ['sh', '-c', `chown 65534:65534 ${OUTD}`] }), 'output volume');
    const relay = [NODE, `${LOOP}/relay.mjs`, M.NETS.run.target, String(BRIDGE_PORT)];
    await this.dk.must(this.helper(u.tag, { stdin: true, mounts: [{ src: out, dst: OUTD }], cmd: ['sh', '-c', 'cat > "$1"', 'sh', MANIFEST] }, { input: Buffer.from(catalogManifest(relay, [], `loop-${u.tag}`)) }), 'write the manifest');
    const left = (cap) => Math.max(1000, Math.min(cap, unitDeadline - Date.now()));
    await this.withRunNet(u, async (network) => {
      const name = this.name(u.tag, 's');
      const cidfile = join(this.cidDir, `${name}.cid`);
      const argv = M.sandboxRunArgs({ name, image, network, ip: M.NETS.run.target, resolv: 'run', cidfile, detach: true, labels: this.dk.labels(u.tag), cpus: this.cpus, mounts: [{ src: work, dst: '/work', ro: true }, { src: this.toolsVol, dst: TOOLS, ro: true }], env: runEnv({ ...(u.env ?? {}) }), cmd: [NODE, `${LOOP}/bridge.mjs`, String(BRIDGE_PORT), '--', ...serverCmd] });
      this.writeSettings(argv, { subject: u.tag, role: 'server' });
      const t0 = Date.now();
      await this.dk.must(u.tdk.d(argv, { deadline: Date.now() + 60_000 }), 'server container');
      try {
        for (let until = Date.now() + 30_000; ;) {
          const l = await u.tdk.d(['logs', name], { keepStdout: true, logStdout: false, cap: 64 * 1024, deadline: Date.now() + 10_000 });
          if (M.jsonLines(l.stdout).some((x) => x.listening === BRIDGE_PORT)) break;
          if (Date.now() >= until) throw new M.HarnessError('the server bridge did not start');
          await sleep(250);
        }
        const cliStep = async (step, args, { keepStdout = false } = {}) => {
          const cname = this.name(u.tag, 'c');
          const ccid = join(this.cidDir, `${cname}.cid`);
          const cargv = M.helperRunArgs({ name: cname, image: this.images.node24, network, ip: M.NETS.run.probe, resolv: 'run', cidfile: ccid, labels: this.dk.labels(u.tag), cpus: this.cpus, mounts: [{ src: out, dst: OUTD }, { src: this.toolsVol, dst: TOOLS, ro: true }], env: { HOME: '/tmp', TMPDIR: '/tmp', NO_COLOR: '1' }, cmd: ['sh', '-c', `cd ${OUTD} && exec "$@"`, 'sh', NODE, CLI_MAIN, ...args] });
          this.writeSettings(cargv, { subject: u.tag, role: 'probe' });
          const c0 = Date.now();
          const r = await this.dk.d(cargv, { log: join(u.stepDir, `${step}.log`), deadline: Date.now() + left(MS.step), keepStdout, cap: 1024 * 1024, logCap: 4 * 1024 * 1024, onTimeout: () => this.dk.kill(cname) });
          await this.dk.kill(cname);
          await this.recordContainer({ id: this.readCid(ccid), t0: c0, exit: r.exit, signal: r.signal, timedOut: r.timed_out, meta: { subject: u.tag, role: 'probe' } });
          res.steps.push({ step, exit: r.exit, timed_out: r.timed_out, ms: Date.now() - c0 });
          return r;
        };
        if (u.init !== false) await cliStep('init', ['init', '--out', `${OUTD}/init-draft.yaml`, '--', ...relay]);
        res.planStdout = (await cliStep('plan', ['plan', '-m', MANIFEST], { keepStdout: true })).stdout.toString('utf8');
        await cliStep('catalog', ['catalog', '-m', MANIFEST, '--out', `${OUTD}/results`]);
      } finally {
        const l = await u.tdk.d(['logs', name], { keepStdout: true, logStdout: false, cap: 4 * 1024 * 1024 });
        writeFileSync(join(u.stepDir, 'server.log'), l.stdout);
        await this.dk.kill(name);
        await this.recordContainer({ id: this.readCid(cidfile), t0, exit: null, meta: { subject: u.tag, role: 'server' } });
      }
    });
    const c = await this.helper(u.tag, { mounts: [{ src: out, dst: OUTD, ro: true }, { src: this.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${LOOP}/collect.mjs`, OUTD, String(COLLECT.file), String(COLLECT.total), String(COLLECT.entries)] }, { keepStdout: true, logStdout: false, cap: 48 * 1024 * 1024 });
    const parsed = parseCollected(c.stdout.toString('utf8'));
    res.files = parsed.files;
    res.collected = { exit: c.exit, entries: parsed.entries.length, bad: parsed.bad, done: parsed.done, truncated: c.stdout_truncated, split: true };
  }

  /**
   * One unit (an item or a control) end to end. Returns { steps, install, files, planStdout, fullRan, missing, error }.
   * `u`: { tag, launch | null, forgery?, fixture?, env, init, manifestFile?, link?, background?, setup?, full?, installHosts? }
   */
  async runUnit(u, unitDeadline) {
    const M = this.M;
    u.tdk = Object.create(this.dk);
    u.tdk.log = join(u.stepDir, 'docker.log');
    mkdirSync(u.stepDir, { recursive: true });
    const t0 = Date.now();
    const res = { steps: [], install: null, files: new Map(), planStdout: '', fullRan: false, missing: [], error: null, collected: null };
    this.missing = res.missing;
    const watch = M.watchTraces(this.cfg, { sinceMs: t0, onOverflow: () => this.dk.killAll(u.tag) });
    let work = null;
    try {
      work = await this.workVolume(u.tag);
      let image = this.images.node24;
      let serverCmd;
      let pkgdir = null;
      if (u.forgery) {
        serverCmd = [NODE, `${LOOP}/forgery-server.mjs`];
      } else {
        const { inst, plan, entry } = await this.install(u, work, Math.min(unitDeadline, Date.now() + MS.install * 2));
        res.install = inst;
        if (!inst.ok) return res;
        image = this.images[plan.runImage ?? plan.image];
        serverCmd = plan.run(entry);
        if (u.launch.kind === 'npm') pkgdir = `/work/pkg/node_modules/${u.launch.package}`;
        u.entry = entry;
      }
      if (!u.manifestFile) {
        // Every subject and the forgery control: the server in a sandbox container of its own, the CLI in another.
        await this.splitRun(u, { work, image, serverCmd, res, unitDeadline });
        return res;
      }
      const passEnv = Object.keys(u.env ?? {}).sort();
      // A fixture runs its dogfood manifest byte for byte (its plan hash is the one a person accepted there): written
      // two levels below /work, with its relative cwd made to land on the installed package by a link.
      const manifest = u.manifestFile ? FIXTURE_MANIFEST : MANIFEST;
      if (u.manifestFile) {
        if (!pkgdir) throw new M.HarnessError('a fixture manifest needs an npm package');
        await this.dk.must(this.helper(u.tag, { mounts: [{ src: work, dst: '/work' }], cmd: ['sh', '-c', 'mkdir -p "$(dirname "$1")" "$(dirname "$3")" && ln -s "$2" "$1"', 'sh', u.link, pkgdir, FIXTURE_MANIFEST] }), 'fixture link');
      }
      const text = u.manifestFile ? readFileSync(u.manifestFile, 'utf8') : catalogManifest(serverCmd, passEnv, `loop-${u.tag}`);
      await this.put(u.tag, work, manifest, text);
      const env = runEnv({ ...(u.env ?? {}) });
      const bg = u.background && u.entry ? { argv: ['node', u.entry.script, ...u.background.args], log: `${OUTD}/backend.log`, ready: u.background.ready, wait_ms: 15_000 } : null;
      const cli = (args) => (bg ? [NODE, `${LOOP}/bg.mjs`, JSON.stringify(bg), '--', NODE, CLI_MAIN, ...args] : [NODE, CLI_MAIN, ...args]);
      const left = (cap) => Math.max(1000, Math.min(cap, unitDeadline - Date.now()));
      await this.withRunNet(u, async (network) => {
        const step = (o) => this.sandboxStep(u, { network, work, image, env, record: res.steps, ...o });
        for (const [k, argv] of (u.setup ?? []).entries()) {
          const { s } = await step({ step: `setup-${k}`, cmd: argv.map((a) => a.replaceAll('{{pkgdir}}', pkgdir ?? '')), timeoutMs: left(MS.setup) });
          if (s.exit !== 0) return;
        }
        if (u.init !== false) await step({ step: 'init', cmd: [NODE, CLI_MAIN, 'init', '--out', `${OUTD}/init-draft.yaml`, ...passEnv.flatMap((k) => ['--env', k]), '--', ...serverCmd], timeoutMs: left(MS.step) });
        const p = await step({ step: 'plan', cmd: cli(['plan', '-m', manifest]), timeoutMs: left(MS.step), keepStdout: true });
        res.planStdout = p.r.stdout.toString('utf8');
        await step({ step: 'catalog', cmd: cli(['catalog', '-m', manifest, '--out', `${OUTD}/results`]), timeoutMs: left(MS.step) });
        const accepted = u.full?.plan_hash ?? null;
        const seen = planHash(res.planStdout);
        if (accepted && seen === accepted && Date.now() + 60_000 < unitDeadline) {
          res.fullRan = true;
          await step({ step: 'full', cmd: cli(['run', '-m', manifest, '--confirm-target', u.full.confirm, '--plan-hash', accepted, '--out', `${OUTD}/full`, '--state', `${OUTD}/state`]), timeoutMs: left(MS.full) });
        }
      });
      // Everything the steps left in /work/out, read by our helper after every target process has ended.
      const c = await this.helper(u.tag, { mounts: [{ src: work, dst: '/work', ro: true }, { src: this.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${LOOP}/collect.mjs`, OUTD, String(COLLECT.file), String(COLLECT.total), String(COLLECT.entries)] }, { keepStdout: true, logStdout: false, cap: 48 * 1024 * 1024 });
      const parsed = parseCollected(c.stdout.toString('utf8'));
      res.files = parsed.files;
      res.collected = { exit: c.exit, entries: parsed.entries.length, bad: parsed.bad, done: parsed.done, truncated: c.stdout_truncated };
    } catch (e) {
      if (!(e instanceof M.HarnessError)) throw e;
      res.error = 'harness';
      appendFileSync(join(u.stepDir, 'harness-error.log'), `${String(e.message).slice(0, 600)}\n`);
    } finally {
      try { await this.dk.sweep(u.tag); } catch { /* the shard's sweep follows */ }
      watch.stop();
      if (watch.overflow()) { this.tel.write('skip', { reason: 'trace_overflow', detail: 'a syscall trace passed its limit; the unit\'s containers were stopped' }, { subject: u.tag }); res.missing.push('a complete syscall trace (overflow)'); }
      let drops = false;
      try { drops = this.recordDrops(t0, u.tag); } catch { /* recorded as missing */ }
      if (!drops && this.o.lane === 'ci') res.missing.push('the host firewall log');
      M.sweepTraces(this.cfg, t0);
      this.missing = null;
    }
    return res;
  }
}

/** The unit description for a subject (or a fixture), from its resolution. */
function unitFor(tag, resolved, fixtures, stepDir, extraEnv = {}) {
  const f = resolved.fixture ? fixtures.fixtures[resolved.fixture] : null;
  const env = { ...(f?.env ?? {}), ...extraEnv };
  for (const k of f?.random_env ?? []) env[k] = randomBytes(16).toString('hex');
  const manifestFile = f?.manifest ? join(here, '..', f.manifest) : null;
  return {
    tag, stepDir, launch: resolved.launch, fixture: resolved.fixture, env,
    init: f ? f.init !== false : true,
    installHosts: f?.install_hosts ?? [],
    background: f?.background ?? null,
    setup: f?.setup ?? null,
    full: f?.full ?? null,
    manifestFile, link: f?.link ?? null,
    lock: f?.lock ? join(here, '..', f.lock) : null,
  };
}

/** The raw/ copies of one unit's captured output: the files its steps left, the step logs and its telemetry. */
function addRaw(b, prefix, res, stepDir) {
  for (const [p, data] of res.files) b.raw(safeRawPath(`${prefix}/out`, p), data);
  for (const f of ['init', 'plan', 'catalog', 'full', 'server', 'docker', 'harness-error', ...Array.from({ length: 5 }, (_, k) => `setup-${k}`)]) {
    const p = join(stepDir, `${f}.log`);
    if (existsSync(p)) b.raw(`${prefix}/steps/${f}.log`, readFileSync(p));
  }
}

function settingsFor(ctx) {
  return {
    format: 'isokron-writecheck-loop-settings/1', cli_ref: ctx.cliRef, sandbox_ref: ctx.sandboxRef, action_ref: ctx.actionRef,
    images: ctx.shard.images, gvisor_release: ctx.shard.cfg.release, fixtures_sha256: ctx.fixtures.sha256, seed_sha256: ctx.seed.sha256,
    limits: { ...MS, shard_budget_ms: SHARD_BUDGET_MS, collect: COLLECT },
  };
}

async function runControls(ctx) {
  const { shard, fixtures } = ctx;
  const out = [];
  const ctlDir = (n) => join(shard.shardDir, 'controls', n);
  // Forgery: our hostile server, through the same steps as a subject (init, plan, catalog), with a fresh marker.
  const marker = `wcforgery${randomBytes(16).toString('hex')}`;
  const fu = { tag: 'ctl-forgery', stepDir: ctlDir('forgery'), launch: null, forgery: true, env: { FORGERY_MARKER: marker, FORGERY_TAMPER: '1' }, init: true };
  const fr = await shard.runUnit(fu, Date.now() + 10 * 60_000);
  const fs = summarize({ files: fr.files, steps: fr.steps, planStdout: fr.planStdout });
  const fOut = { format: 'isokron-writecheck-control/1', control: 'forgery', summary: publicSummary(fs), observations: observations(fs, { versions: ctx.versions, stagesRan: { install: false, init: true, plan: true, catalog: true, full: false } }) };
  const fb = new BundleFiles(CONTROL_RAW);
  addRaw(fb, 'raw/control-forgery', fr, fu.stepDir);
  const rawTexts = [...fb.files.values()].map((d) => d.toString('latin1'));
  const fObserved = forgeryVerdict({ marker, output: fOut, rawTexts, toolCount: fs.catalog.tool_count, summary: fs });
  out.push({ kind: 'forgery', expected: 'contained', observed: fObserved, output: 'controls/forgery.json', marker, file: fOut, raw: fb });

  // Known answer: tiny-tracker, installed through the sandbox like a subject, catalog with and without the defect.
  const tt = Object.entries(fixtures.fixtures).find(([, f]) => f.known_answer);
  if (!tt) throw new Error('loop/fixtures.json names no known_answer fixture');
  const [ttName, ttF] = tt;
  const ka = ttF.known_answer;
  for (const [kind, label, defect] of [['known_bad', 'known-bad', ka.defect], ['known_good', 'known-good', null]]) {
    const u = unitFor(`ctl-${label}`, { fixture: ttName, launch: { ...ttF.launch } }, fixtures, ctlDir(label), defect ? { [ka.env]: defect } : {});
    u.full = null; // catalog and plan only
    u.init = false;
    const r = await shard.runUnit(u, Date.now() + 10 * 60_000);
    const s = summarize({ files: r.files, steps: r.steps, planStdout: r.planStdout });
    const observed = kind === 'known_bad' ? knownBadVerdict(s, ka.requirement) : knownGoodVerdict(s, ka.requirement);
    const file = { format: 'isokron-writecheck-control/1', control: label, fixture: ttName, package: `${ttF.launch.package}@${ttF.launch.version}`, defect, requirement: ka.requirement, observed, summary: publicSummary(s) };
    const rb = new BundleFiles(CONTROL_RAW);
    addRaw(rb, `raw/control-${label}`, r, u.stepDir);
    out.push({ kind, expected: kind === 'known_bad' ? 'detected' : 'held', observed, output: `controls/${label}.json`, file, raw: rb });
  }
  return out;
}

async function runItem(ctx, item, deadline) {
  const { shard, fixtures, seed } = ctx;
  const startedAt = iso();
  const b = new BundleFiles();
  const skips = [];
  const resolved = resolveSubject(item.subject, { seed, fixtures });
  const driver = { format: 'isokron-writecheck-loop-driver/1', index: item.index, source: resolved.source ?? null, package: resolved.package ?? null, install: null, steps: [], error: null, evidence_missing: [], collected: null };
  let summary = null;
  let res = null;
  const stages = { install: false, init: false, plan: false, catalog: false, full: false };
  if (resolved.skip) {
    for (const st of ['install', 'init', 'plan', 'catalog']) skips.push({ stage: st, reason: resolved.skip.reason, evidence: 'logs/driver.json' });
    driver.skip_detail = resolved.skip.detail;
  } else if (Date.now() >= deadline) {
    for (const st of ['install', 'init', 'plan', 'catalog']) skips.push({ stage: st, reason: 'timeout_start', retryable: true, evidence: 'logs/driver.json' });
    driver.skip_detail = 'not started: the shard used its time budget first';
  } else {
    const u = unitFor(`i${item.index}`, resolved, fixtures, join(shard.shardDir, 'items', String(item.index)));
    // A unit's telemetry is its own file, kept in raw/ (it names what the target looked up and reached).
    const telFile = join(u.stepDir, 'telemetry.jsonl');
    mkdirSync(u.stepDir, { recursive: true });
    const shardTel = shard.tel;
    shard.tel = new shard.M.Telemetry(telFile, { run: shard.runId });
    try { res = await shard.runUnit(u, Math.min(deadline + 15 * 60_000, Date.now() + 20 * 60_000)); } finally { shard.tel = shardTel; }
    driver.install = res.install ? { ok: res.install.ok, kind: res.install.kind, image: res.install.image, resolved_version: res.install.resolved_version, timed_out: !!res.install.timed_out, steps: res.install.steps, egress_hosts_allowed: res.install.egress.filter((e) => e.allowed).length, egress_refused: res.install.egress.filter((e) => !e.allowed).length } : null;
    driver.error = res.error;
    driver.evidence_missing = [...new Set(res.missing)];
    driver.collected = res.collected;
    stages.install = !!res.install?.ok;
    for (const s of res.steps) if (s.step in stages) stages[s.step] = true;
    if (res.error === 'harness') {
      for (const st of ['install', 'init', 'plan', 'catalog'].filter((x) => !stages[x])) skips.push({ stage: st, reason: 'upstream_unavailable', retryable: true, evidence: 'logs/driver.json' });
    } else if (res.install && !res.install.ok) {
      const reason = res.install.timed_out ? 'timeout_start' : 'install_failed_registry';
      for (const st of ['init', 'plan', 'catalog']) skips.push({ stage: st, reason, evidence: 'logs/driver.json' });
    }
    // The stages that did not run are recorded too: init where the fixture's server is not started over stdio,
    // and the full write test wherever it did not start (never for a third-party server; for a fixture, only
    // under the plan hash a person accepted).
    if (res.error !== 'harness' && res.install?.ok) {
      if (!stages.init && u.init === false) { skips.push({ stage: 'init', reason: 'unsupported_transport', evidence: 'logs/driver.json' }); driver.init_detail = 'the fixture server is started over streamable HTTP by its manifest; init drafts from a stdio command'; }
      if (!res.fullRan) {
        skips.push({ stage: 'full', reason: 'policy_excluded', evidence: 'logs/driver.json' });
        driver.full_detail = !u.full ? 'a third-party server is never given a manifest that writes' : 'the plan hash is not the accepted one (or the plan did not run), so the full write test did not start';
      }
    }
    summary = summarize({ files: res.files, steps: res.steps, planStdout: res.planStdout, fullRan: res.fullRan, acceptedPlanHash: u.full?.plan_hash ?? null });
    const evidenceComplete = ctx.lane !== 'ci' || driver.evidence_missing.length === 0;
    if (!evidenceComplete) skips.push({ stage: 'catalog', reason: 'trace_unavailable', evidence: 'logs/driver.json' });
    b.put('results/writecheck.json', json({ subject: item.subject, source: resolved.source, package: resolved.package, resolved_version: res.install?.resolved_version ?? null, ...publicSummary(summary) }));
    b.put('observations/writecheck.ndjson', ndjson(observations(summary, { versions: ctx.versions, stagesRan: stages, evidenceComplete })));
    addRaw(b, 'raw', res, u.stepDir);
    if (existsSync(telFile)) b.raw('raw/sandbox-telemetry.jsonl', readFileSync(telFile));
    driver.steps = publicSummary(summary).steps;
  }
  if (!summary) {
    b.put('observations/writecheck.ndjson', ndjson([
      { field: 'our_tool_versions', value: ctx.versions },
      { field: 'observation_coverage', value: { ...stages, sandbox_evidence_complete: true } },
    ]));
  }
  for (const c of ctx.controls) {
    b.put(c.output, json(c.file));
    for (const [p, d] of c.raw.files) b.files.set(p, d);
  }
  driver.raw_index = b.rawIndex;
  b.put('logs/driver.json', json(driver));
  const dir = join(shard.out, String(item.index));
  rmSync(dir, { recursive: true, force: true });
  b.write(join(dir, 'bundle'));
  const meta = buildMeta({ subject: item.subject, tools: ctx.tools, settingsDigest: ctx.settingsDigest, startedAt, finishedAt: iso(), skips, controls: ctx.controls });
  writeFileSync(join(dir, 'meta.json'), json(meta));
  return { skipped: skips.length > 0 && !res, code: resolved.skip?.reason ?? (res?.error ? 'harness_error' : res?.install && !res.install.ok ? 'install_failed' : 'ran') };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  checkId('shard_id', env.SHARD_ID);
  checkId('attempt_id', env.ATTEMPT_ID);
  const items = parseItems(env.ITEMS);
  for (const [k, v] of [['CLI_REF', env.CLI_REF], ['SANDBOX_REF', env.SANDBOX_REF]]) if (!/^[0-9a-f]{40}$/.test(String(v ?? ''))) throw new InputError(`${k} must be a full commit SHA`);
  const M = await loadMsc(resolve(o.msc));
  const seed = loadSeed(o.seed);
  const fixtures = loadFixtures(o.fixtures);
  const shard = new Shard({ o, M, env });
  const actionRef = /^[0-9a-f]{40}$/.test(String(env.GITHUB_SHA ?? '')) ? env.GITHUB_SHA : 'local';
  const ctx = { shard, seed, fixtures, lane: o.lane, cliRef: env.CLI_REF, sandboxRef: env.SANDBOX_REF, actionRef };
  ctx.versions = { mcp_writecheck: env.CLI_REF, mcp_writecheck_action: actionRef, mcp_surface_corpus: env.SANDBOX_REF, gvisor: shard.cfg.release };
  ctx.tools = [
    { name: 'mcp-writecheck', version: env.CLI_REF },
    { name: 'mcp-writecheck-action', version: actionRef },
    { name: 'mcp-surface-corpus-sandbox', version: env.SANDBOX_REF },
    { name: 'gvisor', version: shard.cfg.release },
  ];
  say(`writecheck shard: ${items.length} item(s)`);
  shard.tel.write('run_start', { kind: 'corpus', lane: o.lane, node: process.version, platform: `linux/${arch()}`, runtime: M.RUNTIME, gvisor_release: shard.cfg.release });
  let ok = false;
  try {
    await shard.prepare();
    await shard.preflight();
    await shard.prepareTools();
    ctx.settingsDigest = sha256(JSON.stringify(settingsFor(ctx)));
    const t0 = Date.now();
    ctx.controls = await runControls(ctx);
    for (const c of ctx.controls) say(`control ${c.kind}: ${c.observed} (expected ${c.expected})`);
    const failed = ctx.controls.filter((c) => c.observed !== c.expected);
    if (failed.length) {
      say(`::error title=writecheck::${failed.length} control(s) failed; no bundle is written and nothing is uploaded`);
      return 1;
    }
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'controls_ok=true\n');
    const deadline = t0 + SHARD_BUDGET_MS;
    for (const item of items) {
      const r = await runItem(ctx, item, deadline);
      say(`item ${item.index}: ${r.code}`);
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `has_${item.index}=true\nfence_${item.index}=${item.fence}\nrun_key_${item.index}=${item.run_key}\n`);
    }
    ok = true;
    return 0;
  } catch (e) {
    appendFileSync(join(shard.shardDir, 'driver-errors.log'), `${String(e && e.stack).slice(0, 4000)}\n`);
    say(`::error title=writecheck::harness error: ${e instanceof M.HarnessError ? String(e.message).slice(0, 300).replace(/[^\x20-\x7e]/g, '?') : 'see _shard/driver-errors.log'}`);
    return 1;
  } finally {
    try { await shard.dk.sweep(); } catch { /* the workflow stops Docker afterwards */ }
    M.sweepTraces(shard.cfg, 0);
    rmSync(shard.cidDir, { recursive: true, force: true });
    try { shard.tel.end(ok); } catch { /* the telemetry file is best effort at the end */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((rc) => { process.exitCode = rc; }, (e) => {
    say(`::error title=writecheck::${e instanceof InputError ? e.message : 'the driver failed before the shard started'}`);
    if (!(e instanceof InputError)) process.stderr.write(`${e && e.stack}\n`);
    process.exitCode = 1;
  });
}
