// A minimal stdio MCP server (newline-delimited JSON-RPC) over the Redis store: create, read, patch and delete
// of items with optimistic locking, an idempotency key, and a delete by title prefix. Defects (REDISFX_DEFECTS, a
// comma list or "all") switch on one named fault each, as tiny-tracker's TRACKER_DEFECTS does.
import { createInterface } from 'node:readline';
import { FIELDS, Store, connectionConfig } from './store.mjs';

export const DEFECTS = ['lost-update', 'empty-filter-deletes-all', 'missing-annotations', 'idempotency-key-dropped'];

export function parseDefects(v) {
  const list = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const set = new Set(list.includes('all') ? DEFECTS : list);
  for (const d of set) if (!DEFECTS.includes(d)) throw new Error(`unknown defect ${d}`);
  return set;
}

const ITEM = {
  type: 'object',
  properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, assignee: { type: ['string', 'null'] }, priority: { type: 'integer' }, version: { type: 'integer' } },
};
const STATUS = { type: 'string', enum: ['open', 'in_progress', 'closed'] };
const PROJECT = { type: 'string', pattern: '^[a-z][a-z0-9-]{1,30}$' };
const VERSION = { type: 'integer', minimum: 1, description: 'The version you read; the write is refused if the item has changed since.' };

