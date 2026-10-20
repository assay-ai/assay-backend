import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';

import { CacheHeader, NoCacheHeader } from '@shared/decorators/cache-header.decorator';
import { CacheHeaderInterceptor } from '@shared/interceptors/cache-header.interceptor';
import { PublicReservesController } from '@modules/settlement/controllers/public-reserves.controller';
import { PublicCatalogueController } from '@modules/catalogue/controllers/public-catalogue.controller';
import { PublicToolsetsController } from '@modules/toolset/controllers/public-toolsets.controller';

/**
 * Browser caching is opt-in per route.
 *
 * A GET without `@CacheHeader` used to inherit `max-age=10,
 * stale-while-revalidate=3600`, so the browser answered the refetch that
 * follows a write with the pre-write body (BUG-SYS-01). These tests pin the
 * default to `private, no-cache` and check the deliberate opt-ins are untouched.
 */
class Routes {
  undecorated(): void {}

  @CacheHeader({ maxAge: 60, staleWhileRevalidate: 0, staleIfError: 0, mustRevalidate: true })
  optedIn(): void {}

  @NoCacheHeader()
  noCache(): void {}
}

function run(
  handler: (...args: never[]) => unknown,
  {
    method = 'GET',
    requestHeaders = {},
    config = {},
  }: {
    method?: string;
    requestHeaders?: Record<string, string>;
    config?: Record<string, unknown>;
  } = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    getHeader: (name: string) => headers[name],
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ method, headers: requestHeaders }),
      getResponse: () => response,
    }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;

  const interceptor = new CacheHeaderInterceptor(
    new Reflector(),
    new ConfigService({ app: { api: config } }),
  );
  interceptor.intercept(context, { handle: () => of({ ok: true }) }).subscribe(() => undefined);
  return headers;
}

const AUTH = { authorization: 'Bearer token' };

describe('CacheHeaderInterceptor', () => {
  describe('GET without a cache decorator', () => {
    it('is private, no-cache for an authenticated request — never served stale', () => {
      const headers = run(Routes.prototype.undecorated, { requestHeaders: AUTH });

      expect(headers['Cache-Control']).toBe('private, no-cache');
      expect(headers['CDN-Cache-Control']).toBe('no-store');
      expect(headers['Vary']).toBe('Accept-Encoding, Authorization');
    });

    it('is private, no-cache for an anonymous request too', () => {
      const headers = run(Routes.prototype.undecorated);

      expect(headers['Cache-Control']).toBe('private, no-cache');
      expect(headers['CDN-Cache-Control']).toBe('no-store');
    });

    it('never grants max-age or a stale window', () => {
      const cacheControl = run(Routes.prototype.undecorated, { requestHeaders: AUTH })[
        'Cache-Control'
      ];

      expect(cacheControl).not.toMatch(/max-age=[1-9]/);
      expect(cacheControl).not.toContain('stale-while-revalidate');
      expect(cacheControl).not.toContain('stale-if-error');
      expect(cacheControl).not.toContain('public');
    });

    it('stays no-cache when CDN caching is enabled — the CDN is still told no-store', () => {
      const headers = run(Routes.prototype.undecorated, { config: { cdnCacheEnabled: true } });

      expect(headers['CDN-Cache-Control']).toBe('no-store');
    });

    it('uses the hard no-store form when BROWSER_CACHE_ENABLED=false', () => {
      const headers = run(Routes.prototype.undecorated, {
        requestHeaders: AUTH,
        config: { browserCacheEnabled: false },
      });

      expect(headers['Cache-Control']).toContain('no-store');
    });
  });

  describe('GET with a deliberate opt-in', () => {
    it('keeps the declared public directives for an anonymous request', () => {
      const headers = run(Routes.prototype.optedIn);

      expect(headers['Cache-Control']).toBe('public, max-age=60, must-revalidate');
      expect(headers['CDN-Cache-Control']).toBe('max-age=60');
    });

    it('keeps the declared freshness but downgrades to private when credentialed', () => {
      const headers = run(Routes.prototype.optedIn, { requestHeaders: AUTH });

      expect(headers['Cache-Control']).toBe('private, max-age=60, must-revalidate');
      expect(headers['CDN-Cache-Control']).toBe('no-store');
    });

    it('leaves the public reserves endpoint publicly cacheable', () => {
      const headers = run(PublicReservesController.prototype.get);

      expect(headers['Cache-Control']).toMatch(/^public, max-age=30/);
      expect(headers['CDN-Cache-Control']).toMatch(/^max-age=/);
    });
  });

  describe('writes', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s is no-store', (method) => {
      const headers = run(Routes.prototype.undecorated, { method, requestHeaders: AUTH });

      expect(headers['Cache-Control']).toContain('no-store');
      expect(headers['CDN-Cache-Control']).toBe('no-store');
    });

    it('@NoCacheHeader() still wins on any method', () => {
      const headers = run(Routes.prototype.noCache, { requestHeaders: AUTH });

      expect(headers['Cache-Control']).toContain('no-store');
      expect(headers['Pragma']).toBe('no-cache');
    });
  });

  /**
   * The public reads Cloudflare caches (`PUBLIC_EDGE_CACHE`): a minute at the
   * edge with a short stale window, while the browser keeps its own 30 s.
   */
  describe('the public edge window', () => {
    it.each([
      ['toolsets', PublicToolsetsController.prototype.list],
      ['catalogue tools', PublicCatalogueController.prototype.listTools],
    ])(
      '%s: 60 s at the edge, revalidated in the background, kept through an outage',
      (_, route) => {
        const headers = run(route);

        expect(headers['Cache-Control']).toBe('public, max-age=30, s-maxage=60, must-revalidate');
        expect(headers['CDN-Cache-Control']).toBe(
          'max-age=60, stale-while-revalidate=60, stale-if-error=3600',
        );
      },
    );

    it('is still private and kept out of the CDN for a credentialed request', () => {
      const headers = run(PublicToolsetsController.prototype.list, { requestHeaders: AUTH });

      expect(headers['Cache-Control']).toBe('private, max-age=30, must-revalidate');
      expect(headers['CDN-Cache-Control']).toBe('no-store');
    });

    it('leaves proof of reserves with no stale window at the edge', () => {
      const headers = run(PublicReservesController.prototype.get);

      expect(headers['CDN-Cache-Control']).toBe('max-age=30');
    });
  });
});
