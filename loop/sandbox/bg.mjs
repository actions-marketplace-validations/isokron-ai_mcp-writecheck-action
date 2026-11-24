#!/usr/bin/env node
/**
 * Starts a fixture's backend next to the CLI, inside the same sandbox container (ours, from the read-only tools
 * volume). Used only for IsoKron's own fixture servers (loop/fixtures.json), whose backend is disposable and lives
 * in memory or in the container's own work folder:
 *
 *   node bg.mjs '<json: { "argv": [...], "log": "/work/out/backend.log", "ready": "text", "wait_ms": 10000 }>' -- <main argv...>
 *
 * The background command starts first, its output going to `log`; once `ready` shows in the log (or wait_ms has
 * passed, or it ended) the main command runs with this process's stdin, stdout and stderr. When the main command
 * ends the background one is stopped, and this process exits with the main command's status.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
let spec = null;
try { spec = JSON.parse(argv[0]); } catch { /* reported below */ }
if (sep !== 1 || !spec || !Array.isArray(spec.argv) || spec.argv.length === 0 || typeof spec.log !== 'string' || argv.length < 3) {
  process.stderr.write('usage: bg.mjs <json spec> -- <main argv...>\n');
  process.exit(2);
}
const main = argv.slice(2);
const fd = openSync(spec.log, 'a');
const bg = spawn(spec.argv[0], spec.argv.slice(1), { stdio: ['ignore', fd, fd] });
closeSync(fd);
let bgDone = false;
bg.on('exit', () => { bgDone = true; });
bg.on('error', () => { bgDone = true; });
const until = Date.now() + (Number.isInteger(spec.wait_ms) ? spec.wait_ms : 10_000);
while (!bgDone && Date.now() < until) {
  let text = '';
  try { text = readFileSync(spec.log, 'utf8'); } catch { /* not yet */ }
  if (spec.ready && text.includes(spec.ready)) break;
  await sleep(100);
}
const child = spawn(main[0], main.slice(1), { stdio: 'inherit' });
const stop = () => { try { bg.kill('SIGTERM'); } catch { /* gone */ } };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } stop(); });
child.on('error', () => { stop(); process.exit(127); });
child.on('exit', (code, signal) => { stop(); process.exit(code ?? (signal ? 128 : 1)); });
