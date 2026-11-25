#!/usr/bin/env node
// pg-tracker: IsoKron's PostgreSQL-backed fixture MCP server for the writecheck loop.
//   cli.mjs server                  the MCP server on stdio (env PGFX_DATABASE_URL, PGFX_PASSWORD, PGFX_DEFECTS)
//   cli.mjs backend --port <n>      a disposable PostgreSQL on 127.0.0.1:<n> and its control channel on <n+1>
import './guard.mjs';
import { runBackend } from './backend.mjs';
import { serve } from './mcp.mjs';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'server') {
  await serve();
} else if (cmd === 'backend') {
  const i = rest.indexOf('--port');
  const port = Number(rest[i + 1]);
  if (i < 0 || !Number.isInteger(port) || port < 1024 || port > 65000) {
    process.stderr.write('usage: cli.mjs backend --port <1024..65000>\n');
    process.exit(2);
  }
  await runBackend({ port });
} else {
  process.stderr.write('usage: cli.mjs server | backend --port <n>\n');
  process.exit(2);
}
