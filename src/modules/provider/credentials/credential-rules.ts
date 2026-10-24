import { BindingAuthMode, BindingStatus } from '@modules/tool/ports/tool.types';
import { RequestMappingSpec } from '@modules/tool/domain/mapping/mapping.types';
import { isConstNode } from '@modules/tool/domain/mapping/normalize';

import { RELAY_ALLOWED_PORTS, isDeniedHost, isIpLiteralHost } from '@shared/network/egress';

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

/**
 * Words that make a constant header name or query key look like a secret. A
 * name is flagged when one of its tokens (split on `-` and `_`) equals or ends
 * with a word, so `x-api-key`, `apikey`, `subscription-key` and
 * `ocp-apim-subscription-key` all match `key`.
 */
const SECRET_WORDS: readonly string[] = [
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
  'credential',
  'signature',
  'session',
  'cookie',
];

/** Short words that count only as a whole token (`sig`, not `config`). */
const SECRET_WHOLE_TOKENS: ReadonlySet<string> = new Set(['sig']);

/**
 * Names that contain a secret word and are not secrets. Compared lowercased with
 * `_` read as `-`. Exported so the frontend rule can mirror it.
 */
export const SECRET_NAME_ALLOW_LIST: readonly string[] = [
  'idempotency-key',
  'x-idempotency-key',
  'sort-key',
  'x-sort-key',
  'cache-key',
  'x-cache-key',
  'max-tokens',
  'keyword',
  'keywords',
];

/**
 * Whether a constant header name or query key looks like it carries a secret.
 * Applied to constants only: body fields are not checked.
 */
export function looksLikeSecretName(name: string): boolean {
  const normalised = name.toLowerCase().replace(/_/g, '-');
  if (SECRET_NAME_ALLOW_LIST.includes(normalised)) return false;
  return normalised
    .split('-')
    .filter((token) => token.length > 0)
    .some(
      (token) =>
        SECRET_WHOLE_TOKENS.has(token) || SECRET_WORDS.some((word) => token.endsWith(word)),
    );
}

/**
 * The cap on all outbound request headers together: defaults, mapping,
 * credentials and Assay's own (call id, digest, signature). 8 KiB is the
 * smallest default request-header limit among common servers and proxies
 * (Apache, nginx's default buffer, many CDNs), so a request above it would be
 * refused by the provider's edge with an error that looks like theirs.
 */
export const MAX_OUTBOUND_HEADER_BYTES = 8 * 1024;

/**
 * What Assay's own headers may take at Save time, when they do not exist yet:
 * `accept`, `content-type`, `x-assay-call-id`, `content-digest`,
 * `signature-input` and `signature` come to about 500 bytes on the wire.
 */
export const ASSAY_HEADER_RESERVE_BYTES = 1024;

/** Bytes of `headers` as written on the wire: `name: value\r\n` each. */
export function headerBytes(headers: Iterable<readonly [string, string]>): number {
  let total = 0;
  for (const [name, value] of headers) {
    total += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 4;
  }
  return total;
}

/** Whether a header name is in the platform's `x-assay-` namespace. */
export function isAssayHeaderName(name: string): boolean {
  return name.toLowerCase().startsWith('x-assay-');
}

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
    } else if (RESERVED_NAMES.has(lower) || isAssayHeaderName(lower)) {
      problems.push(`Reserved header name: ${name}`);
    }
    const valid = !(name.length === 0 || name.length > MAX_NAME_CHARS || !TOKEN_RE.test(name));
    const shown = valid ? `Header ${name}` : label;
    if (seen.has(lower)) problems.push(`Duplicate header name: ${valid ? name : label}`);
    seen.add(lower);
    if (value.length === 0) {
      problems.push(`${shown}: value is empty`);
    } else if (!VALUE_RE.test(value)) {
      problems.push(`${shown}: value must be printable ASCII (no CR, LF or NUL)`);
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      problems.push(`${shown}: value exceeds ${MAX_VALUE_BYTES} bytes`);
    }
  }
  return problems;
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
    for (const key of params.keys()) if (looksLikeSecretName(key)) found.push(key);
  }
  for (const [key, node] of Object.entries(mapping.query ?? {})) {
    if (isConstNode(node) && looksLikeSecretName(key)) found.push(key);
  }
  return [...new Set(found)];
}

/** Secret-looking header names set to a constant in the mapping, as written. */
export function secretConstantHeaders(mapping: RequestMappingSpec): string[] {
  return Object.entries(mapping.headers ?? {})
    .filter(([name, node]) => isConstNode(node) && looksLikeSecretName(name))
    .map(([name]) => name);
}

/** Mapping header names in the platform's `x-assay-` namespace, as written, whatever their node. */
export function assayMappingHeaders(mapping: RequestMappingSpec): string[] {
  return Object.keys(mapping.headers ?? {}).filter(isAssayHeaderName);
}

/**
 * The mapping's constant headers (the only ones known before a call), as the
 * invoker would send them: a non-string constant is sent as its JSON text.
 */
function constantHeaders(mapping: RequestMappingSpec): Array<[string, string]> {
  return Object.entries(mapping.headers ?? {}).flatMap(([name, node]) => {
    if (!isConstNode(node)) return [];
    const value = node.$const;
    return [[name, typeof value === 'string' ? value : JSON.stringify(value)] as [string, string]];
  });
}

