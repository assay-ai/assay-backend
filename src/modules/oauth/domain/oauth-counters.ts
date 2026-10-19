import type { McpUnauthorizedReason } from '@modules/mcp/ports/mcp-unauthorized.port';

/**
 * The OAuth request-path counters (spec §6.7) and their Redis keys.
 *
 * Facts the database already holds (live grants, grants stopped for reuse,
 * refresh grace uses, DCR registrations, CIMD clients) are read from it by the
 * operator dashboard. What exists only on the request path is counted here:
 * `OAuthMetrics` writes, the dashboard's `OAuthSignalsReader` reads.
 *
 * Key: `oauth:m:{name}:{label}:{yyyymmddhh}`, one bucket per UTC hour, kept
 * {@link OAUTH_COUNTER_TTL_MS}. Hourly rather than daily so the 1 h alert of
 * `continue_cookie_missing` has a window to read; the dashboard sums the last
 * 24 buckets for its daily figures.
 *
 * Every label comes from the fixed allow-lists below. No request value, id or
 * token ever becomes part of a key: a value outside its list is not counted.
 */

/** `authorize{outcome}`. */
export const OAUTH_AUTHORIZE_OUTCOMES = [
  'stored',
  'client_unknown',
  'client_metadata_invalid',
  'redirect_uri_mismatch',
  'invalid_request',
  'invalid_target',
  'rate_limited',
] as const;
export type OAuthAuthorizeOutcome = (typeof OAUTH_AUTHORIZE_OUTCOMES)[number];

/**
 * `consent{step}`. `not_found` counts a read of a request that is unknown,
 * expired or another organization's: the three are one answer by design
 * (§6.3.5), so the counter cannot tell expiry apart either.
 */
export const OAUTH_CONSENT_STEPS = [
  'shown',
  'approved',
  'denied',
  'not_found',
  'continue_cookie_missing',
] as const;
export type OAuthConsentStep = (typeof OAUTH_CONSENT_STEPS)[number];

/**
 * `token{grant_type}`. Anything other than the two supported grants is
 * counted as `other`, so a client cannot mint label values.
 */
export const OAUTH_TOKEN_GRANT_TYPES = ['authorization_code', 'refresh_token', 'other'] as const;
export type OAuthTokenGrantType = (typeof OAUTH_TOKEN_GRANT_TYPES)[number];

/**
 * `token{result}`: `ok`, the RFC 6749 §5.2 / RFC 8707 error code,
 * `rate_limited` for the 429 of §6.3.10, or `server_error` for an unexpected
 * failure (the controller answered 500).
 */
export const OAUTH_TOKEN_RESULTS = [
  'ok',
  'rate_limited',
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'invalid_target',
  'temporarily_unavailable',
  'server_error',
] as const;
export type OAuthTokenResult = (typeof OAUTH_TOKEN_RESULTS)[number];

/** `cimd_fetch{result}` (§6.3.7). */
export const OAUTH_CIMD_FETCH_RESULTS = [
  'ok',
  'timeout',
  'too_large',
  'status',
  'invalid',
  'blocked_address',
  'budget',
] as const;
export type OAuthCimdFetchResult = (typeof OAUTH_CIMD_FETCH_RESULTS)[number];

/** `mcp_unauthorized{reason}`: the closed set the MCP port defines. */
export const MCP_UNAUTHORIZED_REASONS = [
  'missing',
  'unknown',
  'expired',
  'revoked',
  'audience',
] as const satisfies readonly McpUnauthorizedReason[];

// Every reason the port can carry is counted: adding one there without
// adding it here fails to compile.
type UncountedMcpReason = Exclude<McpUnauthorizedReason, (typeof MCP_UNAUTHORIZED_REASONS)[number]>;
const everyMcpReasonCounted: [UncountedMcpReason] extends [never] ? true : never = true;
void everyMcpReasonCounted;

/** The token counter's one label: `{grant_type}.{result}`. */
export const OAUTH_TOKEN_LABELS: readonly string[] = OAUTH_TOKEN_GRANT_TYPES.flatMap((grantType) =>
  OAUTH_TOKEN_RESULTS.map((result) => `${grantType}.${result}`),
);

/** Every counter and the labels it may carry. */
export const OAUTH_COUNTERS = {
  authorize: OAUTH_AUTHORIZE_OUTCOMES,
  consent: OAUTH_CONSENT_STEPS,
  token: OAUTH_TOKEN_LABELS,
  cimd_fetch: OAUTH_CIMD_FETCH_RESULTS,
  mcp_unauthorized: MCP_UNAUTHORIZED_REASONS,
} as const satisfies Record<string, readonly string[]>;

export type OAuthCounterName = keyof typeof OAUTH_COUNTERS;

const ALLOWED: Readonly<Record<OAuthCounterName, ReadonlySet<string>>> = {
  authorize: new Set(OAUTH_COUNTERS.authorize),
  consent: new Set(OAUTH_COUNTERS.consent),
  token: new Set(OAUTH_COUNTERS.token),
  cimd_fetch: new Set(OAUTH_COUNTERS.cimd_fetch),
  mcp_unauthorized: new Set(OAUTH_COUNTERS.mcp_unauthorized),
};

export function isAllowedOAuthCounterLabel(name: OAuthCounterName, label: string): boolean {
  return ALLOWED[name].has(label);
}

export const OAUTH_COUNTER_HOUR_MS = 60 * 60 * 1000;

/** About eight days: a week of hourly buckets stays readable with `redis-cli`. */
export const OAUTH_COUNTER_TTL_MS = 8 * 24 * OAUTH_COUNTER_HOUR_MS;

/** The UTC hour of `atMs` as `yyyymmddhh`. */
export function oauthCounterHour(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 13).replace(/[-T]/g, '');
}

export function oauthCounterKey(name: OAuthCounterName, label: string, atMs: number): string {
  return `oauth:m:${name}:${label}:${oauthCounterHour(atMs)}`;
}
