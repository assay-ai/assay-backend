import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom, of } from 'rxjs';

import { SESSION_REQUEST_KEY, isCredentialed, readCacheTenant } from '@shared/auth';
import { HTTP_CACHE_KEY_KEY, HTTP_CACHE_TTL_KEY } from '@shared/decorators/http-cache.decorator';
import { HttpCacheInterceptor } from '@shared/interceptors/http-cache.interceptor';

/**
 * The cross-tenant cache leak, pinned.
 *
 * `HttpCacheInterceptor` derived its cache key from `request.user`. The REST
 * surface's guard sets `request.session`, not `request.user`, so the identity
 * component of every key was `null` and the key collapsed to `path + query`.
 * Two organizations requesting the same resource id shared one entry, and the
 * second to ask received the first's body — a `200` carrying another tenant's
 * verdict, for the TTL.
 *
 * It was found by a mandatory cross-organization check and by
 * nothing else, because it is invisible unless two tenants request the same URL
 * within ten seconds. These tests are the reason it cannot return quietly.
 */

const ORG_A = '08773f92-21cd-4e53-8348-d3ef1dcc8378';
const ORG_B = 'b7c4e1a0-3f28-4d55-9c61-2a8e5f0d4b39';

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    path: '/api/v1/verdicts/6afd43e0',
    url: '/api/v1/verdicts/6afd43e0',
    query: {},
    headers: { authorization: 'Bearer token' },
    ...overrides,
  };
}

function sessionFor(organizationId: string, agentId = 'agent-1') {
  return { [SESSION_REQUEST_KEY]: { organizationId, agentId } };
}

describe('readCacheTenant', () => {
  it('reads the organization the guard resolved', () => {
    expect(readCacheTenant(request(sessionFor(ORG_A)))).toContain(ORG_A);
  });

  it('separates two organizations', () => {
    expect(readCacheTenant(request(sessionFor(ORG_A)))).not.toEqual(
      readCacheTenant(request(sessionFor(ORG_B))),
    );
  });

  // Not a tenant breach, but still a wrong answer served confidently:
  // `/spend-policy` resolves the calling agent's override before the org default.
  it('separates two agents inside one organization', () => {
    expect(readCacheTenant(request(sessionFor(ORG_A, 'agent-1')))).not.toEqual(
      readCacheTenant(request(sessionFor(ORG_A, 'agent-2'))),
    );
  });

  it.each([
    ['no session at all', {}],
    ['a session with no organization', { [SESSION_REQUEST_KEY]: {} }],
    ['a non-string organization', { [SESSION_REQUEST_KEY]: { organizationId: 42 } }],
    ['an empty organization', { [SESSION_REQUEST_KEY]: { organizationId: '' } }],
  ])('returns null for %s, so the caller fails closed', (_case, overrides) => {
    expect(readCacheTenant(request(overrides))).toBeNull();
  });

  it('never reads request.user in preference to the session', () => {
    // A `user` left over from another guard must not outrank the session that
    // actually authorised this surface.
    const mixed = request({ ...sessionFor(ORG_A), user: { id: 'someone-else' } });

    expect(readCacheTenant(mixed)).toContain(ORG_A);
  });
});

describe('isCredentialed', () => {
  it('is true when an Authorization header is present', () => {
    expect(isCredentialed(request())).toBe(true);
  });

  it('is false for an anonymous request', () => {
    expect(isCredentialed(request({ headers: {} }))).toBe(false);
  });
});

