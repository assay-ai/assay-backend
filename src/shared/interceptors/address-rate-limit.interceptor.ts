import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { Observable, from, mergeMap } from 'rxjs';

import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

/** One limit: how many requests, per how long, under which Redis key prefix. */
export interface AddressRateLimit {
  limit: number;
  windowMs: number;
  /** Prefix of the shared counters in Redis, one per limit so two limits never share a count. */
  keyPrefix: string;
  /** Addresses the in-process fallback tracks at once. */
  maxAddresses: number;
}

/** After a Redis failure, how long requests skip it and go straight to the in-process window. */
export const SHARED_WINDOW_RETRY_MS = 5_000;

export interface RateOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * A per-address fixed window, counted in Redis so every instance shares it.
 *
 * ## Why Redis, and why a fallback
 *
 * An in-process count gives each instance its own window, so N API replicas
 * allow N × `limit`, and a client spread across replicas by the load balancer
 * gets all of it. The shared count in Redis is one window across the fleet.
 *
 * If Redis does not answer within `withRedisTimeout`'s deadline, the request is
 * counted in a bounded in-process `Map` instead, the way every request was
 * counted before. **That is still a limit**, only a per-instance one: the
 * routes behind this spend nothing, so a Redis outage must not take them down,
 * and it must not lift every limit either. For {@link SHARED_WINDOW_RETRY_MS}
 * after a failure Redis is not asked at all, so an outage does not add the
 * deadline to every request.
 *
 * ## Who the client is
 *
 * `request.ip`, never a header read here: Express derives it from the socket
 * and `trust proxy`. **`API_TRUST_PROXY_HOPS` must equal the real number of
 * proxies in front of the API** (Cloudflare plus a load balancer is 2). Too
 * low and every visitor shares the proxy's address and one limit; too high and
 * a visitor picks their own address with `X-Forwarded-For`.
 *
 * An IPv6 client is keyed by its 64-bit prefix (its "/64"): one subscriber
 * usually holds a whole prefix, and keying by the full address would hand them
 * 2^64 separate limits.
 *
 * ## Why an interceptor and not a guard
 *
 * A public controller declares no guard at all (`surface-consistency.spec.ts`
 * pins that, so a route meant to be open cannot pick up an auth guard on the
 * way past). This decides nothing about *who* the caller is, only how often.
 */
export abstract class AddressRateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(this.constructor.name);
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  /** When the fallback was last logged; one warning per window, not one per request. */
  private lastFallbackWarnAt = Number.NEGATIVE_INFINITY;
  private skipSharedUntil = Number.NEGATIVE_INFINITY;

  /** The clock; a field rather than a constructor parameter so DI has nothing to resolve. */
  now: () => number = Date.now;

  /**
   * @param redis the shared cache client. Absent (unit tests, a module that
   *   boots without `RedisCacheModule`), every request is counted in process.
   */
  protected constructor(
    private readonly rate: AddressRateLimit,
    private readonly redis?: Redis,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const client = clientKey(http.getRequest<Request>().ip);
    const response = http.getResponse<Response>();

    if (!this.redis) {
      this.enforce(this.take(client), response);
      return next.handle();
    }
    return from(this.takeShared(client)).pipe(
      mergeMap((outcome) => {
        this.enforce(outcome, response);
        return next.handle();
      }),
    );
  }

  /**
   * Count one request from `client` in the shared window; on a Redis failure,
   * in the in-process one.
   *
   * `INCR` and `PEXPIRE` go in one `MULTI`, and the window index is part of the
   * key: a counter whose expiry was lost would otherwise outlive its window and
   * lock the address out for good. With the index in the key, the worst a lost
   * expiry can do is leave one dead key behind.
   */
  async takeShared(client: string): Promise<RateOutcome> {
    const now = this.now();
    const index = Math.floor(now / this.rate.windowMs);
    const key = `${this.rate.keyPrefix}${client}:${index}`;
    const redis = this.redis as Redis;
    if (now < this.skipSharedUntil) return this.take(client);

    try {
      const results = await withRedisTimeout(() =>
        redis.multi().incr(key).pexpire(key, this.rate.windowMs).exec(),
      );
      const [error, count] = results?.[0] ?? [new Error('transaction discarded'), null];
      if (error) throw error;

      const windowEndsAt = (index + 1) * this.rate.windowMs;
      return {
        allowed: Number(count) <= this.rate.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAt - now) / 1000)),
      };
    } catch (error) {
      this.skipSharedUntil = now + SHARED_WINDOW_RETRY_MS;
      if (now - this.lastFallbackWarnAt >= this.rate.windowMs) {
        this.lastFallbackWarnAt = now;
        this.logger.warn(
          `shared rate window unavailable, counting per instance: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return this.take(client);
    }
  }

  /** Count one request from `client` in process; refused with the seconds until its window resets. */
  take(client: string): RateOutcome {
    const now = this.now();
    let window = this.windows.get(client);

    if (!window || now - window.startedAt >= this.rate.windowMs) {
      // Re-inserted, so the map's insertion order stays oldest-window-first.
      this.windows.delete(client);
      if (this.windows.size >= this.rate.maxAddresses) this.evict(now);
      window = { startedAt: now, count: 0 };
      this.windows.set(client, window);
    }

    window.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((window.startedAt + this.rate.windowMs - now) / 1000),
    );
    return { allowed: window.count <= this.rate.limit, retryAfterSeconds };
  }

  private enforce(outcome: RateOutcome, response: Response): void {
    if (outcome.allowed) return;
    response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
    throw new HttpException(
      'Too many requests from this address. Try again shortly.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Drop expired windows; if still full, drop the oldest until there is room. */
  private evict(now: number): void {
    for (const [client, window] of this.windows) {
      if (now - window.startedAt >= this.rate.windowMs) this.windows.delete(client);
    }
    for (const client of this.windows.keys()) {
      if (this.windows.size < this.rate.maxAddresses) break;
      this.windows.delete(client);
    }
  }
}

/**
 * The rate-limit key for an address: IPv4 as is (also when IPv4-mapped in
 * IPv6), IPv6 reduced to its /64 prefix.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;

  const address = ip.split('%')[0].toLowerCase();
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right];

  return `${groups
    .slice(0, 4)
    .map((group) => (parseInt(group, 16) || 0).toString(16))
    .join(':')}::/64`;
}
