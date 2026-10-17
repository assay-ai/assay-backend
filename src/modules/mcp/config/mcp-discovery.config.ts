import { randomBytes } from 'node:crypto';

/**
 * The secret `search_tools` cursors are signed with (design spec §7.4,
 * "Paging"). Every MCP instance must share it, or a cursor issued by one
 * instance is `INVALID_CURSOR` on the next.
 *
 * `MCP_SEARCH_CURSOR_SECRET`, at least 32 characters. Required on every
 * deployment that is not local: `NODE_ENV=production`, and any other
 * environment whose MCP host (`MCP_PUBLIC_URL`) is not a loopback address —
 * a shared development host runs more than one instance too. Only a local
 * run (`NODE_ENV=local` or `test`, or an MCP host on localhost) falls back to
 * a random per-process secret, so it needs no setup; a cursor then dies with
 * the process.
 */
export interface McpDiscoveryConfig {
  readonly cursorSecret: string;
}

export const MCP_DISCOVERY_CONFIG = 'MCP_DISCOVERY_CONFIG';

export const MIN_CURSOR_SECRET_LENGTH = 32;

export function loadMcpDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): McpDiscoveryConfig {
  const secret = env.MCP_SEARCH_CURSOR_SECRET?.trim();
  if (secret) {
    if (secret.length < MIN_CURSOR_SECRET_LENGTH) {
      throw new Error(
        `MCP_SEARCH_CURSOR_SECRET must be at least ${MIN_CURSOR_SECRET_LENGTH} characters`,
      );
    }
    return { cursorSecret: secret };
  }
  if (!isLocalDeployment(env)) {
    throw new Error(
      'MCP_SEARCH_CURSOR_SECRET must be set outside a local run (NODE_ENV=production, or an ' +
        'MCP_PUBLIC_URL that is not localhost): the secret every MCP instance signs ' +
        'search_tools cursors with (at least 32 characters, e.g. openssl rand -hex 32)',
    );
  }
  return { cursorSecret: randomBytes(32).toString('hex') };
}

const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(['local', 'test']);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A run on one machine: `NODE_ENV` local or test, or — outside production —
 * an MCP host that is a loopback address (unset means the local default,
 * `http://localhost:3200`, see `loadMcpHostConfig`).
 */
export function isLocalDeployment(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv && LOCAL_ENVIRONMENTS.has(nodeEnv)) return true;
  if (nodeEnv === 'production') return false;
  const host = env.MCP_PUBLIC_URL?.trim();
  if (!host) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(host).hostname);
  } catch {
    return false;
  }
}
