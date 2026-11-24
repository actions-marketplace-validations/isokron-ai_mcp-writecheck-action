#!/usr/bin/env node
/**
 * The server side of a split run (R-WC-05). Ours, from the read-only tools volume, but it runs in the server's own
 * sandbox container, next to the server under test and nothing else of ours: no CLI, no output volume.
 *
 *   node bridge.mjs <port> -- <server command...>
 *
 * Listens on TCP <port> on the run network. Each connection starts one server process and joins the connection
 * to its stdin and stdout, byte for byte, as a stdio MCP server's pipes; the server's stderr goes to this
 * container's log. When the connection closes the process is stopped (SIGTERM, then SIGKILL after 2 s); when the
 * process ends the connection is closed. At most 8 connections at once and 64 in all. Prints one line,
 * {"listening": <port>}, when ready.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const argv = process.argv.slice(2);
const port = Number(argv[0]);
if (!(Number.isInteger(port) && port > 1023 && port < 65536) || argv[1] !== '--' || argv.length < 3) {
  process.stderr.write('usage: bridge.mjs <port> -- <server command...>\n');
  process.exit(2);
}
const cmd = argv.slice(2);
let open = 0;
let total = 0;
// allowHalfOpen: the CLI ends stdin to stop a stdio server; the server still answers, then exits.
const server = createServer({ allowHalfOpen: true }, (sock) => {
  if (open >= 8 || total >= 64) { sock.destroy(); return; }
  open++; total++;
  let child;
  try { child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] }); } catch { open--; sock.destroy(); return; }
  let done = false;
  const stop = () => {
    if (done) return;
    done = true; open--;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
  };
  sock.on('error', stop);
  sock.on('close', stop);
  child.on('error', () => { sock.destroy(); stop(); });
  child.on('exit', () => { sock.end(); });
  child.stdin.on('error', () => {});
  sock.pipe(child.stdin);
  child.stdout.pipe(sock);
});
server.listen(port, '0.0.0.0', () => process.stdout.write(`${JSON.stringify({ listening: port })}\n`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
