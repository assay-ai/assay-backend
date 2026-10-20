import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';
import {
  SHARED_WINDOW_RETRY_MS,
  clientKey,
} from '@shared/interceptors/address-rate-limit.interceptor';

/** Refused credentials one client address may send inside the window. */
export const MCP_AUTH_MAX_FAILURES = 100;

/** The window, and how long an address stays refused once it is over the limit. */
export const MCP_AUTH_FAILURE_WINDOW_SECONDS = 300;

const KEY_PREFIX = 'mcp:auth:failures:';

/**
 * Counts refused credentials on the MCP host by client address, and refuses
 * an address that is over the limit **before** its token is looked up.
 *
 * A well-formed but unknown API key costs one indexed query, and an OAuth
 * access token two, so an unthrottled stream of made-up tokens is a stream of
 * database reads that no other limit sees: `McpRateLimiter` and the spend
 * policy key on a credential, and a made-up token has none.
 *
 * ## What is counted
 *
 * Only a presented token no issuer recognises (`unauthorizedReason` `unknown`).
 * A request with no token is the first step of every OAuth sign-in (the client
 * reads `WWW-Authenticate` from the 401) and costs no read. An expired, revoked
 * or wrong-audience token was a real credential, and OAuth access tokens expire
 * every hour, so a busy hosted connector produces those routinely. Neither is
 * counted, and a valid session is never counted.
 *
 * A valid session **is** refused while its address is over the limit: the
 * check runs before the token is looked up, which is the point of it.
 *
 * ## The limit is deliberately loose
 *
 * {@link MCP_AUTH_MAX_FAILURES} in five minutes. Agents run behind shared
 * egress (a cloud NAT, a CI runner pool), so one misconfigured agent shares
 * its address with healthy ones, and while the address is refused they are
 * refused too. The control is "stop a token guesser", not "punish a typo".
 * Cloudflare's rate-limiting rule is the coarse flood limit in front of it.
 *
 * ## Fails OPEN
 *
 * If Redis does not answer, nothing is counted or refused and a warning is
 * logged: an outage of a counter must not take the paid MCP surface down. For
 * {@link SHARED_WINDOW_RETRY_MS} after a failure Redis is not asked at all, so
 * an outage does not add the Redis deadline to every MCP request.
 *
 * The address is `request.ip`, which is right behind Cloudflare and the load
 * balancer only when `API_TRUST_PROXY_HOPS` names their hops.
 */
@Injectable()
export class McpAuthFailureThrottle {
  private readonly logger = new Logger(McpAuthFailureThrottle.name);
  /** When an outage was last logged; one warning a minute, not one per request. */
  private lastOutageWarnAt = Number.NEGATIVE_INFINITY;
  private skipRedisUntil = Number.NEGATIVE_INFINITY;

  /** The clock; a field rather than a constructor parameter so DI has nothing to resolve. */
  now: () => number = Date.now;

  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  /**
   * Seconds until this address may try again: `0` when it is under the limit,
   * and also when Redis cannot say.
   */
  async blockedForSeconds(ip: string | undefined): Promise<number> {
    const key = KEY_PREFIX + clientKey(ip);
    if (this.now() < this.skipRedisUntil) return 0;
    try {
      const results = await withRedisTimeout(() => this.redis.multi().get(key).ttl(key).exec());
      const [getError, failures] = results?.[0] ?? [new Error('transaction discarded'), null];
      const [ttlError, ttl] = results?.[1] ?? [new Error('transaction discarded'), null];
      if (getError) throw getError;
      if (ttlError) throw ttlError;
      if (Number(failures ?? 0) < MCP_AUTH_MAX_FAILURES) return 0;
      return Math.max(1, Number(ttl));
    } catch (error) {
      this.warnOutage(`MCP auth throttle unavailable, not enforced: ${describe(error)}`);
      return 0;
    }
  }

  /**
   * Count one refused credential from this address.
   *
   * One transaction: `SET … EX NX` opens the window with its TTL only when the
   * key is new, and `INCR` keeps that TTL, so a lost expiry cannot leave a
   * counter that refuses the address for good (`OperatorAuthThrottle` gives
   * the same reason).
   */
  async recordFailure(ip: string | undefined): Promise<void> {
    const key = KEY_PREFIX + clientKey(ip);
    if (this.now() < this.skipRedisUntil) return;
    try {
      const results = await withRedisTimeout(() =>
        this.redis
          .multi()
          .set(key, 0, 'EX', MCP_AUTH_FAILURE_WINDOW_SECONDS, 'NX')
          .incr(key)
          .exec(),
      );
      const [error, count] = results?.[1] ?? [new Error('transaction discarded'), null];
      if (error) throw error;
      if (Number(count) === MCP_AUTH_MAX_FAILURES) {
        this.logger.warn(
          `MCP authentication: ${MCP_AUTH_MAX_FAILURES} refused credentials from ` +
            `${clientKey(ip)} within ${MCP_AUTH_FAILURE_WINDOW_SECONDS}s, refused until the window ends`,
        );
      }
    } catch (error) {
      this.warnOutage(`MCP auth failure not counted: ${describe(error)}`);
    }
  }

  private warnOutage(message: string): void {
    const now = this.now();
    this.skipRedisUntil = now + SHARED_WINDOW_RETRY_MS;
    if (now - this.lastOutageWarnAt < 60_000) return;
    this.lastOutageWarnAt = now;
    this.logger.warn(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
