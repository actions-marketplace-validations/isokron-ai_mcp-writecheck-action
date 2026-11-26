// The fixture's Redis layer. One hash per item (`rfx:item:<id>`), a set of ids per project and one overall, one hash per
// project, a counter for ids and a string per idempotency key. Optimistic locking is the store's own, with WATCH/MULTI/EXEC
// on the item's key: the server reads the version under WATCH, and EXEC is refused by Redis if anything (the server
// itself or the control channel) wrote the key in between. The `lost-update` defect leaves the version check and the WATCH
// out. An idempotency key is kept with `SET key value NX` (Redis decides who is first), then replaced with the result in
// the same MULTI that writes the item; the `idempotency-key-dropped` defect never writes it.
import { createHash } from 'node:crypto';
import { Pool, toObject } from './resp.mjs';

export const FIELDS = ['title', 'status', 'assignee', 'priority'];
const K = { seq: 'rfx:seq', items: 'rfx:items', projects: 'rfx:projects', item: (id) => `rfx:item:${id}`, proj: (k) => `rfx:project:${k}`, pitems: (k) => `rfx:p:${k}:items`, idem: (k) => `rfx:idem:${k}` };
const PENDING_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function connectionConfig(env = process.env) {
  const url = new URL(env.REDISFX_URL ?? 'redis://127.0.0.1:4630');
  return { host: url.hostname, port: Number(url.port || 6379), password: env.REDISFX_PASSWORD ?? decodeURIComponent(url.password) };
}

export const hashArgs = (o) => createHash('sha256').update(JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex');

/** A stored hash as the item the tools return: the same keys, in the same order, as the PostgreSQL fixture's rows. */
export function toItem(h) {
  if (!h) return null;
  return { id: h.id, project: h.project, title: h.title, status: h.status, assignee: h.assignee ?? null, priority: Number(h.priority), version: Number(h.version) };
}

/** The HSET arguments of an item's fields; an assignee of null is no field at all (HDEL'd by the caller). */
const hsetArgs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined).flatMap(([k, v]) => [k, String(v)]);

export class Store {
  constructor(config, { defects = new Set() } = {}) { this.pool = new Pool(config, 8); this.defects = defects; }
  close() { return this.pool.close(); }

  /** The inbox project and the guard item the manifest's guard reads; harmless when they exist. */
  async seed() {
    await this.pool.with(async (c) => {
      if (await c.cmd('HSETNX', K.proj('inbox'), 'name', 'Inbox')) await c.cmd('SADD', K.projects, 'inbox');
      if (await c.cmd('HSETNX', K.item('guard'), 'id', 'guard')) {
        await c.cmd('MULTI');
        await c.cmd('HSET', K.item('guard'), 'project', 'inbox', 'title', 'redisfx guard', 'status', 'open', 'priority', '0', 'version', '1');
        await c.cmd('SADD', K.items, 'guard');
        await c.cmd('SADD', K.pitems('inbox'), 'guard');
        await c.cmd('EXEC');
      }
    });
  }

  async get(id) { return this.pool.with(async (c) => toItem(toObject(await c.cmd('HGETALL', K.item(id))))); }

