/**
 * src/install.mjs refuses what it must not fetch, before it runs git.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ActionError, FULL_SHA, obtainCli } from '../src/install.mjs';

test('cli-ref must be a full 40-character SHA: a branch, tag or short SHA is refused before any fetch', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mwsc-install-'));
  try {
    for (const ref of ['main', 'cli/resync-516', 'v0.1.0', '0295ed6', '0295ED6494D99CE5467F0D6E94E91A5C436A18C2', `${'a'.repeat(40)} `, '']) {
      assert.throws(() => obtainCli({ ref, tempDir, log: () => {} }), (e) => e instanceof ActionError && /full commit SHA/.test(e.message), JSON.stringify(ref));
    }
    assert.deepEqual(readdirSync(tempDir), [], 'nothing was created');
    assert.ok(FULL_SHA.test('0295ed6494d99ce5467f0d6e94e91a5c436a18c2'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
