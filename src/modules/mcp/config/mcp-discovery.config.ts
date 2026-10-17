import { randomBytes } from 'node:crypto';

/**
 * The secret `search_tools` cursors are signed with (design spec §7.4,
 * "Paging"). Every MCP instance must share it, or a cursor issued by one
 * instance is `INVALID_CURSOR` on the next.
 *
 * `MCP_SEARCH_CURSOR_SECRET`, at least 32 characters. Required when
 * `NODE_ENV=production`. Elsewhere a random per-process secret is used, so a
 * local run needs no setup; a cursor then dies with the process.
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
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'MCP_SEARCH_CURSOR_SECRET must be set when NODE_ENV=production: the shared secret ' +
        'search_tools cursors are signed with (at least 32 characters, e.g. openssl rand -hex 32)',
    );
  }
  return { cursorSecret: randomBytes(32).toString('hex') };
}
