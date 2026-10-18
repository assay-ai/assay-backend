/**
 * OAuth TTLs and limits (spec §6.3.14). Every number the OAuth code uses for a
 * lifetime or a cap is named here, so the spec table and the code can be read
 * side by side.
 */

/** A pending authorization request, its tombstone, and its browser cookie. */
export const OAUTH_PENDING_REQUEST_TTL_SECONDS = 600;

/** An authorization code: 60 s, and one exchange (R-OA-6). */
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** An access token (R-OA-11). */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;

/**
 * A refresh token: 30 days from its own issue (R-OA-12). The credential's
 * `expires_at` follows its newest live refresh token; there is no absolute
 * lifetime (Q3).
 */
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** How long a rotated refresh token may be replayed for the same pair (§6.3.11). */
export const OAUTH_REFRESH_GRACE_SECONDS = 30;

/** CIMD document cache: `max-age` is clamped to [min, max]; absent, the default. */
export const OAUTH_CIMD_CACHE_MIN_SECONDS = 300;
export const OAUTH_CIMD_CACHE_MAX_SECONDS = 86_400;
export const OAUTH_CIMD_CACHE_DEFAULT_SECONDS = 3600;
/** A failed CIMD fetch is remembered this long. */
export const OAUTH_CIMD_FAILURE_CACHE_SECONDS = 60;

/** Live OAuth credentials per agent; idle-dead grants are not live (R-OA-31). */
export const OAUTH_MAX_LIVE_GRANTS_PER_AGENT = 50;
/** The consent page warns from this many live grants on (R-OA-31). */
export const OAUTH_LIVE_GRANTS_WARN_AT = 45;

/** The built-in `assay-mcp` client's path under `{MCP}` (§6.3.6 item 3). */
export const OAUTH_BUILTIN_CLIENT_PATH = '/oauth/clients/assay-mcp';