export function toolList(defects) {
  const ann = (a) => (defects.has('missing-annotations') ? undefined : a);
  const t = (name, description, properties, required, annotations) => ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, ...(ann(annotations) ? { annotations: ann(annotations) } : {}),
  });
  return [
    t('get_item', 'Read one item by id.', { id: { type: 'string' } }, ['id'], { readOnlyHint: true, openWorldHint: false }),
    t('list_projects', 'List the projects (the containers items live in).', {}, [], { readOnlyHint: true, openWorldHint: false }),
    t('create_project', 'Create a project with a key you choose. A key that exists is refused.', { key: PROJECT, name: { type: 'string', minLength: 1, maxLength: 200 } }, ['key', 'name'], { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
    t('delete_project', 'Delete a project and every item in it.', { key: PROJECT }, ['key'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
    t('list_items', 'List items, optionally only those of one project or whose title starts with a prefix.', { project: PROJECT, title_prefix: { type: 'string', maxLength: 200 } }, [], { readOnlyHint: true, openWorldHint: false }),
    t('create_item', 'Create an item. With idempotency_key, a repeat of the same call returns the first result with replayed: true.', {
      project: PROJECT, title: { type: 'string', minLength: 1, maxLength: 200 }, status: STATUS, priority: { type: 'integer', minimum: 0, maximum: 9 }, assignee: { type: ['string', 'null'], maxLength: 100 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
    }, ['title'], { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
    t('update_item', 'Change some fields of an item. Fields not given are left as they are. Needs the version you read.', {
      id: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 200 }, status: STATUS, priority: { type: 'integer', minimum: 0, maximum: 9 }, assignee: { type: ['string', 'null'], maxLength: 100 }, expected_version: VERSION,
    }, ['id', 'expected_version'], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
    t('delete_item', 'Delete one item. Needs the version you read.', { id: { type: 'string' }, expected_version: VERSION }, ['id', 'expected_version'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
    t('delete_items', 'Delete every item of a project whose title starts with the prefix. A filter is required: an empty or missing prefix is refused.', { project: PROJECT, title_prefix: { type: 'string', maxLength: 200 } }, ['project'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
  ];
}

const text = (o, isError = false, structured = undefined) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) });
const fail = (message, code) => text(message, true, { error: { code, message } });
const conflict = (id) => text(`item ${id} changed since the version you read; nothing was written; re-read it before writing again`, true, { error: { code: 'conflict', status: 412, message: 'version conflict' } });

export async function call(store, defects, name, a) {
  const tool = toolList(defects).find((x) => x.name === name);
  if (!tool) return fail(`unknown tool ${name}`, 'unknown_tool');
  const props = tool.inputSchema.properties;
  for (const k of Object.keys(a)) if (!(k in props)) return fail(`unknown argument ${k}`, 'invalid_params');
  for (const k of tool.inputSchema.required) if (a[k] === undefined) return fail(`${k} is required`, 'invalid_params');
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    const types = [].concat(p.type);
    const ok = v === null ? types.includes('null') : types.some((ty) => (ty === 'integer' ? Number.isInteger(v) : ty === 'string' ? typeof v === 'string' : false));
    if (!ok) return fail(`${k} must be of type ${types.join(' or ')}`, 'invalid_params');
    if (p.pattern && typeof v === 'string' && !new RegExp(p.pattern).test(v)) return fail(`${k} must match ${p.pattern}`, 'invalid_params');
    if (typeof v === 'string' && ((p.minLength && v.length < p.minLength) || (p.maxLength && v.length > p.maxLength))) return fail(`${k} must be at most ${p.maxLength ?? 'n'} characters and at least ${p.minLength ?? 0}`, 'invalid_params');
    if (typeof v === 'number' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) return fail(`${k} must be between ${p.minimum} and ${p.maximum ?? 'any'}`, 'invalid_params');
    if (p.enum && !p.enum.includes(v)) return fail(`${k} must be one of ${p.enum.join(', ')}`, 'invalid_params');
  }
  if (name === 'get_item') {
    const it = await store.get(a.id);
    return it ? text({ item: it }, false, { item: it }) : fail(`item ${a.id} not found`, 'not_found');
  }
  if (name === 'list_items') { const items = await store.list({ project: a.project ?? null, prefix: a.title_prefix ?? '' }); return text({ items }, false, { items }); }
  if (name === 'list_projects') { const projects = await store.projects(); return text({ projects }, false, { projects }); }
  if (name === 'create_project') {
    const pr = await store.createProject(a.key, a.name);
    return pr ? text({ created: true, project: pr }, false, { created: true, project: pr }) : fail(`project ${a.key} already exists; nothing was written`, 'already_exists');
  }
  if (name === 'delete_project') {
    if (a.key === 'inbox') return fail('the inbox project cannot be deleted', 'invalid_params');
    return (await store.deleteProject(a.key)) ? text({ deleted: true, key: a.key }, false, { deleted: true, key: a.key }) : fail(`project ${a.key} not found`, 'not_found');
  }
  if (name === 'create_item') {
    if (a.project && !(await store.projects()).some((x) => x.key === a.project)) return fail(`project ${a.project} not found`, 'not_found');
    const r = await store.create(a, a.idempotency_key ?? null);
    if (r.reused) return fail('idempotency key was already used with other arguments; nothing was written', 'idempotency_key_reused');
    return text({ created: true, item: r.item, replayed: r.replayed }, false, { created: true, item: r.item, replayed: r.replayed });
  }
  if (name === 'update_item') {
    const patch = Object.fromEntries(FIELDS.filter((f) => a[f] !== undefined).map((f) => [f, a[f]]));
    if (Object.keys(patch).length === 0) return fail('give at least one field to change', 'invalid_params');
    const it = await store.update(a.id, patch, a.expected_version);
    if (it) return text({ updated: true, item: it }, false, { updated: true, item: it });
    return (await store.get(a.id)) ? conflict(a.id) : fail(`item ${a.id} not found`, 'not_found');
  }
  if (name === 'delete_item') {
    if (await store.delete(a.id, a.expected_version)) return text({ deleted: true, id: a.id }, false, { deleted: true, id: a.id });
    return (await store.get(a.id)) ? conflict(a.id) : fail(`item ${a.id} not found`, 'not_found');
  }
  if (name === 'delete_items') {
    if (!a.title_prefix && !defects.has('empty-filter-deletes-all')) return fail('title_prefix must not be empty: a filter is required; nothing was deleted', 'invalid_params');
    if (!(await store.projects()).some((x) => x.key === a.project)) return fail(`project ${a.project} not found`, 'not_found');
    const n = await store.deleteByPrefix(a.project, a.title_prefix ?? '');
    return text({ deleted: n }, false, { deleted: n });
  }
  return fail(`unknown tool ${name}`, 'unknown_tool');
}

export async function serve({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const defects = parseDefects(env.REDISFX_DEFECTS);
  const store = new Store(connectionConfig(env), { defects });
  const send = (m) => output.write(`${JSON.stringify(m)}\n`);
  const rl = createInterface({ input });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return;
    const { id, method, params } = msg;
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'redis-tracker', version: '0.1.0' } } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: toolList(defects) } });
    if (method === 'tools/call') {
      const p = call(store, defects, params?.name ?? '', params?.arguments ?? {}).then(
        (result) => send({ jsonrpc: '2.0', id, result }),
        () => send({ jsonrpc: '2.0', id, result: text('redis could not be reached; it is not known whether the write was applied', true, { error: { code: 'backend_unavailable' } }) }),
      ).finally(() => pending.delete(p));
      pending.add(p);
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  });
  await new Promise((resolve) => rl.on('close', resolve));
  await Promise.allSettled([...pending]);
  await store.close().catch(() => {});
}
