import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import {
  CacheHeaderOptions,
  CACHE_HEADER_KEY,
  NO_CACHE_HEADER_KEY,
} from '@shared/decorators/cache-header.decorator';
import { isCredentialed } from '@shared/auth/session-request.key';

/**
 * Interceptor that adds Cache-Control headers with SWR support
 * Optimized for Cloudflare CDN caching
 * Only applies to GET requests with 2xx status codes
 */
@Injectable()
export class CacheHeaderInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheHeaderInterceptor.name);

  private readonly defaultOptions: Required<
    Omit<
      CacheHeaderOptions,
      | 'additionalDirectives'
      | 'cdnMaxAge'
      | 'staleIfError'
      | 'cdnStaleWhileRevalidate'
      | 'cdnStaleIfError'
    >
  > & {
    cdnMaxAge: number | undefined;
    staleIfError: number | undefined;
    cdnStaleWhileRevalidate: number | undefined;
    cdnStaleIfError: number | undefined;
  } = {
    maxAge: 10, // Browser: 10s fresh
    staleWhileRevalidate: 3600, // Browser: 1 hour stale
    staleIfError: 3600, // Browser: 1 hour if error
    visibility: 'public',
    mustRevalidate: false,
    cloudflareCache: true,
    cdnMaxAge: undefined,
    cdnStaleWhileRevalidate: undefined,
    cdnStaleIfError: undefined,
  };

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse<Response>();
    const handler = context.getHandler();

    // Check if cache headers are explicitly disabled
    const noCacheHeader = this.reflector.get<boolean>(NO_CACHE_HEADER_KEY, handler);
    if (noCacheHeader) {
      // Set no-cache headers to prevent caching
      this.setNoCacheHeaders(response);
      return next.handle();
    }

    // Only apply to GET requests
    if (request.method !== 'GET') {
      return next.handle();
    }

    // Get cache header options from decorator
    const options = this.reflector.get<CacheHeaderOptions>(CACHE_HEADER_KEY, handler);

    return next.handle().pipe(
      tap((data) => {
        // Only set cache headers for successful responses (2xx) and non-error data
        if (this.shouldSetCacheHeaders(response, data)) {
          this.setCacheHeaders(response, options, isCredentialed(request));
        } else if (this.isErrorResponse(response, data)) {
          // Explicitly set no-cache for error responses
          this.setNoCacheHeaders(response);
        }
      }),
      catchError((error) => {
        // Don't set cache headers on errors
        // Ensure no-cache for error responses
        this.setNoCacheHeaders(response);
        return throwError(() => error);
      }),
    );
  }

  /**
   * @param credentialed whether the request carried an `Authorization` header.
   *   A credentialed response is downgraded to `private` and kept out of CDNs
   *   — see the block below.
   */
  private setCacheHeaders(
    response: Response,
    options?: CacheHeaderOptions,
    credentialed = false,
  ): void {
    const merged = this.mergeOptions(options);

    /**
     * A response to a credentialed request is `private`, always.
     *
     * The default here is `public`, which is right for the catalogue and the
     * proof-of-reserves endpoint and wrong for everything behind
     * `SessionAuthGuard`. RFC 9111 §3.5 says a shared cache must *not* store a
     * response to a request carrying `Authorization` — unless the response
     * explicitly opts back in, and `public` is exactly that opt-in. So the
     * default was disabling the one protection that applies automatically to
     * authenticated traffic.
     *
     * `Vary: Authorization` (set below) does mitigate this for a cache that
     * honours it. That is not a guarantee worth resting a tenant boundary on:
     * `Vary` is routinely narrowed or ignored by CDN configurations chasing hit
     * rates, and the failure mode is one tenant's balances served to another.
     * The header now says `private` so that no intermediary has to be trusted
     * to get it right.
     *
     * A route that genuinely wants shared caching while authenticated can still
     * ask, explicitly, via `@CacheHeader({ visibility: 'public' })` — a
     * deliberate act on one endpoint, rather than a default across all of them.
     */
    const config =
      credentialed && options?.visibility === undefined
        ? { ...merged, visibility: 'private' as const, cloudflareCache: false }
        : merged;

    // Check global cache configs
    const browserCacheEnabled = this.configService.get<boolean>(
      'app.api.browserCacheEnabled',
      true,
    );
    const cdnCacheEnabled = this.configService.get<boolean>('app.api.cdnCacheEnabled', true);

    // Build Cache-Control header for browser
    if (!browserCacheEnabled) {
      // Disable browser cache but allow CDN cache
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      this.logger.debug('Browser cache disabled globally');
    } else {
      // Normal browser cache
      const cacheControlValue = this.buildCacheControlHeader(config);
      response.setHeader('Cache-Control', cacheControlValue);
      this.logger.debug(`Browser cache headers set: ${cacheControlValue}`);
    }

    // Build CDN-Cache-Control header for Cloudflare (independent from browser cache)
    if (!cdnCacheEnabled) {
      // Explicitly disable CDN caching
      response.setHeader('CDN-Cache-Control', 'no-store');
      this.logger.debug('CDN cache disabled globally');
    } else if (config.cloudflareCache && config.visibility === 'public') {
      // Enable CDN caching
      const cdnCacheControl = this.buildCDNCacheControlHeader(config);
      response.setHeader('CDN-Cache-Control', cdnCacheControl);
      this.logger.debug(`CDN cache headers set: ${cdnCacheControl}`);
    } else {
      // Say no out loud rather than by omission. An absent `CDN-Cache-Control`
      // leaves the CDN to fall back on `Cache-Control`, and a CDN configured to
      // ignore `private` would then cache a tenant's response. Silence is not a
      // refusal.
      response.setHeader('CDN-Cache-Control', 'no-store');
      this.logger.debug('CDN cache suppressed for a private/credentialed response');
    }

    // Add Vary header to ensure proper caching with different request headers
    const existingVary = response.getHeader('Vary');
    if (!existingVary) {
      response.setHeader('Vary', 'Accept-Encoding, Authorization');
    }
  }

  /**
   * Set no-cache headers for error responses
   */
  private setNoCacheHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');

    // Also tell Cloudflare not to cache
    response.setHeader('CDN-Cache-Control', 'no-store');

    this.logger.debug('No-cache headers set for error response');
  }

  /**
   * Check if cache headers should be set
   */
  private shouldSetCacheHeaders(response: Response, data: any): boolean {
    // Check HTTP status code
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return false;
    }

    // Check if response data indicates an error
    if (this.isErrorResponse(response, data)) {
      return false;
    }

    return true;
  }

  /**
   * Check if response is an error response
   */
  private isErrorResponse(response: Response, data: any): boolean {
    // Check HTTP status code
    if (response.statusCode >= 400) {
      return true;
    }

    // Check if data contains error indicators
    if (data && typeof data === 'object') {
      // Check for error property
      if (data.error) {
        return true;
      }

      // Check for statusCode >= 400 in response data
      if (data.statusCode && data.statusCode >= 400) {
        return true;
      }

      // Check for success: false
      if (data.success === false) {
        return true;
      }
    }

    return false;
  }

  private mergeOptions(options?: CacheHeaderOptions): Required<
    Omit<
      CacheHeaderOptions,
      | 'additionalDirectives'
      | 'cdnMaxAge'
      | 'staleIfError'
      | 'cdnStaleWhileRevalidate'
      | 'cdnStaleIfError'
    >
  > & {
    additionalDirectives: string[];
    cdnMaxAge: number | undefined;
    staleIfError: number | undefined;
    cdnStaleWhileRevalidate: number | undefined;
    cdnStaleIfError: number | undefined;
  } {
    return {
      ...this.defaultOptions,
      ...options,
      additionalDirectives: options?.additionalDirectives || [],
      cdnMaxAge: options?.cdnMaxAge,
      staleIfError: options?.staleIfError ?? this.defaultOptions.staleIfError,
      cdnStaleWhileRevalidate: options?.cdnStaleWhileRevalidate,
      cdnStaleIfError: options?.cdnStaleIfError,
    };
  }

  private buildCacheControlHeader(
    config: Required<
      Omit<
        CacheHeaderOptions,
        | 'additionalDirectives'
        | 'cdnMaxAge'
        | 'staleIfError'
        | 'cdnStaleWhileRevalidate'
        | 'cdnStaleIfError'
      >
    > & {
      additionalDirectives: string[];
      cdnMaxAge: number | undefined;
      staleIfError: number | undefined;
      cdnStaleWhileRevalidate: number | undefined;
      cdnStaleIfError: number | undefined;
    },
  ): string {
    const directives: string[] = [];

    // Visibility
    directives.push(config.visibility);

    // Max age (browser cache)
    directives.push(`max-age=${config.maxAge}`);

    // s-maxage (CDN/proxy cache) - Cloudflare respects this
    // If cdnMaxAge is set, use it; otherwise CDN will use max-age
    if (config.cdnMaxAge !== undefined) {
      directives.push(`s-maxage=${config.cdnMaxAge}`);
    }

    // Stale-while-revalidate (for browser)
    if (config.staleWhileRevalidate > 0) {
      directives.push(`stale-while-revalidate=${config.staleWhileRevalidate}`);
    }

    // Stale-if-error (for browser) - serve stale content when origin returns error
    if (config.staleIfError !== undefined && config.staleIfError > 0) {
      directives.push(`stale-if-error=${config.staleIfError}`);
    }

    // Must revalidate
    if (config.mustRevalidate) {
      directives.push('must-revalidate');
    }

    // Additional directives
    if (config.additionalDirectives.length > 0) {
      directives.push(...config.additionalDirectives);
    }

    return directives.join(', ');
  }

  /**
   * Build CDN-Cache-Control header for Cloudflare
   * This header takes precedence over Cache-Control for CDN caching
   * CDN typically has longer stale times than browser to reduce origin load
   */
  private buildCDNCacheControlHeader(
    config: Required<
      Omit<
        CacheHeaderOptions,
        | 'additionalDirectives'
        | 'cdnMaxAge'
        | 'staleIfError'
        | 'cdnStaleWhileRevalidate'
        | 'cdnStaleIfError'
      >
    > & {
      cdnMaxAge: number | undefined;
      staleIfError: number | undefined;
      cdnStaleWhileRevalidate: number | undefined;
      cdnStaleIfError: number | undefined;
    },
  ): string {
    const directives: string[] = [];

    // Use cdnMaxAge if set, otherwise use maxAge
    const cdnTTL = config.cdnMaxAge ?? config.maxAge;
    directives.push(`max-age=${cdnTTL}`);

    // CDN stale-while-revalidate: use cdnStaleWhileRevalidate if set, otherwise use browser value
    const cdnSWR = config.cdnStaleWhileRevalidate ?? config.staleWhileRevalidate;
    if (cdnSWR > 0) {
      directives.push(`stale-while-revalidate=${cdnSWR}`);
    }

    // CDN stale-if-error: use cdnStaleIfError if set, otherwise use browser value
    const cdnSIE = config.cdnStaleIfError ?? config.staleIfError;
    if (cdnSIE !== undefined && cdnSIE > 0) {
      directives.push(`stale-if-error=${cdnSIE}`);
    }

    return directives.join(', ');
  }
}
