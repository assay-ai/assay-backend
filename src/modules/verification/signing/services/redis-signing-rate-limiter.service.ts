import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { RateWindowObservation, SigningRateLimits } from '../domain/signing-rate-limit';
import { SIGNING_RATE_LIMITS, SIGNING_RATE_REDIS } from '../signing.constants';

/**
 * Counts signing attempts in a sliding window, in Redis.
 *
 * ## Sliding, not fixed
 *
 * A fixed window is one `INCR` and one `EXPIRE`, and it lets through twice the
 * ceiling across a boundary — 60 signatures in the last second of one minute
 * and 60 in the first second of the next is 120 in two seconds, every one of
 * them "within the limit". For a throttle on an HTTP route that is a rounding
 * error. For the key that can drain every provider's stake it is a hole with a
 * clock on it, and it is trivially findable by an attacker who can watch the
 * rejections.
 *
 * A sorted set keyed by timestamp costs one round trip more and has no such
 * boundary: the window is always the last `windowSeconds`, measured from now.
 *
 * ## Redis is the counter, not the guarantee
 *
 * If Redis is unavailable this refuses to sign — see {@link observe}. That is
 * the opposite of the usual choice for a rate limiter, where the request is
 * more important than the counting, and it is deliberate: the thing being
 * rate-limited here is the production of signatures that take money from
 * providers. Failing open would mean that anyone who could knock Redis over
 * would also remove the only bound on how fast a stolen key can be used, and
 * knocking Redis over is easier than stealing the key. Failing closed halts
 * attestation issuance and costs nobody anything that cannot be re-issued
 * afterwards.
 *
 * The same reasoning as the kill switch's stale-snapshot rule next door, and
 * the same conclusion: during the incident this control exists for, the
 * unavailable-therefore-permitted branch is the one an attacker steers you into.
 */
@Injectable()
export class RedisSigningRateLimiter implements OnModuleDestroy {
  constructor(
    @Inject(SIGNING_RATE_REDIS) private readonly redis: Redis,
    @Inject(SIGNING_RATE_LIMITS) private readonly limits: SigningRateLimits,
  ) {}

  /**
   * Record this attempt and report where each scope now stands.
   *
   * The increment happens before the decision, and the caller decides on the
   * post-increment count — `decideSigningRate` documents why both halves of
   * that matter. The counters here are therefore a record of *attempts*, which
   * is what a rate anomaly is made of; the journal separately records which of
   * them produced a signature.
   */
  async observe(keyId: string, requesterId: string): Promise<readonly RateWindowObservation[]> {
    const now = Date.now();
    const windowMs = this.limits.windowSeconds * 1000;
    // Unique per attempt. Two signatures in the same millisecond are ordinary
    // under load, and a plain timestamp member would silently overwrite one of
    // them — undercounting exactly when the count matters.
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

    const scopes = [
      // Narrowest first: `decideSigningRate` names the first breached scope, and
      // "this caller is out of budget" is more actionable than "the key is".
      { scope: `requester:${requesterId}`, limit: this.limits.perRequester },
      { scope: `key:${keyId}`, limit: this.limits.perKey },
    ];

    const pipeline = this.redis.multi();
    for (const { scope } of scopes) {
      const redisKey = this.redisKey(keyId, scope);
      pipeline.zremrangebyscore(redisKey, '-inf', now - windowMs);
      pipeline.zadd(redisKey, now, member);
      pipeline.zcard(redisKey);
      // Refreshed on every write rather than set once, so a key that keeps being
      // used never expires mid-window and a key that goes quiet is cleaned up.
      pipeline.pexpire(redisKey, windowMs);
    }

    const replies = await pipeline.exec();
    if (!replies) {
      // `exec` returns null when the MULTI was discarded — a reconnect, or a
      // watch failure. Not distinguishable from a partial count, so it is
      // treated as "the counter did not run", which fails closed above.
      throw new Error('signing rate counter unavailable');
    }

    return scopes.map(({ scope, limit }, index) => {
      // Four commands per scope; `zcard` is the third of them.
      const [error, observed] = replies[index * COMMANDS_PER_SCOPE + 2];
      if (error) {
        throw error;
      }
      return { scope, observed: Number(observed), limit };
    });
  }

  /**
   * Undo one attempt's contribution to the window.
   *
   * Used for nothing today and deliberately absent from the signing path: a
   * refused attempt still counts (`decideSigningRate` §"Counting refused
   * attempts"). It exists for the rotation drill, which has to be able to leave
   * the counters as it found them on a shared environment.
   */
  async reset(keyId: string): Promise<void> {
    const keys = await this.redis.keys(this.redisKey(keyId, '*'));
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  /**
   * This connection is created by the module's own factory rather than shared,
   * so nothing else will close it — and an ioredis client with an open socket
   * keeps the event loop alive, which turns a script or a test that finishes
   * cleanly into one that hangs forever. `RedisPolicyKillSwitchService` next
   * door does the same for the same reason.
   */
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  private redisKey(keyId: string, scope: string): string {
    return `verifier:signing:rate:${keyId}:${scope}`;
  }
}

const COMMANDS_PER_SCOPE = 4;
