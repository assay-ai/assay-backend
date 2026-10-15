import {
  PUBLIC_READ_LIMIT,
  PUBLIC_READ_MAX_ADDRESSES,
  PUBLIC_READ_WINDOW_MS,
  PublicReadRateLimitInterceptor,
  clientKey,
} from '@shared/interceptors/public-read-rate-limit.interceptor';

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
