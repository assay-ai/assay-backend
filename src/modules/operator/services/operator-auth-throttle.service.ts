import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { OperatorErrors } from '../errors/operator.errors';

/** Failures one key (a client address or a wallet) may accumulate inside the window. */
export const OPERATOR_AUTH_MAX_FAILURES = 10;

/** The window, and how long an address stays blocked once it is over the limit. */
export const OPERATOR_AUTH_FAILURE_WINDOW_SECONDS = 300;

const KEY_PREFIX = 'operator:auth:failures:';

/** The throttle key for a client address. */
export const ipKey = (ip: string): string => `ip:${ip}`;

/** The throttle key for a wallet, lower-case. */
export const walletKey = (address: string): string => `wallet:${address.toLowerCase()}`;

/**
 * Counts failed operator sign-ins and refused session tokens, in Redis.
 *
 * Keyed by client address (`ipKey`) for everything, and by wallet
 * (`walletKey`) for sign-in verifications, so one guesser cannot spread across
 * many addresses against one wallet nor many wallets from one address.
 *
 * A fixed window is enough here: the control is "slow a guesser down and make
 * it visible", not a spend limit.
 *
 * ## Fails OPEN
 *
 * If Redis is down the count is skipped and a warning is logged. Operators
 * need the console most during an incident, and a counter outage must not lock
 * them out of it.
 *
 * The address is whatever Express reports as `request.ip`, which is right
 * behind a load balancer only when `API_TRUST_PROXY_HOPS` names its hops.
 * Behind a shared NAT every caller still shares one counter; that is why the
 * guard limits only refused tokens and never a valid session.
 */
@Injectable()
export class OperatorAuthThrottle {
  private readonly logger = new Logger(OperatorAuthThrottle.name);

  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  /** Throws `OPERATOR_AUTH_RATE_LIMITED` when this key is over the limit. */
  async assertNotBlocked(key: string): Promise<void> {
    let failures: number;
    try {
      failures = Number((await this.redis.get(KEY_PREFIX + key)) ?? 0);
    } catch (error) {
      this.logger.warn(`operator auth throttle unavailable, not enforced: ${describe(error)}`);
      return;
    }
    if (failures >= OPERATOR_AUTH_MAX_FAILURES) {
      throw OperatorErrors.authRateLimited();
    }
  }

  /** Count one failure. Logs at error level when the limit is reached. */
  async recordFailure(key: string): Promise<void> {
    try {
      const redisKey = KEY_PREFIX + key;
      const failures = await this.redis.incr(redisKey);
      if (failures === 1) {
        await this.redis.expire(redisKey, OPERATOR_AUTH_FAILURE_WINDOW_SECONDS);
      }
      if (failures === OPERATOR_AUTH_MAX_FAILURES) {
        this.logger.error(
          `operator authentication: ${failures} failures for ${key} within ` +
            `${OPERATOR_AUTH_FAILURE_WINDOW_SECONDS}s, blocked until the window ends`,
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
