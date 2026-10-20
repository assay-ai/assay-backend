import { SetMetadata } from '@nestjs/common';

export const CACHE_HEADER_KEY = 'cache_header';
export const NO_CACHE_HEADER_KEY = 'no_cache_header';

export interface CacheHeaderOptions {
  /**
   * Browser: Max age in seconds - how long the response is considered fresh in browser
   * @default 10
   */
  maxAge?: number;

  /**
   * Stale-while-revalidate in seconds - how long stale content can be served while revalidating in BROWSER
   * Browser typically needs shorter stale time for better UX
   * @default 30
   */
  staleWhileRevalidate?: number;

  /**
   * Stale-if-error in seconds - how long stale content can be served if origin returns error in BROWSER
   * Useful for high availability - serve stale cache when server is down
   * @default 3600 (1 hour)
   */
  staleIfError?: number;

  /**
   * Whether the cache is public (can be cached by CDN/proxy) or private (only browser cache)
   * @default 'public'
   */
  visibility?: 'public' | 'private';

  /**
   * Whether the cache must be revalidated before use
   * @default false
   */
  mustRevalidate?: boolean;

  /**
   * Additional cache control directives
   */
  additionalDirectives?: string[];

  /**
   * CDN: Cache TTL in seconds (s-maxage for Cache-Control, max-age for CDN-Cache-Control)
   * If set, CDN will cache for this duration regardless of browser max-age
   * Useful for caching longer on CDN than in browser
   * @default undefined (uses max-age)
   */
  cdnMaxAge?: number;

  /**
   * Cloudflare-specific: CDN stale-while-revalidate in seconds
   * CDN can serve stale content much longer than browser to reduce origin load
   * If not set, uses staleWhileRevalidate value
   * @default undefined (uses staleWhileRevalidate)
   */
  cdnStaleWhileRevalidate?: number;

  /**
   * Cloudflare-specific: CDN stale-if-error in seconds
   * CDN can serve stale content longer than browser when origin is down
   * If not set, uses staleIfError value
   * @default undefined (uses staleIfError)
   */
  cdnStaleIfError?: number;

  /**
   * Cloudflare-specific: Enable Cloudflare cache
   * Set to false to bypass Cloudflare cache but still cache in browser
   * @default true
   */
  cloudflareCache?: boolean;
}

/**
 * Opt a GET route in to browser (and, if public, CDN) caching.
 *
 * Without this decorator a GET is sent `private, no-cache`: the browser always
 * revalidates and never paints a stale body. Add it only to a route whose data
 * may be shown out of date for the declared window — never to a per-tenant or
 * money-bearing read that the console refetches after a write.
 * @param options - Cache header configuration
 * @example
 * ```typescript
 * @CacheHeader({ maxAge: 60, staleWhileRevalidate: 300 })
 * @Get()
 * async findAll() {
 *   return this.service.findAll();
 * }
 * ```
 */
export const CacheHeader = (options?: CacheHeaderOptions) => SetMetadata(CACHE_HEADER_KEY, options);

/**
 * Disable cache headers for specific endpoint
 * @example
 * ```typescript
 * @NoCacheHeader()
 * @Get('sensitive')
 * async getSensitiveData() {
 *   return this.service.getSensitiveData();
 * }
 * ```
 */
export const NoCacheHeader = () => SetMetadata(NO_CACHE_HEADER_KEY, true);

/**
 * Preset: Short cache (3s fresh, 10s stale)
 * Good for frequently changing data (live updates, feeds)
 * Browser: 3s fresh, 10s stale
 * CDN: 10s fresh, 5min stale
 */
export const ShortCache = () =>
  CacheHeader({
    maxAge: 3,
    cdnMaxAge: 10,
    staleWhileRevalidate: 10, // Browser: 10s stale
    cdnStaleWhileRevalidate: 300, // CDN: 5m stale
    staleIfError: 60, // Browser: 1 minute if error
    cdnStaleIfError: 300, // CDN: 5 minutes if error
    visibility: 'public',
    cloudflareCache: true,
  });

/**
 * Preset: Medium cache (15s fresh, 30s stale)
 * Good for moderately changing data (event lists, market data)
 * Browser: 15s fresh, 30s stale
 * CDN: 30s fresh, 30min stale
 */
export const MediumCache = () =>
  CacheHeader({
    maxAge: 15,
    cdnMaxAge: 30,
    staleWhileRevalidate: 30, // Browser: 30s stale
    cdnStaleWhileRevalidate: 1800, // CDN: 30 minutes stale
    staleIfError: 300, // Browser: 5 minutes if error
    cdnStaleIfError: 1800, // CDN: 30 minutes if error
    visibility: 'public',
    cloudflareCache: true,
  });

