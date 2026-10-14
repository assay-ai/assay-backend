import {
  PUBLIC_READ_LIMIT,
  PUBLIC_READ_MAX_ADDRESSES,
  PUBLIC_READ_WINDOW_MS,
  PublicReadRateLimitInterceptor,
} from '@shared/interceptors/public-read-rate-limit.interceptor';

/** The per-address window on the public Explorer reads. */
describe('PublicReadRateLimitInterceptor', () => {
  function limiter(start = 1_000_000) {
    const interceptor = new PublicReadRateLimitInterceptor();
    let now = start;
    interceptor.now = () => now;
    return { interceptor, advance: (ms: number) => (now += ms) };
  }

  it('allows the limit and refuses the next request from the same address', () => {
    const { interceptor } = limiter();

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) expect(interceptor.take('1.2.3.4')).toBe(true);
    expect(interceptor.take('1.2.3.4')).toBe(false);
    // Another address has its own window.
    expect(interceptor.take('5.6.7.8')).toBe(true);
  });

  it('opens a fresh window once the old one has passed', () => {
    const { interceptor, advance } = limiter();

    for (let i = 0; i <= PUBLIC_READ_LIMIT; i += 1) interceptor.take('1.2.3.4');
    advance(PUBLIC_READ_WINDOW_MS);

    expect(interceptor.take('1.2.3.4')).toBe(true);
  });

  it('answers 429 through the interceptor', () => {
    const { interceptor } = limiter();
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ ip: '9.9.9.9' }) }),
    } as never;
    const next = { handle: jest.fn() };

    for (let i = 0; i < PUBLIC_READ_LIMIT; i += 1) interceptor.intercept(context, next);

    expect(() => interceptor.intercept(context, next)).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    expect(next.handle).toHaveBeenCalledTimes(PUBLIC_READ_LIMIT);
  });

  it('stays bounded under a flood of distinct addresses', () => {
    const { interceptor } = limiter();

    for (let i = 0; i < PUBLIC_READ_MAX_ADDRESSES + 50; i += 1) interceptor.take(`10.0.${i}`);

    const size = (interceptor as unknown as { windows: Map<string, unknown> }).windows.size;
    expect(size).toBeLessThanOrEqual(PUBLIC_READ_MAX_ADDRESSES);
  });
});