describe('HttpCacheInterceptor and the tenant boundary', () => {
  /**
   * Caching is opt-in, so a handler carrying no cache decorator returns before
   * a key is ever built and these tests would pass while asserting nothing.
   * The fake handler is therefore opted in with a TTL — the same thing
   * `@HttpCacheTTL(30)` does — so the tenant assertions below keep exercising
   * the caching path they were written to protect. Passing `{}` is the
   * undecorated route, used to prove the gate itself.
   */
  function interceptorWith(
    cache: { get: jest.Mock; set: jest.Mock },
    decorators: { ttl?: number; customKey?: string } = { ttl: 30 },
  ) {
    const config = { get: jest.fn().mockReturnValue(true) } as unknown as ConfigService;
    const reflector = {
      get: jest.fn((key: string) => {
        if (key === HTTP_CACHE_TTL_KEY) return decorators.ttl;
        if (key === HTTP_CACHE_KEY_KEY) return decorators.customKey;
        return undefined;
      }),
    } as unknown as Reflector;
    return new HttpCacheInterceptor(cache as never, reflector, config);
  }

  function spyCache() {
    return {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
  }

  function contextFor(req: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ statusCode: 200 }),
      }),
      getHandler: () => function handler() {},
    } as unknown as ExecutionContext;
  }

  it('keys two organizations to different cache entries', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = interceptorWith(cache);
    const next = { handle: () => of({ data: 'x' }) };

    await lastValueFrom(await interceptor.intercept(contextFor(request(sessionFor(ORG_A))), next));
    await lastValueFrom(await interceptor.intercept(contextFor(request(sessionFor(ORG_B))), next));

    const keys = cache.get.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
    expect(keys[0]).toContain(ORG_A);
    expect(keys[1]).toContain(ORG_B);
  });

  /**
   * The load-bearing assertion. A credentialed request whose tenant cannot be
   * read must not be cached *at all* — filing it under the shared key is what
   * produced the leak, and it is precisely the situation where a shared key is
   * most dangerous.
   */
  it('refuses to cache a credentialed request whose tenant cannot be read', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = interceptorWith(cache);
    const next = { handle: () => of({ data: 'x' }) };

    await lastValueFrom(await interceptor.intercept(contextFor(request()), next));

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('still caches an anonymous request, which has no tenant to cross', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const interceptor = interceptorWith(cache);
    const next = { handle: () => of({ data: 'x' }) };

    await lastValueFrom(await interceptor.intercept(contextFor(request({ headers: {} })), next));

    expect(cache.get).toHaveBeenCalled();
  });

  it('does not serve one organization the entry another organization stored', async () => {
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    };
    const interceptor = interceptorWith(cache);

    // A populates the cache with its own body.
    await lastValueFrom(
      await interceptor.intercept(contextFor(request(sessionFor(ORG_A))), {
        handle: () => of({ data: { secret: 'org A verdict' } }),
      }),
    );

    // B asks for the identical URL and must reach the handler, not the cache.
    let reachedHandler = false;
    const served = await lastValueFrom(
      await interceptor.intercept(contextFor(request(sessionFor(ORG_B))), {
        handle: () => {
          reachedHandler = true;
          return of({ data: null });
        },
      }),
    );

    expect(reachedHandler).toBe(true);
    expect(JSON.stringify(served)).not.toContain('org A verdict');
  });

  /**
   * The gate that makes every assertion above conditional.
   *
   * It shipped commented out with the scaffold, so caching was on for every GET
   * on the surface and `@HttpCacheTTL` merely changed a TTL. Nothing failed,
   * because no test ever asked whether an undecorated route was cached. These
   * do.
   */
  describe('caching is opt-in', () => {
    it('does not cache a GET whose handler carries no cache decorator', async () => {
      const cache = spyCache();
      const interceptor = interceptorWith(cache, {});
      const next = { handle: () => of({ data: 'x' }) };

      await lastValueFrom(
        await interceptor.intercept(contextFor(request(sessionFor(ORG_A))), next),
      );

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    // The undecorated anonymous GET is the case the broken gate cached most
    // freely: no tenant to refuse on, so nothing else in `intercept` stops it.
    it('does not cache an undecorated anonymous GET either', async () => {
      const cache = spyCache();
      const interceptor = interceptorWith(cache, {});
      const next = { handle: () => of({ data: 'x' }) };

      await lastValueFrom(await interceptor.intercept(contextFor(request({ headers: {} })), next));

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('caches a GET opted in with @HttpCacheTTL, at the TTL it asked for', async () => {
      const cache = spyCache();
      const interceptor = interceptorWith(cache, { ttl: 45 });
      const next = { handle: () => of({ data: 'x' }) };

      await lastValueFrom(
        await interceptor.intercept(contextFor(request(sessionFor(ORG_A))), next),
      );

      expect(cache.get).toHaveBeenCalled();
      expect(cache.set).toHaveBeenCalledWith(expect.any(String), { data: 'x' }, 45);
    });

    // `@HttpCacheKey` with no TTL is what `defaultTTLSeconds` is for — it is a
    // fallback for a route that opted in, not a surface-wide default.
    it('caches a GET opted in with @HttpCacheKey alone, at the default TTL', async () => {
      const cache = spyCache();
      const interceptor = interceptorWith(cache, { customKey: 'verdict-detail' });
      const next = { handle: () => of({ data: 'x' }) };

      await lastValueFrom(
        await interceptor.intercept(contextFor(request(sessionFor(ORG_A))), next),
      );

      expect(cache.set).toHaveBeenCalledWith(
        expect.stringContaining('verdict-detail'),
        { data: 'x' },
        10,
      );
    });
  });
});
