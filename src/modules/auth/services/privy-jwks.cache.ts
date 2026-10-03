import { KeyObject, createPublicKey } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  EgressHttpClient,
  UNTRUSTED_EGRESS_POLICY,
  isEgressError,
  withLimits,
} from '@shared/network/egress';

import { PRIVY_AUTH_CONFIG, PrivyAuthConfig } from '../domain/privy-auth.config';
import { PrivyJwk } from '../domain/privy-claims';
import { AuthErrors } from '../errors/auth.errors';

/**
 * Privy's public signing keys, fetched once and cached.
 *
 * ## Why a cache is a correctness requirement, not an optimisation
 *
 * `SessionAuthGuard` runs on every authenticated request, including every MCP
 * `tools/call`. Verifying a token by asking Privy — either their
 * `/api/v1/users/me` endpoint or an uncached JWKS fetch — would put a network
 * hop from a third party in front of every tool call this platform serves:
 * their p99 becomes our p50, their outage becomes our outage, and their rate
 * limit becomes our capacity. Verification is therefore **local**, against
 * public keys, and this class is the only thing that ever talks to Privy on
 * the auth path.
 *
 * ## Fail closed, with a grace window that is not failing open
 *
 * Three states, deliberately distinguished:
 *
 * | State | Behaviour |
 * |---|---|
 * | Fresh key set (age < `jwksTtlMs`) | verify against it |
 * | Stale, refresh failed, age < `ttl + staleGrace` | verify against the **cached** keys |
 * | Nothing cached, or past the grace window | `AUTH_IDENTITY_PROVIDER_UNAVAILABLE` — refuse every token |
 *
 * Serving stale keys during an outage is not failing open: the keys were
 * fetched over TLS from Privy, a signature made by one of them is exactly as
 * genuine as it was an hour ago, and the only thing staleness risks is
 * accepting a token signed by a key Privy has since *retired*. Bounding that
 * to `staleGrace` is the trade — against the alternative, which is that Privy
 * having a bad ten minutes logs out every agent on the platform.
 *
 * What is never done is the actual fail-open: no branch anywhere returns "no
 * key, allow it".
 *
 * ## An unknown `kid` forces at most one refresh per `jwksMinRefreshMs`
 *
 * A rotated key first shows up as a `kid` we have never seen, and the correct
 * response is to re-fetch. But `kid` is attacker-controlled — a stream of
 * forged tokens carrying random `kid`s would otherwise turn this service into
 * a request amplifier pointed at Privy. The floor makes that cost one fetch a
 * minute regardless of how many forgeries arrive.
 *
 * ## Single-flight
 *
 * Concurrent misses share one in-flight fetch. Without it, a cold start or an
 * expiry under load fires one outbound request per in-flight HTTP request.
 */
@Injectable()
export class PrivyJwksCache {
  private readonly logger = new Logger(PrivyJwksCache.name);

