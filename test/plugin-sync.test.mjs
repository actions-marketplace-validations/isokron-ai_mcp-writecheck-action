// The directory plugin in plugin/ ships copies of skills/ (the directory accepts a plugin only from a folder that
// holds nothing else); this keeps the copies identical and the manifests consistent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));

test('plugin/skills are byte-identical copies of skills/', () => {
  const names = readdirSync(new URL('skills/', root)).sort();
  assert.deepEqual(readdirSync(new URL('plugin/skills/', root)).sort(), names);
  for (const n of names) assert.ok(read(`skills/${n}/SKILL.md`).equals(read(`plugin/skills/${n}/SKILL.md`)), `${n} differs`);
});

test('the marketplace lists the plugin folder, and the plugin manifest names its icon', () => {
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  const plugin = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
  assert.equal(market.plugins[0].source, './plugin');
  assert.equal(market.plugins[0].name, plugin.name);
  assert.ok(read(`plugin/${plugin.icon.replace(/^\.\//, '')}`).length > 0);
});
