/**
 * Discovery documents (spec §6.3.1, §6.3.2; R-OA-1, R-OA-2).
 *
 * The PRM `resource` is `{MCP}` plus the path after the well-known prefix
 * (no query, no fragment), or `{MCP}` for the bare form. The 401 challenge
 * (`www-authenticate.ts`) points at the same path through
 * {@link protectedResourceMetadataUrl}, so the two always agree (RFC 9728 §3.3).
 */
export const PRM_WELL_KNOWN = '/.well-known/oauth-protected-resource';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  client_id_metadata_document_supported: boolean;
  authorization_response_iss_parameter_supported: boolean;
  service_documentation: string;
}

/** Characters kept as they are in a path; everything else is percent-encoded. */
const PATH_SAFE_RE = /[A-Za-z0-9\-._~!$&'()*+,;=:@/%]/;

/**
 * The resource path for a request path: query and fragment dropped, `/` and
 * empty mapped to the bare form (`''`), anything a URL cannot hold literally
 * (quotes, backslashes, spaces, controls, non-ASCII) percent-encoded, so the
 * result is safe inside JSON and inside a header's quoted string.
 */
export function resourcePath(requestPath: string | null | undefined): string {
  const raw = (typeof requestPath === 'string' ? requestPath : '').split(/[?#]/, 1)[0];
  let path = '';
  for (const char of raw) {
    path += PATH_SAFE_RE.test(char)
      ? char
      : Array.from(
          Buffer.from(char, 'utf8'),
          (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`,
        ).join('');
  }
  if (path !== '' && !path.startsWith('/')) path = `/${path}`;
  return path === '/' ? '' : path;
}

export function protectedResourceMetadataUrl(mcp: string, requestPath: string): string {
  return `${mcp}${PRM_WELL_KNOWN}${resourcePath(requestPath)}`;
}

export function protectedResourceMetadata(
  mcp: string,
  web: string,
  path: string | null | undefined,
): ProtectedResourceMetadata {
  return {
    resource: `${mcp}${resourcePath(path)}`,
    authorization_servers: [mcp],
    scopes_supported: ['assay:agent'],
    bearer_methods_supported: ['header'],
    resource_name: 'Assay',
    resource_documentation: `${web}/docs/mcp`,
  };
}

export function authorizationServerMetadata(mcp: string, web: string): AuthorizationServerMetadata {
  return {
    issuer: mcp,
    authorization_endpoint: `${mcp}/oauth/authorize`,
    token_endpoint: `${mcp}/oauth/token`,
    registration_endpoint: `${mcp}/oauth/register`,
    revocation_endpoint: `${mcp}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['assay:agent', 'offline_access'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${web}/docs/mcp`,
  };
}
