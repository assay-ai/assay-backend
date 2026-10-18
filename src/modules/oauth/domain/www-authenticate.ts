import { protectedResourceMetadataUrl } from './metadata';
import { SCOPE_AGENT } from './scope';

/**
 * The `WWW-Authenticate` header on every `MCP_CREDENTIAL_INVALID` 401 from the
 * MCP catch-all (spec §6.3.3, R-OA-3):
 *
 * ```text
 * Bearer resource_metadata="{MCP}/.well-known/oauth-protected-resource{path}", scope="assay:agent"
 * ```
 *
 * with `, error="invalid_token"` appended when a token was presented.
 * `offline_access` never appears. The path is percent-encoded by
 * `resourcePath`, so it cannot close the quoted string or add a line.
 */
export function challengeHeader(mcp: string, requestPath: string, tokenPresented: boolean): string {
  const header = `Bearer resource_metadata="${protectedResourceMetadataUrl(mcp, requestPath)}", scope="${SCOPE_AGENT}"`;
  return tokenPresented ? `${header}, error="invalid_token"` : header;
}
