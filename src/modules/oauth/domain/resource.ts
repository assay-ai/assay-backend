/**
 * The RFC 8707 `resource` parameter (spec §6.3.4, §6.3.13, R-OA-16).
 *
 * ```text
 * missing                      → {MCP}
 * same origin as {MCP}, any path or query → {MCP}
 * anything else                → invalid_target
 * ```
 *
 * The audience is always `{MCP}`: one grant serves every MCP URL kind, so a
 * path never narrows it. A fragment or userinfo is refused (RFC 8707 §2), as
 * is any raw string a URL parser would have to repair (whitespace, `\`).
 */
export type ResourceResult =
  | { readonly ok: true; readonly resource: string }
  | { readonly ok: false; readonly error: 'invalid_target' };

const INVALID: ResourceResult = { ok: false, error: 'invalid_target' };

export function normaliseResource(
  raw: string | null | undefined,
  mcpPublicUrl: string,
): ResourceResult {
  if (raw === undefined || raw === null) return { ok: true, resource: mcpPublicUrl };
  if (typeof raw !== 'string') return INVALID;
  if (raw.includes('#') || raw.includes('\\') || /[\s\p{Cc}]/u.test(raw)) {
    return INVALID;
  }
  let url: URL;
  let mcp: URL;
  try {
    url = new URL(raw);
    mcp = new URL(mcpPublicUrl);
  } catch {
    return INVALID;
  }
  if (url.username !== '' || url.password !== '' || url.origin !== mcp.origin) return INVALID;
  return { ok: true, resource: mcpPublicUrl };
}
