import {
  PUBLIC_READ_LIMIT,
  PUBLIC_READ_MAX_ADDRESSES,
  PUBLIC_READ_WINDOW_MS,
  PublicReadRateLimitInterceptor,
  clientKey,
} from '@shared/interceptors/public-read-rate-limit.interceptor';
import { SHARED_WINDOW_RETRY_MS } from '@shared/interceptors/address-rate-limit.interceptor';
import { lastValueFrom, of } from 'rxjs';

/** The per-client window on the public Explorer reads. */
describe('PublicReadRateLimitInterceptor', () => {
  function limiter(start = 1_000_000) {
    const interceptor = new PublicReadRateLimitInterceptor();
    let now = start;
    interceptor.now = () => now;
    return { interceptor, advance: (ms: number) => (now += ms) };
  }

  const windows = (interceptor: PublicReadRateLimitInterceptor) =>
    (interceptor as unknown as { windows: Map<string, unknown> }).windows;

  it('allows the limit and refuses the next request from the same client', () => {
    const { interceptor } = limiter();

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) {
      expect(interceptor.take('1.2.3.4').allowed).toBe(true);
    }
    expect(interceptor.take('1.2.3.4').allowed).toBe(false);
    expect(interceptor.take('5.6.7.8').allowed).toBe(true);
  });

  it('opens a fresh window once the old one has passed', () => {
    const { interceptor, advance } = limiter();

    for (let i = 0; i <= PUBLIC_READ_LIMIT; i += 1) interceptor.take('1.2.3.4');
    advance(PUBLIC_READ_WINDOW_MS);

    expect(interceptor.take('1.2.3.4').allowed).toBe(true);
  });

  it('answers 429 with Retry-After set to the seconds left in the window', () => {
    const { interceptor, advance } = limiter();
    const headers: Record<string, string> = {};
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ ip: '9.9.9.9' }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => (headers[name] = value),
        }),
      }),
    } as never;
    const next = { handle: jest.fn() };

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) interceptor.intercept(context, next);
    advance(15_500);

    expect(() => interceptor.intercept(context, next)).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    expect(headers['Retry-After']).toBe('45');
    expect(next.handle).toHaveBeenCalledTimes(PUBLIC_READ_LIMIT);
  });

  it('stays bounded under a flood of distinct clients, evicting the oldest first', () => {
    const { interceptor, advance } = limiter();

    interceptor.take('first');
    advance(1);
    for (let i = 0; i < PUBLIC_READ_MAX_ADDRESSES + 50; i += 1) interceptor.take(`10.0.${i}`);

    expect(windows(interceptor).size).toBeLessThanOrEqual(PUBLIC_READ_MAX_ADDRESSES);
    expect(windows(interceptor).has('first')).toBe(false);
    // The newest clients keep their windows — no wholesale reset.
    expect(windows(interceptor).has(`10.0.${PUBLIC_READ_MAX_ADDRESSES + 49}`)).toBe(true);
  });
});

/**
 * The shared window: one count in Redis across every instance, and the
 * in-process window when Redis does not answer.
 */
