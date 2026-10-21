import { createHash } from 'node:crypto';

import type { McpSession } from '@modules/mcp/ports/mcp-session.port';

/** How long a resolved session is reused, at most (owner sign-off: 15 s). */
export const SESSION_CACHE_TTL_MS = 15_000;

/** Bound on entries; the least recently used goes first. */
export const SESSION_CACHE_MAX_ENTRIES = 10_000;

/** What a cached session can be evicted by. */
export type SessionEvictionTarget =
  | { readonly organizationId: string }
  | { readonly credentialId: string }
  | { readonly all: true };

interface Entry {
  readonly session: McpSession;
  readonly expiresAt: number;
}

/**
 * The resolved sessions of this process, for {@link SESSION_CACHE_TTL_MS}.
 *
 * Keyed by the source and `sha256(token)`, never the token itself. Only
 * successes are stored (`CachingSessionSource`), so every refusal, and the
 * reason the MCP bad-token throttle counts, is computed as before.
 *
 * An entry never outlives what it was resolved from: its expiry is the
 * earliest of the TTL and the `notAfter` the source gives (a Privy JWT's
 * `exp`, an API key's or OAuth token's `expires_at`). A revocation, an access
 * epoch bump and the other writes a session depends on evict it here and, over
 * Redis pub/sub, in every other process (`SessionEvictions`); if that message
 * is lost, the TTL is the bound.
 *
 * `generation` is a ticket a resolve takes before it reads: it cannot store
 * its result if an eviction covering that session (its organization, its
 * credential, or everything) ran after the ticket, since it may have read the
 * row before the write that evicted. Tracked per organization and credential,
 * so an eviction in one organization does not stop caching in the others.
 */
export class SessionCache {
  private readonly entries = new Map<string, Entry>();
  private evictions = 0;
  /** The ticket of the last eviction of everything. */
  private evictedAll = 0;
  /** `o:<organizationId>` / `c:<credentialId>` → ticket and time of its last eviction. */
  private readonly evictedScopes = new Map<string, { ticket: number; at: number }>();
  /** Tickets below this may have lost their scope record to pruning: they never store. */
  private prunedThrough = 0;

  constructor(
    private readonly ttlMs: number = SESSION_CACHE_TTL_MS,
    private readonly maxEntries: number = SESSION_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  static keyOf(source: string, bearerToken: string): string {
    return `${source}:${createHash('sha256').update(bearerToken, 'utf8').digest('hex')}`;
  }

  get generation(): number {
    return this.evictions;
  }

  get size(): number {
    return this.entries.size;
  }

  /** A copy of the live session under `key`, or `undefined`. */
  get(key: string): McpSession | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Most recently used last, so the first key is the one to drop.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.session };
  }

  /**
   * Stores `session` unless an eviction ran since `generation` was read, or
   * it is already past `notAfter`.
   */
  set(key: string, session: McpSession, notAfter: Date | null, generation: number): void {
    if (this.evictedSince(session, generation)) return;
    const now = this.now();
    const expiresAt = Math.min(now + this.ttlMs, notAfter ? notAfter.getTime() : Infinity);
    if (expiresAt <= now) return;
    this.entries.delete(key);
    this.entries.set(key, { session: { ...session }, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  evict(target: SessionEvictionTarget): number {
    this.evictions += 1;
    if ('all' in target) {
      this.evictedAll = this.evictions;
      this.evictedScopes.clear();
      this.prunedThrough = 0;
      const count = this.entries.size;
      this.entries.clear();
      return count;
    }
    this.recordScope(
      'organizationId' in target ? `o:${target.organizationId}` : `c:${target.credentialId}`,
    );
    let count = 0;
    for (const [key, { session }] of this.entries) {
      const matches =
        'organizationId' in target
          ? session.organizationId === target.organizationId
          : session.credentialId === target.credentialId;
      if (matches) {
        this.entries.delete(key);
        count += 1;
      }
    }
    return count;
  }

  private evictedSince(session: McpSession, ticket: number): boolean {
    if (ticket < this.evictedAll || ticket < this.prunedThrough) return true;
    for (const scope of [`o:${session.organizationId}`, `c:${session.credentialId}`]) {
      const evicted = this.evictedScopes.get(scope);
      if (evicted && evicted.ticket > ticket) return true;
    }
    return false;
  }

  /**
   * Remembers when a scope was last evicted. Bounded: past `maxEntries`
   * scopes, records older than a minute (no resolve takes that long) are
   * dropped, and any ticket they could have refused refuses outright.
   */
  private recordScope(scope: string): void {
    const at = this.now();
    this.evictedScopes.delete(scope);
    this.evictedScopes.set(scope, { ticket: this.evictions, at });
    if (this.evictedScopes.size <= this.maxEntries) return;
    for (const [key, record] of this.evictedScopes) {
      if (record.at > at - SCOPE_RECORD_MS && this.evictedScopes.size <= this.maxEntries) break;
      this.evictedScopes.delete(key);
      this.prunedThrough = Math.max(this.prunedThrough, record.ticket);
    }
  }
}

/** How long an eviction's scope record must outlive any resolve in flight. */
const SCOPE_RECORD_MS = 60_000;
