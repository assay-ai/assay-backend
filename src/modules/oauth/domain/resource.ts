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
 * path never narrows it. A fragment or userinfo is refused (RFC 8707 §2).
 *
 * The origin must be spelled exactly as `MCP_PUBLIC_URL` (same case, no
 * explicit default port), followed by nothing, `/` or `?`, in printable ASCII
 * only: nothing a URL parser would have to repair (`https:mcp…`, `HTTPS://`,
 * fullwidth letters, soft hyphens, whitespace, `\`) is accepted.
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
  if (typeof mcpPublicUrl !== 'string') return INVALID;
  if (raw.includes('#') || raw.includes('\\') || !/^[\x21-\x7e]+$/.test(raw)) return INVALID;
  const rest = raw.startsWith(mcpPublicUrl) ? raw.slice(mcpPublicUrl.length) : null;
  if (rest === null || !(rest === '' || rest.startsWith('/') || rest.startsWith('?'))) {
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