  private keys: ReadonlyMap<string, KeyObject> | null = null;
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly egress: EgressHttpClient,
    @Inject(PRIVY_AUTH_CONFIG) private readonly config: PrivyAuthConfig,
  ) {}

  /**
   * The public key for `kid`, or `null` when this key set does not contain one.
   *
   * `null` means "no such key" and the caller turns it into the same generic
   * refusal every other token failure produces. A **throw** means "we could
   * not check at all" and is the fail-closed branch.
   */
  async getKey(kid: string): Promise<KeyObject | null> {
    const now = Date.now();

    if (this.isFresh(now)) {
      const hit = this.keys?.get(kid);
      if (hit) return hit;

      // Fresh but unrecognised: either a rotation we have not seen, or a
      // forgery. Both look identical from here, so re-fetch — at most once per
      // `jwksMinRefreshMs`, which is what stops the forgery case from becoming
      // an amplifier.
      if (now - this.lastAttemptAt < this.config.jwksMinRefreshMs) {
        return null;
      }
    }

    await this.refresh();

    const key = this.keys?.get(kid) ?? null;
    if (!key && !this.keys) {
      // `refresh` already threw in that case; this is belt-and-braces so that
      // a future edit cannot turn "no keys at all" into "no such key".
      throw AuthErrors.identityProviderUnavailable();
    }
    return key;
  }

  private isFresh(now: number): boolean {
    return this.keys !== null && now - this.fetchedAt < this.config.jwksTtlMs;
  }

  /** Fetch and replace the key set, or decide what to do about not being able to. */
  private async refresh(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchAndStore().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async fetchAndStore(): Promise<void> {
    this.lastAttemptAt = Date.now();

    try {
      const response = await this.egress.request({
        url: this.config.jwksUrl,
        method: 'GET',
        headers: { accept: 'application/json' },
        // Public endpoint, operator-configured URL, so `PUBLIC_ONLY` — same
        // reasoning as `WebhookAlertSink`: `INTERNAL_ALLOWED` would only buy
        // the ability for a misconfigured `PRIVY_JWKS_URL` to reach a private
        // address, which is the SSRF primitive, not a feature. The limits are
        // tightened hard because a JWKS is a few hundred bytes and this call
        // sits in front of authentication.
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, {
          totalTimeoutMs: 5_000,
          headersTimeoutMs: 3_000,
          bodyTimeoutMs: 3_000,
          maxResponseBytes: 64 * 1024,
          maxRedirects: 0,
        }),
      });

      if (response.status !== 200) {
        throw new Error(`JWKS endpoint answered HTTP ${response.status}`);
      }

      const parsed = parseJwks(response.body);
      if (parsed.size === 0) {
        throw new Error('JWKS contained no usable ES256 keys');
      }

      this.keys = parsed;
      this.fetchedAt = Date.now();
      this.logger.log(`Loaded ${parsed.size} Privy signing key(s)`);
    } catch (error) {
      const usableUntil = this.fetchedAt + this.config.jwksTtlMs + this.config.jwksStaleGraceMs;
      const canServeStale = this.keys !== null && Date.now() < usableUntil;

      if (canServeStale) {
        this.logger.warn(
          `Privy JWKS refresh failed (${describe(error)}); serving the cached key set ` +
            `until ${new Date(usableUntil).toISOString()}`,
        );
        return;
      }

      // Nothing usable. Drop what we have so the next call cannot mistake an
      // expired set for a valid one, and refuse.
      this.keys = null;
      this.logger.error(
        `Privy JWKS unavailable and nothing cached is still usable (${describe(error)}); ` +
          'refusing every token until it returns',
      );
      throw AuthErrors.identityProviderUnavailable();
    }
  }
}

/**
 * JWKS JSON → `kid → KeyObject`, keeping only what we will actually verify
 * with.
 *
 * Anything that is not an EC P-256 signing key is dropped rather than imported
 * and rejected later: `alg` is pinned to ES256 at the token header, so a key
 * of any other type in this map could only ever be reached by a bug.
 */
function parseJwks(body: string): ReadonlyMap<string, KeyObject> {
  const parsed: unknown = JSON.parse(body);
  const keys = (parsed as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) {
    throw new Error('JWKS response has no `keys` array');
  }

  const map = new Map<string, KeyObject>();

  for (const entry of keys as PrivyJwk[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.kty !== 'EC' || entry.crv !== 'P-256') continue;
    if (entry.use && entry.use !== 'sig') continue;
    if (entry.alg && entry.alg !== 'ES256') continue;
    if (typeof entry.kid !== 'string' || !entry.kid) continue;
    if (typeof entry.x !== 'string' || typeof entry.y !== 'string') continue;

    try {
      map.set(
        entry.kid,
        createPublicKey({
          key: { kty: 'EC', crv: 'P-256', x: entry.x, y: entry.y },
          format: 'jwk',
        }),
      );
    } catch {
      // A malformed member must not cost us the rest of the set — a rotation
      // that publishes a key we cannot import should still leave the current
      // one usable.
      continue;
    }
  }

  return map;
}

function describe(error: unknown): string {
  if (isEgressError(error)) {
    return `${error.code} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
