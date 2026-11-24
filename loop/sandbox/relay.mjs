#!/usr/bin/env node
/**
 * The CLI side of a split run (R-WC-05). Ours, from the read-only tools volume, in the CLI's own sandbox container.
 * The CLI starts it as "the server": it joins this process's stdin and stdout to a TCP connection to the bridge
 * (loop/sandbox/bridge.mjs) in the server's container, so the server under test never runs next to the CLI.
 *
 *   node relay.mjs <host> <port>
 *
 * Exits 0 when the bridge closes the connection, 1 when it cannot connect (within 10 s) or the connection fails.
 */
import { connect } from 'node:net';

const [host, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(host)) || !(Number.isInteger(port) && port > 0 && port < 65536)) {
  process.stderr.write('usage: relay.mjs <ipv4 host> <port>\n');
  process.exit(2);
}
const sock = connect({ host, port, timeout: 10_000, allowHalfOpen: true });
sock.on('connect', () => sock.setTimeout(0));
sock.on('timeout', () => { process.stderr.write('relay: the server bridge did not answer\n'); process.exit(1); });
sock.on('error', (e) => { process.stderr.write(`relay: ${String(e.code ?? 'error').slice(0, 40)}\n`); process.exit(1); });
sock.on('close', () => process.exit(0));
process.stdin.pipe(sock);
sock.pipe(process.stdout);
process.on('SIGTERM', () => { sock.destroy(); process.exit(0); });
