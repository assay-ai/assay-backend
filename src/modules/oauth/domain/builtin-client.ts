import { builtinClientId } from './client-id';

/**
 * The built-in `assay-mcp` client (spec §6.3.6 item 3). The AS resolves it in
 * process; the same document is served at its `client_id` URL for clients
 * that fetch it. Key order is the spec's, so the served JSON is stable.
 */
export const BUILTIN_CLIENT_NAME = 'Assay app (assay-mcp)';
export const BUILTIN_CLIENT_REDIRECT_URIS: readonly string[] = Object.freeze([
  'http://127.0.0.1/callback',
]);

export interface BuiltinClientDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  grant_types: string[];
  response_types: string[];
}

export function builtinClientDocument(mcpPublicUrl: string): BuiltinClientDocument {
  return {
    client_id: builtinClientId(mcpPublicUrl),
    client_name: BUILTIN_CLIENT_NAME,
    redirect_uris: [...BUILTIN_CLIENT_REDIRECT_URIS],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}
