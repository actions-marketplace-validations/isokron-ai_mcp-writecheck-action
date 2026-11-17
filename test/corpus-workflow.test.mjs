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
const wf = readFileSync(join(root, '.github', 'workflows', 'corpus.yml'), 'utf8');
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
  assert.match(check, /grep -Eqx 't\[0-9\]\{2,3\}\(,t\[0-9\]\{2,3\}\)\{0,9\}'/);
  assert.ok(body.indexOf('name: Check the batch') < body.indexOf('secrets.CORPUS_TARGETS_KEY'));
  assert.doesNotMatch(body, /run:[^\n]*\$\{\{ inputs\.only/);
  const shard = readFileSync(new URL('../corpus/run-ci-shard.sh', import.meta.url), 'utf8');
  assert.match(shard, /\$\{CORPUS_ONLY:\+--only "\$CORPUS_ONLY"\}/);
});
