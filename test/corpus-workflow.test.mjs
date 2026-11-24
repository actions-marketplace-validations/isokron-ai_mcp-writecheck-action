/**
 * The corpus workflow and its shell steps: the rules review 1 asked for, checked on the files.
 * encrypt-results.sh is run for real when `age` and `age-keygen` are on PATH (skipped otherwise).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = readFileSync(join(root, '.github', 'workflows', 'corpus-batch.yml'), 'utf8');
const body = wf.replace(/^\s*#.*$/gm, ''); // the YAML without comments
const step = (name) => {
  const i = body.indexOf(`name: ${name}`);
  assert.ok(i > 0, name);
  const from = body.lastIndexOf('\n      - ', i);
  const to = body.indexOf('\n      - ', i);
  return body.slice(from, to < 0 ? undefined : to);
};

test('triggers: manual dispatch from main only; no schedule, no pull request trigger', () => {
  assert.match(body, /^on:\n(?:\s*\n)*  workflow_dispatch:\n    inputs:\n      only:/m);
  assert.doesNotMatch(body, /schedule:|cron:/);
  assert.doesNotMatch(body, /pull_request/);
  assert.match(body, /if: github.repository == 'isokron-ai\/mcp-writecheck-action' && github.ref == 'refs\/heads\/main'/);
  assert.match(body, /^permissions:\n  contents: read\n/m);
});

test('M2: the job runs in the corpus environment (its secrets, deployment branch main)', () => {
  assert.match(body, /\n    environment: corpus\n/);
});

test('MWS_CLI_TOKEN: never read; the CLI is checked out without a token, only once MWS_CLI_PUBLIC is true', () => {
  assert.doesNotMatch(body, /MWS_CLI_TOKEN/);
  assert.deepEqual(body.match(/secrets\.\w+/g), ['secrets.CORPUS_TARGETS_KEY']);
  const gate = step('Require MWS_CLI_PUBLIC');
  assert.match(gate, /if: vars\.MWS_CLI_PUBLIC != 'true'/);
  assert.match(gate, /exit 1/);
  const pub = step('Check out mcp-writecheck (public)');
  assert.match(pub, /repository: isokron-ai\/mcp-write-safety/);
  assert.doesNotMatch(pub, /token:|if:/);
  // The gate first, then the checkout, both before any third-party code or the decrypt step.
  assert.ok(body.indexOf('Require MWS_CLI_PUBLIC') < body.indexOf('Check out mcp-writecheck (public)'));
  assert.ok(body.indexOf('Check out mcp-writecheck (public)') < body.indexOf('corpus/decrypt-targets.sh'));
  assert.ok(body.indexOf('corpus/decrypt-targets.sh') < body.indexOf('corpus/run-ci-shard.sh'));
  assert.match(step('Decrypt the target list'), /CORPUS_TARGETS_KEY/);
});

test('C1: the network guard runs before the shard; every action pinned by SHA; L3: no package cache', () => {
  assert.ok(body.indexOf('sudo corpus/net-guard.sh') > 0 && body.indexOf('sudo corpus/net-guard.sh') < body.indexOf('corpus/run-ci-shard.sh'));
  for (const u of body.match(/uses: \S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
  assert.match(body, /package-manager-cache: false/);
  assert.doesNotMatch(body, /actions\/cache/);
});

test('M3: the upload runs only when encryption succeeded; L1: the public rc is a number', () => {
  assert.match(step('Encrypt the results'), /id: encrypt/);
  assert.match(step('Upload the encrypted results'), /if: always\(\) && steps\.encrypt\.outcome == 'success'/);
  assert.match(step('Job status'), /\[\[ "\$\{RC:-\}" =~ \^\[0-9\]\{1,3\}\$ \]\] \|\| RC=125/);
  const sh = readFileSync(join(root, 'corpus', 'run-ci-shard.sh'), 'utf8');
  assert.match(sh, /\[\[ "\$rc" =~ \^\[0-9\]\{1,3\}\$ \]\] \|\| rc=125/);
});

test('H3: the driver\'s stderr goes to the bundle; the last sweep removes containers, networks, volumes', () => {
  const sh = readFileSync(join(root, 'corpus', 'run-ci-shard.sh'), 'utf8');
  assert.match(sh, /2>>"\$c\/out\/_shard\/driver-stderr\.log" \| tee "\$c\/public\.txt"/);
  assert.match(sh, /--consume-targets/);
  for (const k of ['docker ps -aq --filter label=isokron.corpus.run', 'docker network ls -q --filter label=isokron.corpus.run', 'docker volume ls -q --filter label=isokron.corpus.run']) assert.ok(sh.includes(k), k);
});

test('the last sweep: an environ that cannot be read prints nothing; a CORPUS_SANDBOX=1 process is still killed', () => {
  const sh = readFileSync(join(root, 'corpus', 'run-ci-shard.sh'), 'utf8');
  const line = sh.split('\n').find((l) => l.includes('"$p/environ"'));
  assert.ok(line, 'the sweep line');
  assert.match(line, /\{ tr '\\0' '\\n' < "\$p\/environ"; \} 2>\/dev\/null \| grep -qx 'CORPUS_SANDBOX=1'/);
  // Run the script's own line against stand-in /proc entries, with kill stubbed to report its argument.
  const d = mkdtempSync(join(tmpdir(), 'sweep-'));
  const mk = (n, env, mode) => {
    mkdirSync(join(d, n));
    if (env !== null) writeFileSync(join(d, n, 'environ'), env, { mode: mode ?? 0o600 });
  };
  mk('101', null); // no environ at all: the redirection fails
  mk('102', 'PATH=/bin\0CORPUS_SANDBOX=1\0', 0o600); // a sandbox process
  mk('103', 'PATH=/bin\0CORPUS_SANDBOX=10\0', 0o600); // not one (exact line match)
  mk('104', 'CORPUS_SANDBOX=1\0', 0o000); // unreadable unless root
  const script = `kill() { echo "killed \${2#/proc/}"; }\nfor p in ${d}/[0-9]*; do\n${line.replaceAll('"${p#/proc/}"', '"$(basename "$p")"')}\ndone\n`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '', 'nothing on stderr (the public log)');
  const root0 = process.getuid?.() === 0;
  assert.deepEqual(r.stdout.trim().split('\n').filter(Boolean).sort(), root0 ? ['killed 102', 'killed 104'] : ['killed 102']);
});

test('net-guard: metadata and wire-server addresses dropped, container-to-host traffic dropped', () => {
  const g = readFileSync(join(root, 'corpus', 'net-guard.sh'), 'utf8');
  assert.match(g, /169\.254\.0\.0\/16 168\.63\.129\.16\/32/);
  assert.match(g, /iptables -I DOCKER-USER -d "\$dst" -j DROP/);
  assert.match(g, /for ifc in docker0 'br-\+'/);
  assert.match(g, /iptables -I INPUT -i "\$ifc" -j DROP/);
});

const haveAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen']).status === 0;
function encrypt(recipients) {
  const d = mkdtempSync(join(tmpdir(), 'corpus-enc-'));
  mkdirSync(join(d, 'corpus', 'out', 't01'), { recursive: true });
  writeFileSync(join(d, 'corpus', 'out', 't01', 'meta.json'), '{}');
  writeFileSync(join(d, 'corpus', 'public.txt'), 'run finished, exit 0\n');
  mkdirSync(join(d, 'repo', 'corpus'), { recursive: true });
  writeFileSync(join(d, 'repo', 'corpus', 'recipients.txt'), recipients);
  writeFileSync(join(d, 'repo', 'corpus', 'encrypt-results.sh'), readFileSync(join(root, 'corpus', 'encrypt-results.sh')));
  const r = spawnSync('bash', ['corpus/encrypt-results.sh'], { cwd: join(d, 'repo'), encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: d, SHARD: '2' } });
  return { d, r };
}
const key = () => spawnSync('age-keygen', [], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.startsWith('# public key: ')).slice(14);

test('M3: one recipient: exactly one age file is left to upload, and no clear text', { skip: haveAge ? false : 'age not installed' }, () => {
  const { d, r } = encrypt(`# x\n${key()}\n`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(join(d, 'corpus-upload')), ['corpus-shard-2.tgz.age']);
  assert.deepEqual(readdirSync(join(d, 'corpus')), ['public.txt']);
});

test('M3: a second recipient (a tampered recipients file) fails the step and leaves nothing to upload', { skip: haveAge ? false : 'age not installed' }, () => {
  const { d, r } = encrypt(`${key()}\n${key()}\n`);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /not age ciphertext/);
  assert.throws(() => readdirSync(join(d, 'corpus-upload')));
});

test('batches: the only input is checked against the ID shape before any secret, and reaches the driver', () => {
  const check = step('Check the batch');
  assert.match(check, /ONLY_IN: \$\{\{ inputs\.only \}\}/);
  assert.match(check, /PLAN_SHARDS: \$\{\{ needs\.plan\.outputs\.shards \}\}/);
  assert.match(check, /SHARD: \$\{\{ matrix\.shard \}\}/);
  assert.match(check, /JOB_INDEX: \$\{\{ strategy\.job-index \}\}/);
  assert.match(check, /JOB_TOTAL: \$\{\{ strategy\.job-total \}\}/);
  assert.match(check, /run: corpus\/check-batch\.sh env "\$GITHUB_ENV"/);
  assert.ok(body.indexOf('name: Check the batch') < body.indexOf('secrets.CORPUS_TARGETS_KEY'));
  assert.doesNotMatch(body, /run:[^\n]*\$\{\{ inputs\.only/);
  assert.doesNotMatch(body, /\n  CORPUS_SHARDS:/, 'the shard count comes from the batch, not a fixed env');
  const shard = readFileSync(new URL('../corpus/run-ci-shard.sh', import.meta.url), 'utf8');
  assert.match(shard, /\$\{CORPUS_ONLY:\+--only "\$CORPUS_ONLY"\}/);
  assert.match(shard, /--shards "\$\{CORPUS_SHARDS:\?\}"/);
});

test('batches: the plan job sizes the matrix from the only input alone: no environment, no secret, before the shards', () => {
  const plan = body.slice(body.indexOf('\n  plan:\n'), body.indexOf('\n  corpus:\n'));
  assert.ok(plan.length > 0 && body.indexOf('\n  plan:\n') < body.indexOf('\n  corpus:\n'));
  assert.match(plan, /\n    if: github.repository == 'isokron-ai\/mcp-writecheck-action' && github.ref == 'refs\/heads\/main'\n/);
  assert.doesNotMatch(plan, /environment:|secrets\.|vars\.|github\.token|GH_TOKEN|needs\./);
  assert.doesNotMatch(plan, /repository:/, 'checks out this repository only');
  assert.match(plan, /persist-credentials: false/);
  assert.match(plan, /ONLY_IN: \$\{\{ inputs\.only \}\}/);
  assert.match(plan, /run: corpus\/check-batch\.sh output "\$GITHUB_OUTPUT"/);
  // Only the input reaches it: no other inputs, no event payload.
  assert.deepEqual(plan.match(/\$\{\{[^}]*\}\}/g).filter((e) => !/steps\.batch\.outputs\./.test(e)), ['${{ inputs.only }}']);
  const job = body.slice(body.indexOf('\n  corpus:\n'));
  assert.match(job, /\n    needs: plan\n/);
  assert.match(job, /\n    environment: corpus\n/);
  assert.match(job, /\n      max-parallel: 16\n/);
  assert.match(job, /\n        shard: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}\n/);
});

test('batches: one run at a time (the concurrency group has no suffix and does not cancel)', () => {
  assert.match(body, /^concurrency:\n  group: corpus\n  cancel-in-progress: false\n/m);
  assert.equal(body.match(/concurrency:/g).length, 1);
});

const checkBatch = join(root, 'corpus', 'check-batch.sh');
function batch(mode, value, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'only-'));
  const f = join(dir, 'out');
  writeFileSync(f, '');
  // JOB_TOTAL and JOB_INDEX follow PLAN_SHARDS and SHARD (a consistent matrix) unless given.
  const job = {};
  if (extra.PLAN_SHARDS !== undefined && !('JOB_TOTAL' in extra)) job.JOB_TOTAL = extra.PLAN_SHARDS;
  if (/^[0-9]+$/.test(extra.SHARD ?? '') && !('JOB_INDEX' in extra)) job.JOB_INDEX = String(Number(extra.SHARD) - 1);
  const env = { PATH: process.env.PATH, ONLY_IN: value, ...job, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync('bash', [checkBatch, mode, f], { env, encoding: 'utf8' });
  return { code: r.status, out: readFileSync(f, 'utf8'), stdout: r.stdout };
}
const ids = (n) => Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(2, '0')}`).join(',');
const range = (k) => `[${Array.from({ length: k }, (_, i) => i + 1).join(',')}]`;

test('batches: the plan: min(16, n) shards for n IDs, 16 for an empty input, up to 40 IDs', () => {
  for (const [value, k] of [['t13', 1], ['t13,t09,t08', 3], [ids(16), 16], [ids(17), 16], [ids(40), 16], ['', 16]]) {
    assert.deepEqual(batch('output', value), { code: 0, out: `shards=${k}\nmatrix=${range(k)}\n`, stdout: '' }, value);
  }
  // 40 IDs over 16 shards, dealt as the driver does (i % shards): at most 3 per shard.
  const per = Array(16).fill(0);
  for (let i = 0; i < 40; i++) per[i % 16]++;
  assert.equal(Math.max(...per), 3);
});

test('batches: the check runs: good IDs pass, and a newline, a separator, a repeat or too many IDs never reach GITHUB_ENV', () => {
  assert.deepEqual(batch('env', 't13,t09,t08', { PLAN_SHARDS: '3', SHARD: '2' }), { code: 0, out: 'CORPUS_ONLY=t13,t09,t08\nCORPUS_SHARDS=3\n', stdout: '' });
  assert.deepEqual(batch('env', '', { PLAN_SHARDS: '16', SHARD: '16' }), { code: 0, out: 'CORPUS_ONLY=\nCORPUS_SHARDS=16\n', stdout: '' });
  assert.deepEqual(batch('env', ids(40), { PLAN_SHARDS: '16', SHARD: '1' }), { code: 0, out: `CORPUS_ONLY=${ids(40)}\nCORPUS_SHARDS=16\n`, stdout: '' });
  const bad = ['t13\nNODE_OPTIONS=--require=/x', 't13\r\nX=1', 't13;id', 't1', ids(41), ' t13', 't13,', ',t13', 't13,,t09', 't13,t09,t13', 't09,t009', 't013,t13', 't100,t100', 't13\n', '$(id)'];
  for (const v of bad) {
    for (const mode of ['env', 'output']) {
      const r = batch(mode, v, { PLAN_SHARDS: '16', SHARD: '1' });
      assert.equal(r.code, 1, `${mode} ${JSON.stringify(v)}`);
      assert.equal(r.out, '', `${mode} ${JSON.stringify(v)}`);
      assert.match(r.stdout, /^::error::[^\n]*\n$/, 'one fixed error line');
      assert.doesNotMatch(r.stdout, /NODE_OPTIONS|X=1|\$\(id\)|t41/, 'the error does not echo the input');
    }
  }
});

test('batches: a shard job refuses a plan that does not match the input, or a shard outside it', () => {
  for (const extra of [{ PLAN_SHARDS: '16', SHARD: '1' }, { PLAN_SHARDS: '', SHARD: '1' }, { SHARD: '1' }, { PLAN_SHARDS: '3', SHARD: '4' }, { PLAN_SHARDS: '3', SHARD: '0' }, { PLAN_SHARDS: '3', SHARD: '' }, { PLAN_SHARDS: '3', SHARD: '1\nX=1' }, { PLAN_SHARDS: '3' }]) {
    const r = batch('env', 't13,t09,t08', extra);
    assert.equal(r.code, 1, JSON.stringify(extra));
    assert.equal(r.out, '', JSON.stringify(extra));
  }
  assert.equal(batch('bogus', 't13').code, 2);
});

test('batches: the number decides a repeat (t09 and t009 are one ID); distinct 2- and 3-digit IDs pass', () => {
  assert.equal(batch('output', 't09,t009').code, 1);
  assert.equal(batch('output', 't000,t00').code, 1);
  assert.deepEqual(batch('output', 't09,t090,t900,t99'), { code: 0, out: `shards=4\nmatrix=${range(4)}\n`, stdout: '' });
  assert.deepEqual(batch('env', 't09,t100', { PLAN_SHARDS: '2', SHARD: '2' }), { code: 0, out: 'CORPUS_ONLY=t09,t100\nCORPUS_SHARDS=2\n', stdout: '' });
});

test('batches: a shard job refuses a matrix that is not exactly the planned one (strategy.job-total, job-index)', () => {
  const ok = { PLAN_SHARDS: '3', SHARD: '2', JOB_TOTAL: '3', JOB_INDEX: '1' };
  assert.equal(batch('env', 't13,t09,t08', ok).code, 0);
  for (const over of [{ JOB_TOTAL: '4' }, { JOB_TOTAL: '16' }, { JOB_TOTAL: '2' }, { JOB_INDEX: '0' }, { JOB_INDEX: '2' }, { JOB_TOTAL: undefined }, { JOB_INDEX: undefined }, { JOB_TOTAL: '' }, { JOB_INDEX: '' }, { JOB_INDEX: '1\nX=1' }, { JOB_TOTAL: '-3' }, { JOB_INDEX: '1 ' }]) {
    const r = batch('env', 't13,t09,t08', { ...ok, ...over });
    assert.equal(r.code, 1, JSON.stringify(over));
    assert.equal(r.out, '', JSON.stringify(over));
  }
});

test('D8: the job may run 360 minutes, the hosted maximum, which the driver\'s shard budget stays under', async () => {
  const m = /^ {4}timeout-minutes: (\d+)$/m.exec(wf.slice(wf.indexOf('\n  corpus:\n')));
  assert.equal(Number(m?.[1]), 360);
  const { SHARD_BUDGET_S } = await import('../corpus/run-shard.mjs');
  assert.ok(SHARD_BUDGET_S <= (360 - 30) * 60, 'at least 30 minutes left for checkout, build, encryption and upload');
  // The spec document comes from the same CLI commit, beside the package.
  assert.match(wf, /sparse-checkout: \|\n\s+\/packages\/writecheck\/\n\s+\/spec\/mws\.md\n\s+sparse-checkout-cone-mode: false/);
});