describe('PublicReadRateLimitInterceptor with Redis', () => {
  /** Enough of ioredis for `MULTI INCR PEXPIRE EXEC`, over one shared map. */
  function fakeRedis(store = new Map<string, number>()) {
    const redis = {
      fail: false,
      multi: () => {
        const ops: Array<() => [null, number]> = [];
        const chain = {
          incr: (key: string) => {
            ops.push(() => {
              const next = (store.get(key) ?? 0) + 1;
              store.set(key, next);
              return [null, next];
            });
            return chain;
          },
          pexpire: () => {
            ops.push(() => [null, 1]);
            return chain;
          },
          exec: () =>
            redis.fail
              ? Promise.reject(new Error('connection lost'))
              : Promise.resolve(ops.map((op) => op())),
        };
        return chain;
      },
    };
    return { redis, store };
  }

  function limiter(redis: unknown, start = 6_000_000) {
    const interceptor = new PublicReadRateLimitInterceptor(redis as never);
    let now = start;
    interceptor.now = () => now;
    return { interceptor, advance: (ms: number) => (now += ms) };
  }

  it('counts one window across instances, so N replicas do not allow N × the limit', async () => {
    const { redis } = fakeRedis();
    const a = limiter(redis).interceptor;
    const b = limiter(redis).interceptor;

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) {
      expect((await (i % 2 ? a : b).takeShared('1.2.3.4')).allowed).toBe(true);
    }
    expect((await a.takeShared('1.2.3.4')).allowed).toBe(false);
    expect((await b.takeShared('1.2.3.4')).allowed).toBe(false);
    expect((await a.takeShared('5.6.7.8')).allowed).toBe(true);
  });

  it('keys each window by its index, so a lost expiry cannot outlive the window', async () => {
    const { redis, store } = fakeRedis();
    const { interceptor, advance } = limiter(redis);

    for (let i = 0; i <= PUBLIC_READ_LIMIT; i += 1) await interceptor.takeShared('1.2.3.4');
    advance(PUBLIC_READ_WINDOW_MS);

    expect((await interceptor.takeShared('1.2.3.4')).allowed).toBe(true);
    expect([...store.keys()].every((key) => key.startsWith('rate:public-read:1.2.3.4:'))).toBe(
      true,
    );
  });

  it('answers Retry-After with the seconds left in the shared window', async () => {
    const { redis } = fakeRedis();
    // 15.5 s into a window.
    const { interceptor } = limiter(redis, 100 * PUBLIC_READ_WINDOW_MS + 15_500);

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) await interceptor.takeShared('9.9.9.9');

    expect(await interceptor.takeShared('9.9.9.9')).toEqual({
      allowed: false,
      retryAfterSeconds: 45,
    });
  });

  it('falls back to the in-process window when Redis fails — still a limit, not an outage', async () => {
    const { redis } = fakeRedis();
    redis.fail = true;
    const { interceptor } = limiter(redis);

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) {
      expect((await interceptor.takeShared('1.2.3.4')).allowed).toBe(true);
    }
    expect((await interceptor.takeShared('1.2.3.4')).allowed).toBe(false);
  });

  it('skips Redis for a few seconds after a failure, then asks it again', async () => {
    const { redis, store } = fakeRedis();
    const { interceptor, advance } = limiter(redis);
    redis.fail = true;
    await interceptor.takeShared('1.2.3.4');
    redis.fail = false;

    await interceptor.takeShared('1.2.3.4');
    expect(store.size).toBe(0);

    advance(SHARED_WINDOW_RETRY_MS);
    await interceptor.takeShared('1.2.3.4');
    expect(store.size).toBe(1);
  });

  it('refuses through intercept with 429 and Retry-After', async () => {
    const { redis } = fakeRedis();
    const { interceptor } = limiter(redis);
    const headers: Record<string, string> = {};
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ ip: '9.9.9.9' }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => (headers[name] = value),
        }),
      }),
    } as never;
    const next = { handle: jest.fn(() => of('ok')) };

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) {
      await lastValueFrom(interceptor.intercept(context, next));
    }

    await expect(lastValueFrom(interceptor.intercept(context, next))).rejects.toEqual(
      expect.objectContaining({ status: 429 }),
    );
    expect(headers['Retry-After']).toBeDefined();
    expect(next.handle).toHaveBeenCalledTimes(PUBLIC_READ_LIMIT);
  });
});

describe('clientKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:85a3:12:8a2e:370:7334:1', '2001:db8:85a3:12::/64'],
    ['2001:db8:85a3:12::ffff', '2001:db8:85a3:12::/64'],
    ['2001:DB8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    [undefined, 'unknown'],
  ])('%s → %s', (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });

  it('gives every address inside one /64 the same limit', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  });
});
