/**
 * The request property `SessionAuthGuard` attaches the resolved session to.
 *
 * In its own file, importing nothing, because two very different things need to
 * agree on it: the guard that *writes* it, and `HttpCacheInterceptor`, which
 * must *read* it to key a cache entry to a tenant. Having the interceptor import
 * the guard would drag the MCP session port into a globally-registered
 * interceptor for the sake of one string constant.
 *
 * They agreeing is load-bearing, not cosmetic — see
 * `readCacheTenant` below.
 */
export const SESSION_REQUEST_KEY = 'session' as const;

/**
 * The tenant a cached response belongs to, or `null` if it cannot be determined.
 *
 * ## Why this exists
 *
 * `HttpCacheInterceptor` used to derive its cache key from `request.user`, the
 * convention of the starter's JWT guard. Nothing on this REST surface sets
 * `request.user` — `SessionAuthGuard` sets `request.session` — so the user
 * component of every cache key was `null`, and the key reduced to
 * `path + query`. Two organizations requesting the same resource id therefore
 * shared one cache entry, and the second one to ask received the first one's
 * body: a `200` with another tenant's verdict, receipt or tool call, for the
 * TTL's duration.
 *
 * That is the single worst failure this platform can have, and it was invisible
 * to every unit test, because it only appears when two tenants request the same
 * URL within the TTL.
 *
 * ## Fail closed
 *
 * Returning `null` means *"do not cache this"*, never *"cache it under the
 * shared key"*. The distinction is the whole fix. A request that carries
 * credentials but whose tenant cannot be read is exactly the case where a
 * shared key is most dangerous, so it must be the case where caching is
 * refused.
 */
export function readCacheTenant(request: unknown): string | null {
  const session = (request as Record<string, unknown> | null)?.[SESSION_REQUEST_KEY] as
    | { organizationId?: unknown; agentId?: unknown }
    | undefined;

  const organizationId = session?.organizationId;
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    return null;
  }

  /**
   * Keyed by organization **and** agent.
   *
   * The tenant boundary only needs the organization, but two agents in one
   * organization can legitimately see different answers — `/spend-policy`
   * resolves the calling agent's override before the organization default, and
   * `/balances` is charged per agent account. Keying on the organization alone
   * would serve one agent's limits to another inside the same tenant: not a
   * cross-tenant breach, but still a wrong answer presented as a right one.
   */
  const agentId = session?.agentId;
  return typeof agentId === 'string' && agentId.length > 0
    ? `${organizationId}:${agentId}`
    : organizationId;
}

/**
 * Whether the request presented credentials.
 *
 * Used to decide whether an unresolvable tenant is "public endpoint, safe to
 * share" or "authenticated request we failed to attribute, refuse to cache".
 */
export function isCredentialed(request: unknown): boolean {
  const headers = (request as { headers?: Record<string, unknown> } | null)?.headers;
  return typeof headers?.authorization === 'string' && headers.authorization.length > 0;
}
