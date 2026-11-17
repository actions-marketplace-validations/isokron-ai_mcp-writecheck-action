#!/usr/bin/env node
/**
 * A stand-in MCP stdio server for the surface probe's tests (corpus/sandbox/surface.mjs). Modes:
 *   ok        initialize (with instructions), then tools/list in two pages; before answering it
 *             prints a line that is not JSON, sends a notification and asks the client for a ping
 *   die       answers initialize, then exits on tools/list
 *   silent    reads and never answers
 *   error     answers initialize with a JSON-RPC error
 * Writes what it received to stderr (the probe forwards it to its own stderr).
 */
const mode = process.argv[2] ?? 'ok';
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    process.stderr.write(`fake-mcp got ${m.method ?? `answer ${m.id}`}\n`);
    if (mode === 'silent') continue;
    if (m.method === 'initialize') {
      if (mode === 'error') { send({ id: m.id, error: { code: -32602, message: 'unsupported' } }); continue; }
      process.stdout.write('starting up, not JSON\n');
      send({ method: 'notifications/message', params: { level: 'info', data: 'hello' } });
      send({ id: 'srv-1', method: 'ping' });
      send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true }, logging: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' }, instructions: 'Call list_items first.' } });
    } else if (m.method === 'tools/list') {
      if (mode === 'die') process.exit(3);
      if (!m.params?.cursor) send({ id: m.id, result: { tools: [{ name: 'list_items', description: 'List items.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }], nextCursor: 'p2' } });
      else send({ id: m.id, result: { tools: [{ name: 'update_item', description: 'Update an item.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, outputSchema: { type: 'object' } }] } });
    } else if (m.id !== undefined && m.method) {
      send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
