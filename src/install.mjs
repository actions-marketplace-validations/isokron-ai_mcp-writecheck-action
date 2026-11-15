/**
 * Obtains the mcp-writecheck CLI: either a built checkout the caller points at (`cli-path`), or
 * one commit fetched and built as contract.mjs describes. Returns the absolute path of the CLI's
 * entry script. Nothing here knows a flag of the CLI; that is contract.mjs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CLI_ENTRY, CLI_MIN_NODE_MAJOR, CLI_SOURCE } from '../contract.mjs';

export class ActionError extends Error {}

/** Environment for git and npm: no prompts, no update check, no audit or funding requests. */
function quietEnv(extra = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    ...extra,
  };
  // why: the token input never reaches git's or npm's children, whoever called this.
  delete env.INPUT_CLI_TOKEN;
  return env;
}

/**
 * Environment for git: no global or system configuration (an earlier step of the job could have
 * set a proxy, a credential helper or hooks there) and no hooks at all. `extra` adds more
 * configuration entries through GIT_CONFIG_* variables.
 */
function gitEnv(extra = []) {
  const entries = [['core.hooksPath', '/dev/null'], ...extra];
  const cfg = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], n) => {
    cfg[`GIT_CONFIG_KEY_${n}`] = k;
    cfg[`GIT_CONFIG_VALUE_${n}`] = v;
  });
  return quietEnv(cfg);
}

/** The value of the HTTP header git sends with the token. Also masked in the job log (src/main.mjs). */
export function authHeaderValue(token) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

/** A pinned commit: exactly 40 lower-case hexadecimal characters. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

function sh(cmd, args, { cwd, env, what }) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) throw new ActionError(`${what}: could not start ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new ActionError(`${what}: ${cmd} ${args[0]} exited with status ${r.status}`);
}

export function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < CLI_MIN_NODE_MAJOR) {
    throw new ActionError(`mcp-writecheck needs Node ${CLI_MIN_NODE_MAJOR} or later; this job runs Node ${process.versions.node}. Add actions/setup-node with node-version ${CLI_MIN_NODE_MAJOR} before this action.`);
  }
}

/**
 * @param {{ ref: string, cliPath?: string, token?: string, tempDir: string, log: (s: string) => void }} o
 * @returns {string} absolute path of the CLI entry script
 */
export function obtainCli(o) {
  if (o.cliPath) {
    const entry = resolve(o.cliPath, CLI_ENTRY);
    if (!existsSync(entry)) throw new ActionError(`cli-path: ${entry} does not exist. Give the folder of a built mcp-writecheck package (the one that holds package.json and ${CLI_ENTRY}).`);
    o.log(`Using the mcp-writecheck build at ${resolve(o.cliPath)} (cli-path); cli-ref is not used.`);
    return entry;
  }
  if (CLI_SOURCE.kind !== 'git') throw new ActionError(`contract.mjs names a CLI source of kind ${JSON.stringify(CLI_SOURCE.kind)}, which src/install.mjs does not implement.`);
  // why: a branch or a tag can move, and a short SHA can become ambiguous. Only a full SHA is fetched,
  // and the fetched commit is checked against it below. `cli-path` is the way to use any other build.
  if (!FULL_SHA.test(o.ref)) throw new ActionError(`cli-ref: ${JSON.stringify(o.ref)} is not a full commit SHA. Give the 40-character lower-case SHA of an mcp-writecheck commit (a branch, tag or short SHA is refused).`);
  if (o.token && !CLI_SOURCE.repository.startsWith('https://')) throw new ActionError(`the CLI repository ${JSON.stringify(CLI_SOURCE.repository)} is not an https URL; the cli-token input is sent only to an https repository.`);

  const dir = join(o.tempDir, `mcp-writecheck-${o.ref.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // why: the token goes to git through its environment, never through argv or the URL, so it
  // cannot appear in a process listing or in the remote's URL in .git/config. Only the fetch gets it.
  const env = gitEnv();
  const fetchEnv = o.token ? gitEnv([[`http.${new URL(CLI_SOURCE.repository).origin}/.extraheader`, authHeaderValue(o.token)]]) : env;
  o.log(`Fetching mcp-writecheck at ${o.ref} from ${CLI_SOURCE.repository}`);
  sh('git', ['init', '--quiet', dir], { env, what: 'fetching the CLI' });
  sh('git', ['-C', dir, 'fetch', '--quiet', '--depth', '1', CLI_SOURCE.repository, o.ref], { env: fetchEnv, what: `fetching the CLI at ${o.ref} (if the repository is private, the cli-token input must be able to read it)` });
  sh('git', ['-C', dir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], { env, what: 'checking out the CLI' });
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env }).stdout.trim();
  if (head !== o.ref) throw new ActionError(`fetched commit ${head}, not the pinned ${o.ref}`);

  const pkg = join(dir, CLI_SOURCE.packageDir);
  for (const [cmd, ...args] of CLI_SOURCE.build) sh(cmd, args, { cwd: pkg, env: quietEnv(), what: 'building the CLI' });
  const entry = join(pkg, CLI_ENTRY);
  if (!existsSync(entry)) throw new ActionError(`the build did not produce ${entry}`);
  return entry;
}
