#!/usr/bin/env node
/**
 * Keeps the server-under-test's stderr for the corpus record. Ours, not target code: it sits in the
 * read-only CLI volume (/opt/mwsc/_corpus) and the CLI starts the server through it:
 *
 *   node stderr-tee.mjs <dir> <cap-bytes> -- <server command> [args...]
 *
 * The server's stdin and stdout are inherited untouched (the MCP stream never passes through here).
 * Its stderr is forwarded to our own stderr in full, so the CLI sees what it always saw, and the
 * first <cap-bytes> of it are also written to <dir>/<n>-<pid>.log, with a closing line giving the
 * bytes dropped and how the server ended. <dir> is under /work/out, so the copy-out brings it into
 * the encrypted bundle; it is never printed by the driver. At most MAX_FILES files are written per
 * folder, so a server restarted many times cannot multiply the cap. A file is created exclusively
 * and never through a symlink; if that fails (something planted there), stderr is still forwarded.
 * The exit status and a terminating signal of the server are passed on as our own.
 */
import { spawn } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_FILES = 16;

export function main(argv) {
  const [dir, capArg, sep, cmd, ...args] = argv;
  const cap = Number(capArg);
  if (!dir || !(cap >= 0) || sep !== '--' || !cmd) {
    process.stderr.write('stderr-tee: usage: stderr-tee.mjs <dir> <cap> -- <command> [args...]\n');
    process.exit(125);
  }
  let fd = null;
  try {
    mkdirSync(dir, { recursive: true });
    const n = readdirSync(dir).length;
    if (n < MAX_FILES) {
      fd = openSync(join(dir, `${String(n + 1).padStart(2, '0')}-${process.pid}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
  } catch {
    fd = null;
  }
  let kept = 0;
  let dropped = 0;
  const child = spawn(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'] });
  child.stderr.on('data', (c) => {
    try { process.stderr.write(c); } catch {}
    if (fd === null) return;
    const keep = Math.max(0, Math.min(c.length, cap - kept));
    if (keep) {
      try { writeSync(fd, keep === c.length ? c : c.subarray(0, keep)); } catch { fd = null; }
      kept += keep;
    }
    dropped += c.length - keep;
  });
  // A signal sent to us alone (not to the process group) reaches the server too.
  const forward = (sig) => { try { child.kill(sig); } catch {} };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => forward(sig));
  child.on('error', (e) => {
    process.stderr.write(`stderr-tee: could not start the server: ${e.message}\n`);
    if (fd !== null) { try { writeSync(fd, `\n# could not start: ${e.code ?? e.message}\n`); closeSync(fd); } catch {} }
    process.exit(127);
  });
  child.on('close', (code, signal) => {
    if (fd !== null) {
      try {
        writeSync(fd, `${dropped ? `\n# ${dropped} bytes of stderr dropped (cap ${cap})` : ''}\n# server exit ${code} signal ${signal}\n`);
        closeSync(fd);
      } catch {}
    }
    if (signal) {
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeAllListeners(sig);
      process.kill(process.pid, signal);
      setTimeout(() => process.exit(128), 1000).unref();
      return;
    }
    process.exit(code ?? 1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
