#!/usr/bin/env node
/**
 * The server surface, for the encrypted record: starts the server under test, sends `initialize`
 * (then `notifications/initialized`) and `tools/list` (every page), and nothing else. Ours, not
 * target code: it runs read-only from the CLI volume, inside the same sandbox container as the CLI
 * (user 10001, no capability, read-only root, the target's internal network), and the server it
 * starts is the one the CLI starts.
 *
 *   node surface.mjs <protocol version> <time limit ms> -- <server command...>
 *
 * Prints one JSON line on stdout:
 *   { protocol_offered, initialize, initialize_error, tools, tools_error, pages, transport, captured_at }
 * `initialize` and `tools` are the servers' JSON-RPC results as received (tools: every page's tools
 * joined into one result), or null with the matching `_error`. The server's stderr goes to this
 * process's stderr (the step's log, in the encrypted bundle). A request from the server is answered
 * with an empty result for ping and "method not found" for anything else. Exit 0 when both answers
 * came, 1 otherwise; 2 on a usage error.
 */
import { spawn } from 'node:child_process';

/** Bytes of server stdout read at most: the printed line has to fit the driver's 16 MiB capture. */
export const READ_CAP = 12 * 1024 * 1024;
/** tools/list pages followed at most. */
export const MAX_PAGES = 100;

export function probe(command, { protocol, timeoutMs, env = process.env, stderr = process.stderr }) {
  return new Promise((done) => {
    const out = {
      protocol_offered: protocol, initialize: null, initialize_error: null, tools: null, tools_error: null, pages: 0,
      transport: { stdout_bytes: 0, non_json_lines: 0, notifications: 0, server_requests: 0, exit: null, signal: null, over_cap: false },
      captured_at: null,
    };
    let child;
    try {
      child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      out.initialize_error = `the server did not start: ${e.message}`;
      out.captured_at = new Date().toISOString();
      return done(out);
    }
    const pending = new Map();
    let nextId = 0;
    let finished = false;
    let closed = null;
    let buf = Buffer.alloc(0);
    const send = (m) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`); } catch {} };
    const request = (method, params) => new Promise((res) => {
      if (closed) return res({ error: closed });
      const id = ++nextId;
      pending.set(id, res);
      send({ id, method, ...(params === undefined ? {} : { params }) });
    });
    const failAll = (why) => { for (const [id, res] of pending) { pending.delete(id); res({ error: why }); } };
    child.stdin.on('error', () => {});
    child.stderr.on('data', (c) => stderr.write(c));
    child.on('error', (e) => failAll(`the server did not start: ${e.message}`));
    child.on('close', (code, signal) => {
      out.transport.exit = code;
      out.transport.signal = signal;
      closed = `the server exited (exit ${code} signal ${signal})`;
      failAll(`the server exited (exit ${code} signal ${signal})`);
    });
    child.stdout.on('data', (c) => {
      out.transport.stdout_bytes += c.length;
      if (out.transport.stdout_bytes > READ_CAP) {
        if (!out.transport.over_cap) { out.transport.over_cap = true; closed = `the server wrote more than ${READ_CAP} bytes`; failAll(closed); }
        return;
      }
      buf = Buffer.concat([buf, c]);
      let i;
      while ((i = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, i).toString('utf8').trim();
        buf = buf.subarray(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { out.transport.non_json_lines++; continue; }
        if (!m || typeof m !== 'object' || Array.isArray(m)) { out.transport.non_json_lines++; continue; }
        if (typeof m.method === 'string') {
          if (m.id === undefined) { out.transport.notifications++; continue; }
          out.transport.server_requests++;
          if (m.method === 'ping') send({ id: m.id, result: {} });
          else send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
          continue;
        }
        const res = pending.get(m.id);
        if (!res) continue;
        pending.delete(m.id);
        if (m.error !== undefined) res({ error: `JSON-RPC error ${JSON.stringify(m.error).slice(0, 500)}` });
        else if (m.result && typeof m.result === 'object' && !Array.isArray(m.result)) res({ result: m.result });
        else res({ error: 'the answer has no result object' });
      }
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      out.captured_at = new Date().toISOString();
      try { child.stdin.end(); } catch {}
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      kill.unref();
      try { child.kill('SIGTERM'); } catch {}
      done(out);
    };
    const timer = setTimeout(() => {
      closed ??= `time limit (${timeoutMs} ms)`;
      failAll(closed);
    }, timeoutMs);
    (async () => {
      const init = await request('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'mwsc-corpus-surface', version: '1' } });
      if (init.error) { out.initialize_error = init.error; return finish(); }
      out.initialize = init.result;
      send({ method: 'notifications/initialized' });
      const tools = [];
      let first = null;
      let cursor;
      for (;;) {
        const page = await request('tools/list', cursor === undefined ? undefined : { cursor });
        if (page.error) { out.tools_error = page.error; return finish(); }
        out.pages++;
        if (!Array.isArray(page.result.tools)) { out.tools_error = 'the tools/list result has no tools list'; return finish(); }
        tools.push(...page.result.tools);
        if (!first) { const { tools: _t, nextCursor: _n, ...rest } = page.result; first = rest; }
        const next = page.result.nextCursor;
        if (next === undefined || next === null) break;
        if (typeof next !== 'string' || out.pages >= MAX_PAGES) { out.tools_error = `tools/list paging stopped after ${out.pages} page(s)`; return finish(); }
        cursor = next;
      }
      out.tools = { ...first, tools };
      finish();
    })();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [protocol, ms, sep, ...command] = process.argv.slice(2);
  if (!protocol || !(Number(ms) > 0) || sep !== '--' || !command.length) {
    process.stderr.write('usage: surface.mjs <protocol version> <time limit ms> -- <server command...>\n');
    process.exit(2);
  }
  const out = await probe(command, { protocol, timeoutMs: Number(ms) });
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(out.initialize && out.tools ? 0 : 1));
}
