import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { clientKey } from '@shared/interceptors/public-read-rate-limit.interceptor';

/**
 * The OAuth limits that are counted in Redis (spec §6.3.7, §6.3.8). Each is a
 * count per fixed window, so the spec table and the code read side by side.
 */
export const OAUTH_RATE_LIMITS = Object.freeze({
  /** CIMD fetches per minute to one host. */
  cimdPerHostPerMinute: 30,
  /** CIMD fetches per minute caused by one client IP key. */
  cimdPerIpPerMinute: 10,
  /** CIMD fetches per minute, all hosts and clients together. */
  cimdGlobalPerMinute: 600,
  /** `POST /oauth/register` per hour from one client IP key. */
  dcrPerIpPerHour: 20,
});

export const OAUTH_MINUTE_SECONDS = 60;
export const OAUTH_HOUR_SECONDS = 3600;

/** Injected by tests; production reads the wall clock. */
export const OAUTH_CLOCK = 'OAUTH_CLOCK';

/**
 * The rate-limit key of a client address: IPv4 as is (also when IPv4-mapped),
 * IPv6 by its /64. The same key the public read routes use.
 */
export function oauthIpKey(ip: string | undefined): string {
  return clientKey(ip);
}

/**
 * Fixed-window counters in Redis, shared by every instance.
 *
 * **Fails closed**, unlike `McpRateLimiter`: these limits bound what a
 * stranger can make this server do on its own behalf (fetch a URL they chose,
 * write a client row). With Redis down the answer is "not now", never
 * "unlimited".
 */
@Injectable()
export class OAuthRateLimiter {
  private readonly logger = new Logger(OAuthRateLimiter.name);

  constructor(
    @Optional() private readonly cache?: CacheService,
    @Optional() @Inject(OAUTH_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  /**
   * Count one more under `name`/`key` in the current window of
   * `windowSeconds`; `true` while the count is within `limit`.
   */
  async take(name: string, key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (!this.cache) return false;
    const windowMs = windowSeconds * 1000;
    const bucket = Math.floor(this.now() / windowMs);
    const bucketKey = `oauth:rl:${name}:${key}:${bucket}`;
    try {
      const redis = this.cache.getRedisClient();
      const count = await redis.incr(bucketKey);
      if (count === 1) await redis.pexpire(bucketKey, windowMs * 2);
      return count <= limit;
    } catch (error) {
      this.logger.warn(
        `OAuth rate counter ${name} unavailable; refusing. ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
