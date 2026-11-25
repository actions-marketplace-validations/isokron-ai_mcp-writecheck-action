// A minimal Redis client (RESP2, TCP, AUTH, pipelined replies in order) so that the fixture has no dependency to pin:
// every command is an array of strings, every reply a string, a number, null, an array or a RespError. A connection
// is one session, which is what WATCH/MULTI/EXEC needs (the watch belongs to the connection), so a transaction takes a
// connection of its own from the pool and gives it back.
import net from 'node:net';

export class RespError extends Error {}

/** One reply from the front of `buf` at `off`: [value, next offset], or null when the buffer ends inside it. */
export function parseReply(buf, off = 0) {
  if (off >= buf.length) return null;
  const type = String.fromCharCode(buf[off]);
  const eol = buf.indexOf('\r\n', off, 'latin1');
  if (eol < 0) return null;
  const line = buf.toString('utf8', off + 1, eol);
  const next = eol + 2;
  if (type === '+') return [line, next];
  if (type === '-') return [new RespError(line), next];
  if (type === ':') return [Number(line), next];
  if (type === '$') {
    const n = Number(line);
    if (n < 0) return [null, next];
    if (buf.length < next + n + 2) return null;
    return [buf.toString('utf8', next, next + n), next + n + 2];
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return [null, next];
    const out = [];
    let at = next;
    for (let i = 0; i < n; i++) {
      const r = parseReply(buf, at);
      if (!r) return null;
      out.push(r[0]);
      at = r[1];
    }
    return [out, at];
  }
  throw new Error(`unexpected RESP type ${JSON.stringify(type)}`);
}

export const encode = (args) => Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap((a) => { const b = Buffer.from(String(a), 'utf8'); return [Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')]; })]);

export class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiting = [];
    this.dead = null;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    const fail = (e) => { this.dead ??= e ?? new Error('connection closed'); for (const w of this.waiting.splice(0)) w.reject(this.dead); };
    socket.on('error', fail);
    socket.on('close', () => fail());
  }

  static connect({ host, port, password, timeoutMs = 5000 }) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      socket.setNoDelay(true);
      const t = setTimeout(() => { socket.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      socket.once('error', (e) => { clearTimeout(t); reject(e); });
      socket.once('connect', async () => {
        clearTimeout(t);
        socket.removeAllListeners('error');
        const c = new Conn(socket);
        try { if (password) await c.cmd('AUTH', password); resolve(c); } catch (e) { c.close(); reject(e); }
      });
    });
  }

  drain() {
    for (;;) {
      let r;
      try { r = parseReply(this.buf); } catch (e) { this.dead = e; for (const w of this.waiting.splice(0)) w.reject(e); return; }
      if (!r) return;
      this.buf = this.buf.subarray(r[1]);
      const w = this.waiting.shift();
      if (!w) continue;
      if (r[0] instanceof RespError) w.reject(r[0]); else w.resolve(r[0]);
    }
  }

  /** Send one command and wait for its reply (replies come back in the order sent). */
  cmd(...args) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => { this.waiting.push({ resolve, reject }); this.socket.write(encode(args)); });
  }

  close() { this.socket.destroy(); }
}

/** A few connections, one per task in flight; a connection that failed is dropped, not reused. */
export class Pool {
  constructor(cfg, max = 8) { this.cfg = cfg; this.max = max; this.idle = []; this.open = 0; this.queue = []; }

  async acquire() {
    for (;;) {
      const c = this.idle.pop();
      if (c) { if (c.dead) { this.open--; continue; } return c; }
      if (this.open < this.max) { this.open++; try { return await Conn.connect(this.cfg); } catch (e) { this.open--; throw e; } }
      await new Promise((r) => this.queue.push(r));
    }
  }

  release(c, ok = true) {
    if (!ok || c.dead) { c.close(); this.open--; } else this.idle.push(c);
    this.queue.shift()?.();
  }

  /** Run fn(conn) on a connection of the pool. fn must leave no WATCH or MULTI open (the store UNWATCHes on every path). */
  async with(fn) {
    const c = await this.acquire();
    let ok = false;
    try { const r = await fn(c); ok = true; return r; } finally { this.release(c, ok); }
  }

  async close() { for (const c of this.idle.splice(0)) c.close(); this.open = 0; }
}

/** [k1, v1, k2, v2] (a hash reply) as an object, or null for an empty one. */
export const toObject = (a) => {
  if (!Array.isArray(a) || a.length === 0) return null;
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
  return o;
};
