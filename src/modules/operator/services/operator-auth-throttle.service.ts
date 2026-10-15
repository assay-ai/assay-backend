import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { OperatorErrors } from '../errors/operator.errors';

/** Failures one key (a client address or a wallet) may accumulate inside the window. */
export const OPERATOR_AUTH_MAX_FAILURES = 10;

/** The window, and how long an address stays blocked once it is over the limit. */
export const OPERATOR_AUTH_FAILURE_WINDOW_SECONDS = 300;

/** Sign-in challenges one client address may ask for inside the window. */
export const OPERATOR_CHALLENGE_MAX_PER_WINDOW = 30;

const KEY_PREFIX = 'operator:auth:failures:';
const CHALLENGE_PREFIX = 'operator:auth:challenges:';

/** The throttle key for a client address. */
export const ipKey = (ip: string): string => `ip:${ip}`;

/**
 * Counts failed operator sign-ins and refused session tokens, in Redis.
 *
 * Keyed by client address (`ipKey`) only. Never by wallet: a wallet key can be
 * driven by anyone who names that wallet, which turns the count into a lockout
 * of that operator, and a signature cannot be guessed anyway.
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

  /**
   * Count one sign-in challenge for this key, and throw
   * `OPERATOR_AUTH_RATE_LIMITED` once it is over
   * {@link OPERATOR_CHALLENGE_MAX_PER_WINDOW} inside the window. Each challenge
   * writes a Redis key, so an unthrottled flood grows Redis without bound.
   */
  async countChallenge(key: string): Promise<void> {
    let issued: number;
    try {
      issued = await this.countInWindow(CHALLENGE_PREFIX + key);
    } catch (error) {
      this.logger.warn(`operator challenge throttle unavailable, not enforced: ${describe(error)}`);
      return;
    }
    if (issued > OPERATOR_CHALLENGE_MAX_PER_WINDOW) throw OperatorErrors.authRateLimited();
  }

  /** Count one failure. Logs at error level when the limit is reached. */
  async recordFailure(key: string): Promise<void> {
    try {
      const failures = await this.countInWindow(KEY_PREFIX + key);
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

  /**
   * Add one to a fixed-window counter and return the new count.
   *
   * One transaction: `SET … EX NX` opens the window with its TTL only when
   * the key is new, and `INCR` keeps that TTL. A separate `INCR` then
   * `EXPIRE` left a counter that never expires when the second command failed,
   * which for an IP-keyed throttle is a permanent lockout (review N-4).
   */
  private async countInWindow(redisKey: string): Promise<number> {
    const results = await this.redis
      .multi()
      .set(redisKey, 0, 'EX', OPERATOR_AUTH_FAILURE_WINDOW_SECONDS, 'NX')
      .incr(redisKey)
      .exec();
    const [error, count] = results?.[1] ?? [new Error('transaction discarded'), null];
    if (error) throw error;
    return Number(count);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
