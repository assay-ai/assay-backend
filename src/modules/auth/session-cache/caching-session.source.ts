import type { McpSession, McpSessionPort } from '@modules/mcp/ports/mcp-session.port';

import { SessionCache } from './session-cache';

/** A resolved session, and how long it may be reused. */
export interface CacheableSession {
  readonly session: McpSession;
  /** The instant the credential it came from stops being valid; `null` for none. */
  readonly notAfter: Date | null;
  /** `false` to answer this request without keeping the session. */
  readonly cacheable?: boolean;
}

/** A session source that can say how long its answer holds. */
export interface CacheableSessionSource extends McpSessionPort {
  resolveForCache(bearerToken: string): Promise<CacheableSession>;
}

/**
 * Reuses a source's resolved session for up to 15 s (`SessionCache`).
 *
 * Wraps the API-key, OAuth and Privy sources one by one, inside
 * `BlocklistSessionSource`, so the blocklist is still checked on every
 * request and a block applies at once. The config source is not wrapped: it
 * is already in memory.
 *
 * Only a success is stored: a refusal is computed afresh every time, with the
 * same error and reason, so `CompositeMcpSessionSource` and the MCP bad-token
 * throttle see exactly what they saw before.
 *
 * `onHit` replays what a resolve does besides reading (the last-seen stamp),
 * so a cached request leaves the same trace as a resolved one.
 */
export class CachingSessionSource implements McpSessionPort {
  constructor(
    private readonly name: string,
    private readonly inner: McpSessionPort & Partial<CacheableSessionSource>,
    private readonly cache: SessionCache,
    private readonly onHit: (session: McpSession) => void = () => undefined,
  ) {}

  async resolve(bearerToken: string | null): Promise<McpSession> {
    // A source that cannot say how long its answer holds is never cached.
    if (!bearerToken || !this.inner.resolveForCache) return this.inner.resolve(bearerToken);

    const key = SessionCache.keyOf(this.name, bearerToken);
    const hit = this.cache.get(key);
    if (hit) {
      this.onHit(hit);
      return hit;
    }

    const generation = this.cache.generation;
    const resolved = await this.inner.resolveForCache(bearerToken);
    if (resolved.cacheable !== false) {
      this.cache.set(key, resolved.session, resolved.notAfter, generation);
    }
    return resolved.session;
  }
}
