#!/usr/bin/env node
// Copies a fixture's pinned backend files out of its image into a folder (the CI job of redis-tracker's live tests and a
// person's own run): node loop/extract-binary.mjs <fixture id> <out dir>. Needs a Docker Engine; runs no code of the image.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerPlatform, extractBinaryImage } from './binary-image.mjs';
import { loadFixtures } from './items.mjs';

const [id, out] = process.argv.slice(2);
if (!id || !out) { process.stderr.write('usage: extract-binary.mjs <fixture id> <out dir>\n'); process.exit(2); }
const here = fileURLToPath(new URL('.', import.meta.url));
const spec = loadFixtures(join(here, 'fixtures.json')).fixtures[id]?.binary_image;
if (!spec) { process.stderr.write(`fixture ${id} has no binary_image\n`); process.exit(2); }
const dock = (argv) => new Promise((done) => {
  const c = spawn('docker', argv, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  c.stderr.on('data', (d) => { err += d; });
  c.on('close', (exit) => done({ exit, stderr_tail: err.slice(-400) }));
  c.on('error', () => done({ exit: 127, stderr_tail: 'docker not found' }));
});
const pulled = await dock(['pull', '-q', spec.ref]);
if (pulled.exit !== 0) { process.stderr.write(`docker pull failed: ${pulled.stderr_tail}\n`); process.exit(1); }
const r = await extractBinaryImage({ dock, spec, platform: dockerPlatform(), outDir: resolve(out), containerName: `extract-${id}-${process.pid}` });
process.stdout.write(`${JSON.stringify(r)}\n`);
