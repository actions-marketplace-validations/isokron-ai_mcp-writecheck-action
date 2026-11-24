/**
 * REGRESSIONS.md and the suite stay in step: every test a row names exists in that file under exactly that
 * name, and every test named after a row (R-XXX-NN: ...) is listed in it. A name built with a template literal
 * (`${name}: ...` in a loop) matches when the row's name fits it with each `${...}` standing for any text.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ledger = readFileSync(join(root, 'REGRESSIONS.md'), 'utf8');

function rows(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\| (R-[A-Z]+-\d+) \|(.*)\| ([^|]*) \|$/.exec(line);
    if (!m) continue;
    const tests = [...m[2].matchAll(/`([^`]+\.test\.mjs)` › `([^`]+)`/g)].map((t) => ({ file: t[1], name: t[2] }));
    out.push({ id: m[1], tests, fix: m[3] });
  }
  return out;
}

/** First arguments of test('...') calls: exact names, and template names as patterns. */
function testNames(src) {
  const exact = new Set();
  const patterns = [];
  for (const m of src.matchAll(/\btest\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) exact.add(m[2].replace(/\\(.)/g, '$1'));
  for (const m of src.matchAll(/\btest\(\s*`((?:\\.|[^\\`])*)`/g)) {
    const parts = m[1].split(/\$\{[^}]*\}/).map((p) => p.replace(/\\(.)/g, '$1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    patterns.push(new RegExp(`^${parts.join('.+')}$`));
  }
  return { has: (name) => exact.has(name) || patterns.some((p) => p.test(name)), exact };
}

test('every test the ledger names exists, under exactly that name, in that file', () => {
  const list = rows(ledger);
  assert.ok(list.length > 0);
  const seen = new Set();
  for (const r of list) {
    assert.ok(!seen.has(r.id), `${r.id} is listed twice`);
    seen.add(r.id);
    assert.ok(r.tests.length > 0, `${r.id} names no test`);
    assert.match(r.fix, /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/, `${r.id} names no fix commit`);
    for (const t of r.tests) {
      const names = testNames(readFileSync(join(root, t.file), 'utf8'));
      assert.ok(names.has(t.name), `${r.id}: ${t.file} has no test named "${t.name}"`);
    }
  }
});

test('every test named after a ledger row is listed in that row', () => {
  const list = rows(ledger);
  const listed = new Set(list.flatMap((r) => r.tests.map((t) => `${t.file}\0${t.name}`)));
  for (const f of readdirSync(join(root, 'test')).filter((n) => n.endsWith('.test.mjs'))) {
    for (const name of testNames(readFileSync(join(root, 'test', f), 'utf8')).exact) {
      if (!/^R-[A-Z]+-\d+:/.test(name)) continue;
      assert.ok(listed.has(`test/${f}\0${name}`), `test/${f}: "${name}" is not listed in REGRESSIONS.md`);
    }
  }
});