/** Scheme + host + port, default port omitted, host lowercased. */
export function originOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * Throws unless `origin` is the draft endpoint's or the published revision's,
 * the headers pass `credentialHeaderProblems`, and together with the draft
 * mapping's constant headers and {@link ASSAY_HEADER_RESERVE_BYTES} they fit
 * {@link MAX_OUTBOUND_HEADER_BYTES}. (Mapping headers derived from the input are
 * only known per call; the invoker enforces the cap again there.)
 */
export function assertCredentialPut(
  draftEndpoint: string,
  publishedEndpoint: string | null,
  origin: string,
  headers: readonly CredentialHeader[],
  mapping: RequestMappingSpec,
): void {
  const allowed = [originOf(draftEndpoint)];
  if (publishedEndpoint) allowed.push(originOf(publishedEndpoint));
  if (!allowed.includes(origin)) {
    throw ProviderErrors.credentialOriginMismatch();
  }
  const problems = credentialHeaderProblems(headers);
  const total =
    headerBytes(constantHeaders(mapping)) +
    headerBytes(headers.map(({ name, value }) => [name, value] as const)) +
    ASSAY_HEADER_RESERVE_BYTES;
  if (total > MAX_OUTBOUND_HEADER_BYTES) {
    problems.push(
      `Headers too large: the mapping's constant headers and these credentials need ` +
        `${total} bytes with Assay's own headers; the limit is ${MAX_OUTBOUND_HEADER_BYTES}`,
    );
  }
  if (problems.length > 0) {
    throw ProviderErrors.invalidCredentialHeaders({ problems });
  }
}

/** Whether calls under `authMode` need a credential set for the endpoint's origin. */
export function authModeNeedsKey(authMode: string | null | undefined): boolean {
  return authMode === BindingAuthMode.API_KEY || authMode === BindingAuthMode.BOTH;
}

/**
 * Throws `credentialOriginLive` when the set to remove is for the origin of the
 * published endpoint and the binding can go live on it: it is ACTIVE, or it is
 * published (ACTIVE or PAUSED) under an auth mode that needs a key. Deleting it
 * from a paused API-key binding would only defer the fault: the resume would
 * turn every call into a platform fault. Publish an endpoint elsewhere (which
 * prunes it), or switch the auth mode, before removing it.
 */
export function assertCredentialRemovable(
  binding: { status: string; publishedVersion: number | null; authMode: string },
  publishedEndpoint: string | null,
  origin: string,
): void {
  const live =
    binding.status === BindingStatus.ACTIVE ||
    (binding.publishedVersion != null && authModeNeedsKey(binding.authMode));
  if (live && publishedEndpoint && originOf(publishedEndpoint) === origin) {
    throw ProviderErrors.credentialOriginLive();
  }
}

/**
 * Throws when `endpoint` names one of Assay's own hosts (`isDeniedHost`), with
 * or without the relay: the egress client refuses those on every hop, and Save
 * says so first. Then, when the egress relay is configured, throws when it
 * could not carry a call to `endpoint` — the same rules as the relay
 * transport's pre-check (`egress-relay.transport.ts`), applied at Save so a
 * provider learns now rather than on every call: `https:` only, a host name
 * rather than an IP literal, and a port Cloudflare proxies. Unparsable input is
 * left to the other validators.
 */
export function assertRelayableEndpoint(endpoint: string, relayConfigured: boolean): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  if (isDeniedHost(url.hostname)) throw ProviderErrors.endpointHostNotAllowed();
  if (!relayConfigured) return;
  if (url.protocol !== 'https:') {
    throw ProviderErrors.endpointNotRelayable({ reason: 'use https' });
  }
  if (isIpLiteralHost(url.hostname)) {
    throw ProviderErrors.endpointNotRelayable({ reason: 'use a host name, not an IP address' });
  }
  const port = relayUnsupportedPort(endpoint, relayConfigured);
  if (port !== null) throw ProviderErrors.endpointPortNotRelayable({ port });
}

/**
 * The relay refuses a request carrying more headers than this
 * (`MAX_HEADERS` in `workers/egress-relay/src/relay.ts`; keep the two equal).
 */
export const RELAY_MAX_HEADERS = 64;

/**
 * Headers Assay adds to every call on top of the mapping's: `accept`,
 * `content-type`, `x-assay-call-id`, `content-digest`, `signature-input`,
 * `signature`, and up to {@link MAX_HEADERS} credential headers.
 */
export const ASSAY_HEADER_COUNT_RESERVE = 6 + MAX_HEADERS;

/**
 * The most headers a request mapping may declare (constant and input-derived
 * alike): {@link RELAY_MAX_HEADERS} less {@link ASSAY_HEADER_COUNT_RESERVE} is
 * 48; 8 more are held back as margin for headers Assay may add later.
 */
export const MAX_MAPPING_HEADERS = RELAY_MAX_HEADERS - ASSAY_HEADER_COUNT_RESERVE - 8;

/** The number of headers `mapping` declares. */
export function mappingHeaderCount(mapping: RequestMappingSpec): number {
  return Object.keys(mapping.headers ?? {}).length;
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
