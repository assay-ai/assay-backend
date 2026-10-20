import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { AddressRateLimitInterceptor } from './address-rate-limit.interceptor';

export { clientKey } from './address-rate-limit.interceptor';

/** Requests one client may make per window, across the routes that use this. */
export const PUBLIC_READ_LIMIT = 120;
export const PUBLIC_READ_WINDOW_MS = 60_000;
/** Clients the in-process fallback tracks at once. Past this, expired windows go first, then the oldest. */
export const PUBLIC_READ_MAX_ADDRESSES = 10_000;

/**
 * The per-client window for the unauthenticated **read** routes, one count
 * across every route and every instance that uses it (see
 * {@link AddressRateLimitInterceptor}).
 *
 * ## Why it fails open to a local count, unlike the demo's limiter
 *
 * `RedisDemoRateLimiter` protects money and a third party's endpoint, so it
 * fails closed. These routes spend nothing and every answer is already served
 * from an in-process cache (or, in front of the API, from Cloudflare's), so a
 * Redis outage falls back to the per-instance window rather than to a refusal.
 *
 * Responses Cloudflare serves from its cache never reach the API and are not
 * counted: the window bounds what reaches the origin, which is the point.
 */
@Injectable()
export class PublicReadRateLimitInterceptor extends AddressRateLimitInterceptor {
  constructor(@Optional() @Inject(REDIS_CACHE_CLIENT) redis?: Redis) {
    super(
      {
        limit: PUBLIC_READ_LIMIT,
        windowMs: PUBLIC_READ_WINDOW_MS,
        keyPrefix: 'rate:public-read:',
        maxAddresses: PUBLIC_READ_MAX_ADDRESSES,
      },
      redis,
    );
  }
}
