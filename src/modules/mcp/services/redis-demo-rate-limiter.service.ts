import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';

import {
  DEMO_RATE_LIMITS,
  DemoRateLimits,
  DemoRateOutcome,
  decideDemoRate,
} from '../domain/demo-rate-limit';

export const DEMO_RATE_REDIS = Symbol('DEMO_RATE_REDIS');
export const DEMO_RATE_LIMITS_TOKEN = Symbol('DEMO_RATE_LIMITS');
/** The Redis key prefix, so a second route can reuse this window under its own keys. */
export const DEMO_RATE_KEY_PREFIX = Symbol('DEMO_RATE_KEY_PREFIX');

/**
 * The sliding window behind `decideDemoRate`.
 *
 * A sorted set per address, scored by timestamp: drop everything older than the
 * window, add this attempt, count what is left. The same three commands
 * `RedisSigningRateLimiter` uses, in one `MULTI` so the count a decision is
 * made on cannot be a count from between two other requests' writes.
 *
 * **The attempt is recorded before the decision.** A limiter that only counted
 * calls it allowed would let a refused caller retry forever at no cost to their
 * own budget, which is the opposite of what a limit is for.
 *
 * **Its own connection**, not the shared cache client — same reason the signing
 * limiter gives: this sits on the path that decides whether money is spent, and
 * it must not queue behind cache traffic or be taken down by it.
 *
 * **Fails closed.** A Redis error yields `used: null`, which `decideDemoRate`
 * turns into a refusal. See that file for why this limiter chooses the opposite
 * direction from the binding ceilings.
 */
@Injectable()
export class RedisDemoRateLimiter implements OnModuleDestroy {
  private readonly logger = new Logger(RedisDemoRateLimiter.name);

  constructor(
    @Inject(DEMO_RATE_REDIS) private readonly redis: Redis,
    @Inject(DEMO_RATE_LIMITS_TOKEN) private readonly limits: DemoRateLimits = DEMO_RATE_LIMITS,
    @Optional()
    @Inject(DEMO_RATE_KEY_PREFIX)
    private readonly keyPrefix: string = 'demo:rate:',
  ) {}

  /**
   * Record one attempt from `address` and say whether it may proceed.
   *
   * `address` is whatever the caller decided identifies the client — see the
   * controller for why that is not simply `req.ip`.
   */
  async take(address: string): Promise<DemoRateOutcome> {
    const now = Date.now();
    const key = `${this.keyPrefix ?? 'demo:rate:'}${address}`;

    let used: number | null = null;
    try {
      const results = await this.redis
        .multi()
        .zremrangebyscore(key, '-inf', now - this.limits.windowMs)
        // A unique member per attempt: two calls in the same millisecond must
        // count as two, and a plain timestamp member would collapse them.
        .zadd(key, now, `${now}:${randomUUID()}`)
        .zcard(key)
        .pexpire(key, this.limits.windowMs)
        .exec();

      // `zcard` is the third command and counts THIS attempt, because the
      // `zadd` above already ran. `decideDemoRate` is defined on calls
      // ALREADY made — at `limit - 1` the current request is the last one that
      // fits — so the attempt is subtracted back out here. Passing the
      // post-increment count would refuse every caller one call early.
      const card = results?.[2];
      used = card && !card[0] ? Number(card[1]) - 1 : null;
    } catch (error) {
      this.logger.warn(
        `Demo rate window unreadable for ${address}; refusing. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return decideDemoRate({ used, limits: this.limits });
  }

  async onModuleDestroy(): Promise<void> {
    // Explicit, unlike `RedisCacheModule` — a client with no shutdown hook
    // hangs every script that boots the module it lives in.
    await this.redis.quit().catch(() => undefined);
  }
}
