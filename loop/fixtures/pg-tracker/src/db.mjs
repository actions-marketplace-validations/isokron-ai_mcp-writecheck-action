// The fixture's database layer: one PostgreSQL schema and the statements the server and the control channel use.
// Optimistic locking lives in the database: a BEFORE UPDATE trigger moves `version` on every row change, whoever
// makes it (the MCP server or the control channel), and the server's UPDATE and DELETE carry `AND version = $n`.
import { createHash } from 'node:crypto';
import pg from 'pg';

export const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS item_seq START 1;
CREATE TABLE IF NOT EXISTS projects (key text PRIMARY KEY, name text NOT NULL);
INSERT INTO projects (key, name) VALUES ('inbox', 'Inbox') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS items (
  id text PRIMARY KEY DEFAULT ('I-' || nextval('item_seq')),
  project text NOT NULL DEFAULT 'inbox' REFERENCES projects(key) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  assignee text,
  priority integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1
);
CREATE OR REPLACE FUNCTION items_bump() RETURNS trigger AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS items_bump ON items;
CREATE TRIGGER items_bump BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION items_bump();
CREATE TABLE IF NOT EXISTS idempotency (
  key text PRIMARY KEY,
  tool text NOT NULL,
  args_hash text NOT NULL,
  result jsonb NOT NULL
);
INSERT INTO items (id, title, status) VALUES ('guard', 'pgfx guard', 'open') ON CONFLICT DO NOTHING;
`;

const like = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
export const FIELDS = ['title', 'status', 'assignee', 'priority'];
const COLS = 'id, project, title, status, assignee, priority, version';

export function connectionConfig(env = process.env) {
  const url = new URL(env.PGFX_DATABASE_URL ?? 'postgres://mws@127.0.0.1:4620/mws');
  return { host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username || 'mws'), password: env.PGFX_PASSWORD ?? decodeURIComponent(url.password), database: url.pathname.slice(1) || 'mws' };
}

export const hashArgs = (o) => createHash('sha256').update(JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex');

export class Store {
  constructor(config, { defects = new Set() } = {}) { this.pool = new pg.Pool({ ...config, max: 8, connectionTimeoutMillis: 5000 }); this.defects = defects; this.pool.on('error', () => {}); }
  close() { return this.pool.end(); }

  async get(id) { const r = await this.pool.query(`SELECT ${COLS} FROM items WHERE id = $1`, [id]); return r.rows[0] ?? null; }
  async list({ project = null, prefix = '' } = {}) { const r = await this.pool.query(`SELECT ${COLS} FROM items WHERE ($1::text IS NULL OR project = $1) AND title LIKE $2 ORDER BY id`, [project, `${like(prefix)}%`]); return r.rows; }
  async projects() { return (await this.pool.query('SELECT key, name FROM projects ORDER BY key')).rows; }
  async createProject(key, name) { const r = await this.pool.query('INSERT INTO projects (key, name) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key, name', [key, name]); return r.rows[0] ?? null; }
  async deleteProject(key) { return (await this.pool.query('DELETE FROM projects WHERE key = $1', [key])).rowCount === 1; }

  /** Insert one item; with an idempotency key, in one transaction with the key's row (a repeat answers the first result). */
  async create(a, key = null) {
    const row = [a.project ?? 'inbox', a.title, a.status ?? 'open', a.assignee ?? null, a.priority ?? 0];
    const ins = `INSERT INTO items (project, title, status, assignee, priority) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`;
    if (!key || this.defects.has('idempotency-key-dropped')) return { item: (await this.pool.query(ins, row)).rows[0], replayed: false };
    const client = await this.pool.connect();
    const h = hashArgs({ project: a.project ?? null, title: a.title, status: a.status ?? null, assignee: a.assignee ?? null, priority: a.priority ?? null });
    try {
      await client.query('BEGIN');
      const k = await client.query('INSERT INTO idempotency (key, tool, args_hash, result) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING RETURNING key', [key, 'create_item', h, '{}']);
      if (k.rowCount === 0) {
        await client.query('COMMIT');
        const e = (await client.query('SELECT args_hash, result FROM idempotency WHERE key = $1', [key])).rows[0];
        if (e.args_hash !== h) return { reused: true };
        return { item: e.result.item, replayed: true };
      }
      const item = (await client.query(ins, row)).rows[0];
      await client.query('UPDATE idempotency SET result = $2 WHERE key = $1', [key, JSON.stringify({ item })]);
      await client.query('COMMIT');
      return { item, replayed: false };
    } catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection gone */ } throw e; } finally { client.release(); }
  }

  /** Patch some fields. With a version the row must still have it; the `lost-update` defect leaves the check out. */
  async update(id, patch, expected) {
    const cols = Object.keys(patch).filter((k) => FIELDS.includes(k));
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const check = this.defects.has('lost-update') ? '' : ` AND version = $${cols.length + 2}`;
    const args = [id, ...cols.map((c) => patch[c]), ...(check ? [expected] : [])];
    const r = await this.pool.query(`UPDATE items SET ${sets} WHERE id = $1${check} RETURNING ${COLS}`, args);
    return r.rows[0] ?? null;
  }

  async delete(id, expected) {
    const check = this.defects.has('lost-update') ? '' : ' AND version = $2';
    const r = await this.pool.query(`DELETE FROM items WHERE id = $1${check}`, check ? [id, expected] : [id]);
    return r.rowCount === 1;
  }

  /** Delete every item whose title starts with the prefix. The `empty-filter-deletes-all` defect lets an empty prefix through. */
  async deleteByPrefix(project, prefix) {
    const r = await this.pool.query('DELETE FROM items WHERE project = $1 AND title LIKE $2', [project, `${like(prefix)}%`]);
    return r.rowCount;
  }
}
