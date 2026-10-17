/**
 * Where the MCP host and the web app live (design spec §7.4, "Host").
 *
 * `MCP_PUBLIC_URL` is the origin agents connect to — `https://mcp.assay.ai`
 * in production, `http://localhost:3200` for a local run, with every path at
 * the root either way. It is the base of every canonical MCP URL, so the API
 * (which builds them for toolsets and the Connect preview) and the MCP
 * service must agree on it.
 *
 * `WEB_APP_URL` is where a browser that opens an MCP URL is redirected.
 *
 * `MCP_ROOT_PINNED_TOOLS` is the root's "Always loaded" list
 * (`root_pinned_tools`): up to 5 tool names, comma separated, listed directly
 * when `/` runs in SEARCH mode. The root serves no toolset, so this is where
 * its pins live; an agent's own pins follow them.
 */
export interface McpHostConfig {
  readonly mcpPublicUrl: string;
  readonly webAppUrl: string;
  /** Optional so hand-built configs in tests stay valid; absent is none. */
  readonly rootPinnedTools?: readonly string[];
}

/** Pinned tools per toolset, per agent and on the root (design spec §7.13). */
export const MAX_PINNED_TOOLS = 5;
const PINNED_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;

export const MCP_HOST_CONFIG = 'MCP_HOST_CONFIG';

export const PRODUCTION_MCP_PUBLIC_URL = 'https://mcp.assay.ai';
const LOCAL_MCP_PUBLIC_URL = 'http://localhost:3200';
const LOCAL_WEB_APP_URL = 'http://localhost:4000';

export function loadMcpHostConfig(env: NodeJS.ProcessEnv = process.env): McpHostConfig {
  const production = env.NODE_ENV === 'production';
  const mcpPublicUrl = origin(
    'MCP_PUBLIC_URL',
    env.MCP_PUBLIC_URL,
    production ? PRODUCTION_MCP_PUBLIC_URL : LOCAL_MCP_PUBLIC_URL,
  );
  const web = env.WEB_APP_URL?.trim();
  if (production && !web) {
    throw new Error(
      'WEB_APP_URL must be set when NODE_ENV=production: the web app a browser opening an ' +
        'MCP URL is redirected to, e.g. https://app.example.com',
    );
  }
  return {
    mcpPublicUrl,
    webAppUrl: origin('WEB_APP_URL', web, LOCAL_WEB_APP_URL),
    rootPinnedTools: pinnedList(env.MCP_ROOT_PINNED_TOOLS),
  };
}

function pinnedList(raw: string | undefined): string[] {
  const names = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];
  const bad = names.find((name) => !PINNED_NAME_RE.test(name));
  if (bad) throw new Error(`MCP_ROOT_PINNED_TOOLS: "${bad}" is not a tool name`);
  if (names.length > MAX_PINNED_TOOLS) {
    throw new Error(
      `MCP_ROOT_PINNED_TOOLS names ${names.length} tools; at most ${MAX_PINNED_TOOLS}`,
    );
  }
  return names;
}

function origin(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: "${value}"`);
  }
  if (parsed.origin !== value.replace(/\/$/, '')) {
    throw new Error(`${name} must be a bare origin like "${parsed.origin}", got "${value}"`);
  }
  return parsed.origin;
}
