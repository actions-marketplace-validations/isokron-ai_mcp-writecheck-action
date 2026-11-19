// The README says what action.yml does: the same inputs, defaults, outputs and modes; the warning that mode full
// makes real writes comes first; what the action does not pass to the CLI is not in the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(root + f, 'utf8');
const readme = read('README.md');
const action = read('action.yml');

/** The `inputs:` and `outputs:` blocks of action.yml, as name -> { default, text }. Plain line reading: no YAML dependency. */
function block(name, next) {
  const s = action.indexOf(`\n${name}:\n`);
  const e = action.indexOf(`\n${next}:\n`, s + 1);
  const out = {};
  let cur = null;
  for (const line of action.slice(s, e).split('\n')) {
    const m = line.match(/^  ([a-z-]+):\s*$/);
    if (m) { cur = out[m[1]] = { default: undefined, text: '' }; continue; }
    if (!cur) continue;
    const d = line.match(/^    default:\s*(.*)$/);
    if (d) cur.default = d[1].replace(/^'(.*)'$/, '$1');
    cur.text += line + '\n';
  }
  return out;
}
const inputs = block('inputs', 'outputs');
const outputs = block('outputs', 'runs');

function readmeTable() {
  const s = readme.indexOf('| Input | Default | Meaning |');
  const rows = {};
  for (const line of readme.slice(s).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows[cells[0].replace(/`/g, '')] = cells[1];
  }
  return rows;
}

test('README inputs table: the inputs of action.yml, no more and no fewer', () => {
  assert.deepEqual(Object.keys(readmeTable()).sort(), Object.keys(inputs).sort());
});

test('README inputs table: each default is the default in action.yml', () => {
  const rows = readmeTable();
  for (const [name, i] of Object.entries(inputs)) {
    const shown = rows[name];
    if (name === 'manifest') { assert.match(shown, /required/); continue; }
    const want = i.default ?? '';
    if (want === '') { assert.equal(shown.trim(), '', `${name}: no default in action.yml, none in the README`); continue; }
    assert.equal(shown.replace(/`/g, ''), want, `${name} default`);
  }
});

test('README: the outputs it names are the outputs of action.yml', () => {
  const line = readme.split('\n').find((l) => l.startsWith('Outputs:'));
  const named = [...line.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
  assert.deepEqual(named.sort(), Object.keys(outputs).sort());
});

test('README: the three modes and the fail-on values are the ones action.yml documents', () => {
  for (const m of ['plan', 'catalog', 'full']) {
    assert.match(inputs.mode.text, new RegExp(`\\b${m}:`), `action.yml describes ${m}`);
    assert.match(readme, new RegExp(`### \`${m}\``), `README has a section for ${m}`);
  }
  assert.equal(inputs.mode.default, 'plan');
  assert.equal(inputs['fail-on'].default, 'must');
  for (const v of ['none', 'must', 'any']) assert.match(readme, new RegExp(`\\| \`${v}\` \\|`));
});

test('README: the warning that mode full makes real writes comes before "What it does"', () => {
  const w = readme.indexOf('**Mode `full` makes thousands of real writes.**');
  assert.ok(w > 0 && w < readme.indexOf('## What it does'));
  const para = readme.slice(w, readme.indexOf('## What it does'));
  for (const s of ['disposable backend', '`confirm-target`', '`plan-hash`', 'selector.send_empty_forms', 'writes nothing']) assert.ok(para.includes(s), s);
  assert.match(inputs.mode.text, /thousands of real writes/);
});

test('README: what the action says it does not pass to the CLI, the code does not pass', () => {
  assert.match(readme, /does not pass the CLI's `--baseline`.*`--sign` or `--sign-key`/);
  for (const f of ['src/main.mjs', 'src/install.mjs', 'contract.mjs']) {
    assert.doesNotMatch(read(f), /['"`]--(baseline|sign|sign-key)\b/, `${f} passes a flag the README says is not passed`);
  }
});

test('docs: no "certified", no "seal", no Strapi in the public Markdown', () => {
  const files = ['README.md', 'TESTING.md', 'NOTES.md', 'RUNNER-TEST.md', 'SECURITY.md', 'dogfood/README.md', 'plugin/README.md', 'corpus/README.md'];
  for (const d of ['skills', 'plugin/skills']) for (const s of readdirSync(root + d)) files.push(`${d}/${s}/SKILL.md`);
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /\bcertif(?:ied|ication|y)\b/i, f);
    assert.doesNotMatch(t, /\bseal\b/i, f);
    assert.doesNotMatch(t, /strapi/i, f);
  }
});

test('README: it no longer calls the first runner run a plan that has not happened', () => {
  assert.doesNotMatch(readme, /which has not happened yet/);
  assert.doesNotMatch(read('TESTING.md'), /The action has not run on a GitHub runner/);
  assert.match(readme, /Runs on GitHub-hosted runners/);
});
