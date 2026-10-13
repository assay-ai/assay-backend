import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { OperatorErrors } from '../errors/operator.errors';

/** Refused tokens one address may present inside the window. */
export const OPERATOR_AUTH_MAX_FAILURES = 10;

/** The window, and how long an address stays blocked once it is over the limit. */
export const OPERATOR_AUTH_FAILURE_WINDOW_SECONDS = 300;

const KEY_PREFIX = 'operator:auth:failures:';

/**
 * Counts refused operator tokens per client address, in Redis.
 *
 * A fixed window is enough here: the control is "slow a guesser down and make
 * it visible", not a spend limit, and tokens are at least 32 characters.
 *
 * ## Fails OPEN
 *
 * If Redis is down the count is skipped and a warning is logged. Operators
 * need the console most during an incident, and a counter outage must not lock
 * them out of it.
 *
 * The address is whatever Express reports as `request.ip`. Behind a shared
 * proxy or NAT every caller shares one counter, so ten bad tokens from one
 * desk block the whole office for the window.
 */
@Injectable()
export class OperatorAuthThrottle {
  private readonly logger = new Logger(OperatorAuthThrottle.name);

  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  /** Throws `OPERATOR_AUTH_RATE_LIMITED` when this address is over the limit. */
  async assertNotBlocked(ip: string): Promise<void> {
    let failures: number;
    try {
      failures = Number((await this.redis.get(KEY_PREFIX + ip)) ?? 0);
    } catch (error) {
      this.logger.warn(`operator auth throttle unavailable, not enforced: ${describe(error)}`);
      return;
    }
    if (failures >= OPERATOR_AUTH_MAX_FAILURES) {
      throw OperatorErrors.authRateLimited();
    }
  }

  /** Count one refused token. Logs at error level when the limit is reached. */
  async recordFailure(ip: string): Promise<void> {
    try {
      const key = KEY_PREFIX + ip;
      const failures = await this.redis.incr(key);
      if (failures === 1) {
        await this.redis.expire(key, OPERATOR_AUTH_FAILURE_WINDOW_SECONDS);
      }
      if (failures === OPERATOR_AUTH_MAX_FAILURES) {
        this.logger.error(
          `operator authentication: ${failures} refused tokens from ${ip} within ` +
            `${OPERATOR_AUTH_FAILURE_WINDOW_SECONDS}s, address blocked until the window ends`,
        );
      }
    } catch (error) {
      this.logger.warn(`operator auth failure not counted: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
