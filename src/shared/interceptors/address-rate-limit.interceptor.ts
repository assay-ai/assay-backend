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

import {
  RateOutcome,
  SHARED_WINDOW_RETRY_MS,
  SharedRateWindows,
} from '@shared/rate-limit/shared-rate-windows';

/** One limit: how many requests, per how long, under which Redis key prefix. */
export interface AddressRateLimit {
  limit: number;
  windowMs: number;
  /** Prefix of the shared counters in Redis, one per limit so two limits never share a count. */
  keyPrefix: string;
  /** Addresses the in-process fallback tracks at once. */
  maxAddresses: number;
}

export { SHARED_WINDOW_RETRY_MS };
export type { RateOutcome };

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
  private readonly counter: SharedRateWindows;

  /** The clock; a field rather than a constructor parameter so DI has nothing to resolve. */
  now: () => number = Date.now;

  /**
   * @param redis the shared cache client. Absent (unit tests, a module that
   *   boots without `RedisCacheModule`), every request is counted in process.
   */
  protected constructor(
    private readonly rate: AddressRateLimit,
    private readonly redis?: Redis,
  ) {
    this.counter = new SharedRateWindows({
      redis,
      keyPrefix: rate.keyPrefix,
      maxKeys: rate.maxAddresses,
      now: () => this.now(),
      logger: new Logger(this.constructor.name),
    });
  }

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
   * in the in-process one (see {@link SharedRateWindows}).
   */
  takeShared(client: string): Promise<RateOutcome> {
    return this.counter.take(client, this.rate);
  }

  /** Count one request from `client` in process; refused with the seconds until its window resets. */
  take(client: string): RateOutcome {
    return this.counter.takeLocal(client, this.rate);
  }

  private enforce(outcome: RateOutcome, response: Response): void {
    if (outcome.allowed) return;
    response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
    throw new HttpException(
      'Too many requests from this address. Try again shortly.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
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
