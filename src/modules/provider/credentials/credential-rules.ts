import { RequestMappingSpec } from '@modules/tool/domain/mapping/mapping.types';
import { isConstNode } from '@modules/tool/domain/mapping/normalize';

import { RELAY_ALLOWED_PORTS } from '@shared/network/egress/egress-relay.config';

import { ProviderErrors } from '../errors/provider.errors';
import { CredentialHeader } from './credential-vault.crypto';

/**
 * Pure validation rules for provider credentials and for what a mapping may
 * carry. Kept free of Nest so the editor and the vault service share one
 * definition.
 */

const MAX_HEADERS = 10;
const MAX_NAME_CHARS = 64;
const MAX_VALUE_BYTES = 4096;

/** RFC 9110 token. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Printable ASCII plus HTAB: no CR, LF, NUL or other control characters. */
const VALUE_RE = /^[\x20-\x7E\t]*$/;

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'signature',
  'signature-input',
  'content-digest',
]);

/** Compared after lowercasing and `-` to `_`. */
const CREDENTIAL_QUERY_KEYS: ReadonlySet<string> = new Set([
  'key',
  'api_key',
  'apikey',
  'token',
  'access_token',
  'auth_token',
  'secret',
  'client_secret',
  'password',
  'auth',
  'signature',
  'sig',
]);

const SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
]);

/** Human-readable problems with a credential header set; `[]` when valid. */
export function credentialHeaderProblems(headers: readonly CredentialHeader[]): string[] {
  const problems: string[] = [];
  if (headers.length === 0) {
    problems.push('At least one header is required (use DELETE to remove the set)');
  }
  if (headers.length > MAX_HEADERS) {
    problems.push(`At most ${MAX_HEADERS} headers per set`);
  }
  const seen = new Set<string>();
  for (const [index, { name, value }] of headers.entries()) {
    // An invalid name is identified by position, never echoed: a pasted secret
    // (`Authorization: Bearer ...`) must not come back in a response or a log.
    const label = `Header #${index + 1}`;
    const lower = name.toLowerCase();
    if (name.length === 0 || name.length > MAX_NAME_CHARS || !TOKEN_RE.test(name)) {
      problems.push(`${label}: invalid name`);
    } else if (RESERVED_NAMES.has(lower) || lower.startsWith('x-assay-')) {
      problems.push(`Reserved header name: ${name}`);
    }
    const valid = !(name.length === 0 || name.length > MAX_NAME_CHARS || !TOKEN_RE.test(name));
    const shown = valid ? `Header ${name}` : label;
    if (seen.has(lower)) problems.push(`Duplicate header name: ${valid ? name : label}`);
    seen.add(lower);
    if (!VALUE_RE.test(value)) {
      problems.push(`${shown}: value must be printable ASCII (no CR, LF or NUL)`);
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      problems.push(`${shown}: value exceeds ${MAX_VALUE_BYTES} bytes`);
    }
  }
  return problems;
}

function isCredentialQueryKey(key: string): boolean {
  return CREDENTIAL_QUERY_KEYS.has(key.toLowerCase().replace(/-/g, '_'));
}

/** Credential-like query keys in the endpoint URL or constant mapping query entries, as written. */
export function credentialQueryKeys(endpoint: string, mapping: RequestMappingSpec): string[] {
  const found: string[] = [];
  let params: URLSearchParams | null = null;
  try {
    params = new URL(endpoint).searchParams;
  } catch {
    params = null;
  }
  if (params) {
    for (const key of params.keys()) if (isCredentialQueryKey(key)) found.push(key);
  }
  for (const [key, node] of Object.entries(mapping.query ?? {})) {
    if (isConstNode(node) && isCredentialQueryKey(key)) found.push(key);
  }
  return [...new Set(found)];
}

/** Secret-looking header names set to a constant in the mapping, as written. */
export function secretConstantHeaders(mapping: RequestMappingSpec): string[] {
  return Object.entries(mapping.headers ?? {})
    .filter(([name, node]) => isConstNode(node) && SECRET_HEADER_NAMES.has(name.toLowerCase()))
    .map(([name]) => name);
}

/** Scheme + host + port, default port omitted, host lowercased. */
export function originOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * Throws unless `origin` is the draft endpoint's or the published revision's,
 * and the headers pass `credentialHeaderProblems`.
 */
export function assertCredentialPut(
  draftEndpoint: string,
  publishedEndpoint: string | null,
  origin: string,
  headers: readonly CredentialHeader[],
): void {
  const allowed = [originOf(draftEndpoint)];
  if (publishedEndpoint) allowed.push(originOf(publishedEndpoint));
  if (!allowed.includes(origin)) {
    throw ProviderErrors.credentialOriginMismatch();
  }
  const problems = credentialHeaderProblems(headers);
  if (problems.length > 0) {
    throw ProviderErrors.invalidCredentialHeaders({ problems });
  }
}

/**
 * The explicit port of `endpoint` when the egress relay cannot reach it, else
 * null. Only meaningful when the relay is configured: with provider calls
 * going direct, every port is fine. Unparsable input is left to the other
 * validators.
 */
export function relayUnsupportedPort(endpoint: string, relayConfigured: boolean): number | null {
  if (!relayConfigured) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (!url.port) return null;
  const port = Number(url.port);
  return RELAY_ALLOWED_PORTS.includes(port) ? null : port;
}