  async #many(c, ids) {
    const out = [];
    for (const id of [...ids].sort()) { const it = toItem(toObject(await c.cmd('HGETALL', K.item(id)))); if (it) out.push(it); }
    return out;
  }

  async list({ project = null, prefix = '' } = {}) {
    return this.pool.with(async (c) => (await this.#many(c, await c.cmd('SMEMBERS', project === null ? K.items : K.pitems(project)))).filter((it) => it.title.startsWith(prefix)));
  }

  async projects() {
    return this.pool.with(async (c) => {
      const keys = (await c.cmd('SMEMBERS', K.projects)).sort();
      const out = [];
      for (const key of keys) out.push({ key, name: await c.cmd('HGET', K.proj(key), 'name') });
      return out;
    });
  }

  async createProject(key, name) {
    return this.pool.with(async (c) => {
      if (!(await c.cmd('HSETNX', K.proj(key), 'name', name))) return null;
      await c.cmd('SADD', K.projects, key);
      return { key, name };
    });
  }

  async deleteProject(key) {
    return this.pool.with(async (c) => {
      if (!(await c.cmd('SISMEMBER', K.projects, key))) return false;
      const ids = await c.cmd('SMEMBERS', K.pitems(key));
      await c.cmd('MULTI');
      for (const id of ids) { await c.cmd('DEL', K.item(id)); await c.cmd('SREM', K.items, id); }
      await c.cmd('DEL', K.pitems(key), K.proj(key));
      await c.cmd('SREM', K.projects, key);
      await c.cmd('EXEC');
      return true;
    });
  }

  /** The commands that write a new item, queued in the caller's MULTI. Returns the item. */
  async #queueCreate(c, a, id) {
    const o = { project: a.project ?? 'inbox', title: a.title, status: a.status ?? 'open', assignee: a.assignee ?? null, priority: a.priority ?? 0 };
    await c.cmd('HSET', K.item(id), 'id', id, ...hsetArgs(o), 'version', '1');
    await c.cmd('SADD', K.items, id);
    await c.cmd('SADD', K.pitems(o.project), id);
    return toItem({ id, ...o, version: 1 });
  }

  /** Insert one item; with an idempotency key, the key is claimed with SET NX first (a repeat answers the first result). */
  async create(a, key = null) {
    return this.pool.with(async (c) => {
      const id = `I-${await c.cmd('INCR', K.seq)}`;
      if (!key || this.defects.has('idempotency-key-dropped')) {
        await c.cmd('MULTI');
        const item = await this.#queueCreate(c, a, id);
        await c.cmd('EXEC');
        return { item, replayed: false };
      }
      const h = hashArgs({ project: a.project ?? null, title: a.title, status: a.status ?? null, assignee: a.assignee ?? null, priority: a.priority ?? null });
      if ((await c.cmd('SET', K.idem(key), JSON.stringify({ h, pending: true }), 'NX', 'PX', String(PENDING_MS))) === null) {
        // Someone claimed the key first: wait for their result (a claim that never finished expires, and then the key is free).
        for (let i = 0; i < 100; i++) {
          const raw = await c.cmd('GET', K.idem(key));
          if (raw === null) return this.create(a, key);
          const e = JSON.parse(raw);
          if (e.h !== h) return { reused: true };
          if (!e.pending) return { item: e.item, replayed: true };
          await sleep(50);
        }
        throw new Error('the idempotency key is claimed and has not finished');
      }
      await c.cmd('MULTI');
      const item = await this.#queueCreate(c, a, id);
      await c.cmd('SET', K.idem(key), JSON.stringify({ h, item }));
      await c.cmd('EXEC');
      return { item, replayed: false };
    });
  }

  /**
   * Patch some fields. The item's key is WATCHed, its version read and compared with the one the caller read, and the write
   * is a MULTI/EXEC that Redis refuses if the key changed meanwhile. Returns the item, or null (not found, or a changed
   * version: the caller tells them apart). The `lost-update` defect writes without looking at the version.
   */
  async update(id, patch, expected) {
    const cols = Object.keys(patch).filter((k) => FIELDS.includes(k));
    const set = Object.fromEntries(cols.map((k) => [k, patch[k]]));
    const unset = cols.filter((k) => set[k] === null);
    return this.pool.with(async (c) => {
      const safe = !this.defects.has('lost-update');
      if (safe) await c.cmd('WATCH', K.item(id));
      try {
        const cur = toItem(toObject(await c.cmd('HGETALL', K.item(id))));
        if (!cur || (safe && cur.version !== expected)) return null;
        await c.cmd('MULTI');
        if (Object.values(set).some((v) => v !== null)) await c.cmd('HSET', K.item(id), ...hsetArgs(set));
        if (unset.length) await c.cmd('HDEL', K.item(id), ...unset);
        await c.cmd('HINCRBY', K.item(id), 'version', '1');
        await c.cmd('HGETALL', K.item(id));
        const r = await c.cmd('EXEC');
        return r === null ? null : toItem(toObject(r[r.length - 1]));
      } finally { if (safe) await c.cmd('UNWATCH'); }
    });
  }

  async delete(id, expected) {
    return this.pool.with(async (c) => {
      const safe = !this.defects.has('lost-update');
      if (safe) await c.cmd('WATCH', K.item(id));
      try {
        const cur = toItem(toObject(await c.cmd('HGETALL', K.item(id))));
        if (!cur || (safe && cur.version !== expected)) return false;
        await c.cmd('MULTI');
        await c.cmd('DEL', K.item(id));
        await c.cmd('SREM', K.items, id);
        await c.cmd('SREM', K.pitems(cur.project), id);
        const r = await c.cmd('EXEC');
        return r !== null;
      } finally { if (safe) await c.cmd('UNWATCH'); }
    });
  }

  /** Delete every item of the project whose title starts with the prefix. The `empty-filter-deletes-all` defect lets an empty prefix through (in mcp.mjs). */
  async deleteByPrefix(project, prefix) {
    return this.pool.with(async (c) => {
      const hit = (await this.#many(c, await c.cmd('SMEMBERS', K.pitems(project)))).filter((it) => it.title.startsWith(prefix));
      if (!hit.length) return 0;
      await c.cmd('MULTI');
      for (const it of hit) { await c.cmd('DEL', K.item(it.id)); await c.cmd('SREM', K.items, it.id); await c.cmd('SREM', K.pitems(project), it.id); }
      await c.cmd('EXEC');
      return hit.length;
    });
  }

  // The control channel's side (the platform, not the MCP server): the same data, changed without the server's checks,
  // with the version moved on every change as a database trigger would.
  async adminCreate(o) {
    return this.pool.with(async (c) => {
      const id = `I-${await c.cmd('INCR', K.seq)}`;
      await c.cmd('MULTI');
      const item = await this.#queueCreate(c, o, id);
      await c.cmd('EXEC');
      return item;
    });
  }

  async adminUpdate(id, fields) {
    const unset = Object.keys(fields).filter((k) => fields[k] === null);
    return this.pool.with(async (c) => {
      await c.cmd('MULTI');
      if (Object.values(fields).some((v) => v !== null)) await c.cmd('HSET', K.item(id), ...hsetArgs(fields));
      if (unset.length) await c.cmd('HDEL', K.item(id), ...unset);
      await c.cmd('HINCRBY', K.item(id), 'version', '1');
      await c.cmd('HGETALL', K.item(id));
      const r = await c.cmd('EXEC');
      return toItem(toObject(r[r.length - 1]));
    });
  }

  async adminDelete(id) {
    return this.pool.with(async (c) => {
      const cur = toItem(toObject(await c.cmd('HGETALL', K.item(id))));
      if (!cur) return false;
      await c.cmd('MULTI');
      await c.cmd('DEL', K.item(id));
      await c.cmd('SREM', K.items, id);
      await c.cmd('SREM', K.pitems(cur.project), id);
      await c.cmd('EXEC');
      return true;
    });
  }

  async hasProject(key) { return this.pool.with(async (c) => Boolean(await c.cmd('SISMEMBER', K.projects, key))); }
  async info() { return this.pool.with((c) => c.cmd('INFO', 'server')); }
}
