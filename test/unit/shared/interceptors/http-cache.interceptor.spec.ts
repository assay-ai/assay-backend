import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';

import { HttpCacheTTL } from '@shared/decorators/http-cache.decorator';
import { HttpCacheInterceptor } from '@shared/interceptors/http-cache.interceptor';

class Routes {
  @HttpCacheTTL(30)
  cached(): void {}
}

/** A Redis outage costs a cached public read one deadline per window, not one per request. */
describe('HttpCacheInterceptor during a Redis outage', () => {
  function context(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          path: '/api/v1/public/categories',
          query: {},
          headers: {},
        }),
        getResponse: () => ({ statusCode: 200 }),
      }),
      getHandler: () => Routes.prototype.cached,
    } as unknown as ExecutionContext;
  }

  it('answers from the handler and stops asking Redis for a few seconds after a failure', async () => {
    const cache = {
      get: jest.fn(() => Promise.reject(new Error('connection lost'))),
      set: jest.fn(() => Promise.resolve()),
    };
    const interceptor = new HttpCacheInterceptor(
      cache as never,
      new Reflector(),
      new ConfigService({ app: { api: {} } }),
    );
    const next = { handle: () => of({ categories: [] }) };

    await expect(lastValueFrom(await interceptor.intercept(context(), next))).resolves.toEqual({
      categories: [],
    });
    await lastValueFrom(await interceptor.intercept(context(), next));

    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });
});