/**
 * Preset: Long cache (30s fresh, 60s stale)
 * Good for rarely changing data (categories, tags, static content)
 * Browser: 30s fresh, 60s stale
 * CDN: 60s fresh, 1 hour stale
 */
export const LongCache = () =>
  CacheHeader({
    maxAge: 30,
    cdnMaxAge: 60,
    staleWhileRevalidate: 60, // Browser: 1min stale
    cdnStaleWhileRevalidate: 3600, // CDN: 1 hour stale
    staleIfError: 300, // Browser: 5 minutes if error
    cdnStaleIfError: 3600, // CDN: 1 hour if error
    visibility: 'public',
    cloudflareCache: true,
  });

/**
 * Preset: Private cache (user-specific data)
 * Cache only in browser, not in CDN/proxy
 * Default: 5s fresh, 30s stale
 */
export const PrivateCache = (maxAge: number = 5, staleWhileRevalidate: number = 15) =>
  CacheHeader({
    maxAge: 0,
    staleWhileRevalidate: 0,
    staleIfError: 0, // Browser: 1 minute if error
    visibility: 'private',
    cdnMaxAge: maxAge,
    cdnStaleWhileRevalidate: staleWhileRevalidate,
    cdnStaleIfError: 60,
  });

/**
 * Cloudflare-optimized: Cache longer on CDN than in browser
 * Default: Browser 10s fresh + 20s stale, CDN 20s fresh + 4000s stale (1+ hour)
 * Good for API endpoints that change occasionally but need high CDN hit rate
 */
export const CloudflareCache = (browserMaxAge: number = 10, cdnMaxAge: number = 20) =>
  CacheHeader({
    maxAge: browserMaxAge,
    cdnMaxAge: cdnMaxAge,
    staleWhileRevalidate: browserMaxAge * 2, // Browser: 2x maxAge stale
    cdnStaleWhileRevalidate: cdnMaxAge * 200, // CDN: 200x cdnMaxAge stale
    staleIfError: browserMaxAge * 10, // Browser: 10x maxAge if error
    cdnStaleIfError: cdnMaxAge * 200, // CDN: 200x cdnMaxAge if error
    visibility: 'public',
    cloudflareCache: true,
  });

/**
 * Cloudflare-optimized: Aggressive edge caching with high availability
 * Browser: 10s fresh + 30s stale
 * CDN: 30s fresh + 30min stale
 * Good for public list endpoints that need high availability and CDN hit rate
 */
export const CloudflareAggressiveCache = () =>
  CacheHeader({
    maxAge: 10, // Browser: 10s fresh
    cdnMaxAge: 30, // CDN: 30s fresh
    staleWhileRevalidate: 30, // Browser: 30s stale
    cdnStaleWhileRevalidate: 1800, // CDN: 30 minutes stale
    staleIfError: 300, // Browser: 5min if error
    cdnStaleIfError: 1800, // CDN: 30min if error (high availability)
    visibility: 'public',
    cloudflareCache: true,
  });

/**
 * The Cloudflare window for the unauthenticated public reads, spread into
 * their `@CacheHeader` options. Browser options stay each route's own; this
 * sets only what the edge does, in `s-maxage` and `CDN-Cache-Control`.
 *
 * - **60 s fresh** at the edge, so one URL reaches the API about once a minute
 *   however many people load it.
 * - **60 s stale-while-revalidate**: the first request after expiry is answered
 *   from the edge while Cloudflare refetches, so a busy page never waits on
 *   the origin, and nothing is shown more than about two minutes old.
 * - **1 h stale-if-error**: while the API is down or answering 5xx, the pages
 *   keep their last good answer instead of an error.
 *
 * It deliberately does **not** set `visibility`. A request carrying
 * `Authorization` is still downgraded to `private` with `CDN-Cache-Control:
 * no-store` (`CacheHeaderInterceptor`), so a signed-in request can neither
 * fill nor be told to fill the shared cache. The web app sends these reads
 * without a token for exactly that reason.
 *
 * Not for anything whose staleness is itself the failure: proof of reserves
 * and the demo verdict poll keep their own options.
 */
export const PUBLIC_EDGE_CACHE = {
  cdnMaxAge: 60,
  cdnStaleWhileRevalidate: 60,
  cdnStaleIfError: 3600,
} as const satisfies CacheHeaderOptions;
