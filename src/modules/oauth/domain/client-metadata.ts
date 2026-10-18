import { claimsTrust, sanitise } from './client-name';
import { RedirectAllowlistEntry, registrable } from './redirect-uri';

/**
 * Client metadata, as a CIMD document (§6.3.7) or a DCR body (§6.3.8) states
 * it, checked against the same rules. Only the known members below are kept;
 * any other member is ignored and never stored.
 *
 * ```text
 * redirect_uris               1–10 strings, each registrable under §6.3.9
 * client_name                 1–64 code points after sanitising (never truncated)
 * token_endpoint_auth_method  absent or "none": public clients only
 * client_secret*              any such member refuses the whole document
 * grant_types                 when present, includes "authorization_code"
 * response_types              when present, includes "code"
 * client_uri                  when present, an http(s) URL ≤ 512 chars, shown as text
 * scope, software_id,
 * software_version            when present, strings ≤ 255 chars
 * ```
 */
export const KNOWN_CLIENT_METADATA_MEMBERS = Object.freeze([
  'client_id',
  'client_name',
  'client_uri',
  'redirect_uris',
  'grant_types',
  'response_types',
  'token_endpoint_auth_method',
  'scope',
  'software_id',
  'software_version',
] as const);

export const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_URI_LENGTH = 512;
const MAX_SHORT_STRING = 255;
const MAX_LIST_ITEMS = 10;

/** The grants this AS issues; a client's `grant_types` is narrowed to these. */
export const SUPPORTED_GRANT_TYPES = Object.freeze(['authorization_code', 'refresh_token']);

export type ClientMetadataError = 'invalid_redirect_uri' | 'invalid_client_metadata';

export interface ValidClientMetadata {
  readonly clientName: string;
  readonly clientUri: string | null;
  readonly redirectUris: string[];
  readonly grantTypes: string[];
  readonly responseTypes: string[];
  /** The known members only, as they will be stored in `oauth_clients.metadata`. */
  readonly metadata: Record<string, unknown>;
}

export type ClientMetadataResult =
  | { readonly ok: true; readonly value: ValidClientMetadata }
  | { readonly ok: false; readonly error: ClientMetadataError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_ITEMS &&
    value.every((item) => typeof item === 'string')
  );
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SHORT_STRING;
}

function validClientUri(value: string): boolean {
  if (value.length > MAX_CLIENT_URI_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username;
  } catch {
    return false;
  }
}

/**
 * Check `document` against the rules above. `allowlist` is
 * `OAUTH_REDIRECT_ALLOWLIST` (entries under review never pass).
 */
export function validateClientMetadata(
  document: unknown,
  allowlist: readonly RedirectAllowlistEntry[],
): ClientMetadataResult {
  const invalid = { ok: false, error: 'invalid_client_metadata' } as const;
  if (!isPlainObject(document)) return invalid;

  // A confidential client is refused outright, whatever else it says (Q2).
  if (Object.keys(document).some((key) => key.startsWith('client_secret'))) return invalid;
  const authMethod = document.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') return invalid;

  const redirectUris = document.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length < 1 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every((uri) => typeof uri === 'string' && registrable(uri, allowlist))
  ) {
    return { ok: false, error: 'invalid_redirect_uri' };
  }

  const clientName = sanitise(document.client_name);
  // A name that claims trust ("Verified", the built-in app's header words, a
  // check mark) is refused, not shown (§6.3.6, R-OA-25).
  if (clientName === null || claimsTrust(clientName)) return invalid;

  const { grant_types: grantTypes, response_types: responseTypes } = document;
  if (grantTypes !== undefined) {
    if (!isStringList(grantTypes) || !grantTypes.includes('authorization_code')) return invalid;
  }
  if (responseTypes !== undefined) {
    if (!isStringList(responseTypes) || !responseTypes.includes('code')) return invalid;
  }

  const clientUri = document.client_uri;
  if (clientUri !== undefined && (typeof clientUri !== 'string' || !validClientUri(clientUri))) {
    return invalid;
  }
  for (const member of ['scope', 'software_id', 'software_version'] as const) {
    if (document[member] !== undefined && !isShortString(document[member])) return invalid;
  }

  const grants = ((grantTypes as string[] | undefined) ?? [...SUPPORTED_GRANT_TYPES]).filter(
    (grant) => SUPPORTED_GRANT_TYPES.includes(grant),
  );
  const metadata: Record<string, unknown> = {};
  for (const member of KNOWN_CLIENT_METADATA_MEMBERS) {
    if (document[member] !== undefined) metadata[member] = document[member];
  }
  metadata.client_name = clientName;
  metadata.redirect_uris = [...new Set(redirectUris as string[])];
  metadata.grant_types = [...new Set(grants)];
  metadata.response_types = ['code'];
  metadata.token_endpoint_auth_method = 'none';

  return {
    ok: true,
    value: {
      clientName,
      clientUri: (clientUri as string | undefined) ?? null,
      redirectUris: metadata.redirect_uris as string[],
      grantTypes: metadata.grant_types as string[],
      responseTypes: ['code'],
      metadata,
    },
  };
}
