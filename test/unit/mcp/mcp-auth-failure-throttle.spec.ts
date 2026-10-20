import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpErrorCode, McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import {
  MCP_AUTH_FAILURE_WINDOW_SECONDS,
  MCP_AUTH_MAX_FAILURES,
  McpAuthFailureThrottle,
} from '@modules/mcp/services/mcp-auth-failure-throttle.service';
import { SHARED_WINDOW_RETRY_MS } from '@shared/interceptors/address-rate-limit.interceptor';

/**
 * Refused credentials on the MCP host, counted per address: an address over
 * the limit is refused before its token is looked up, a missing token is never
 * counted, and a Redis outage enforces nothing.
 */
describe('McpAuthFailureThrottle', () => {
  /** Enough of ioredis for `SET NX EX` + `INCR` and `GET` + `TTL`, in one `MULTI` each. */
  function fakeRedis() {
    const values = new Map<string, number>();
    const ttls = new Map<string, number>();
    const redis = {
      fail: false,
      multi: () => {
        const ops: Array<() => [null, unknown]> = [];
        const chain = {
          set: (key: string, value: number, _ex: string, seconds: number) => {
            ops.push(() => {
              if (values.has(key)) return [null, null];
              values.set(key, value);
              ttls.set(key, seconds);
              return [null, 'OK'];
            });
            return chain;
          },
          incr: (key: string) => {
            ops.push(() => {
              const next = (values.get(key) ?? 0) + 1;
              values.set(key, next);
              return [null, next];
            });
            return chain;
          },
          get: (key: string) => {
            ops.push(() => [null, values.has(key) ? String(values.get(key)) : null]);
            return chain;
          },
          ttl: (key: string) => {
            ops.push(() => [null, ttls.get(key) ?? -2]);
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
    return { redis, values };
  }

  it('is not blocked under the limit, and is once the limit is reached', async () => {
    const { redis } = fakeRedis();
    const throttle = new McpAuthFailureThrottle(redis as never);

    for (let i = 0; i < MCP_AUTH_MAX_FAILURES - 1; i += 1) await throttle.recordFailure('1.2.3.4');
    expect(await throttle.blockedForSeconds('1.2.3.4')).toBe(0);

    await throttle.recordFailure('1.2.3.4');
    expect(await throttle.blockedForSeconds('1.2.3.4')).toBe(MCP_AUTH_FAILURE_WINDOW_SECONDS);
    expect(await throttle.blockedForSeconds('5.6.7.8')).toBe(0);
  });

  it('keys an IPv6 client by its /64', async () => {
    const { redis, values } = fakeRedis();
    const throttle = new McpAuthFailureThrottle(redis as never);

    await throttle.recordFailure('2001:db8:1:2::1');
    await throttle.recordFailure('2001:db8:1:2::2');

    expect([...values.values()]).toEqual([2]);
  });

  it('fails open: a Redis outage blocks nobody and throws nothing', async () => {
    const { redis } = fakeRedis();
    redis.fail = true;
    const throttle = new McpAuthFailureThrottle(redis as never);

    await expect(throttle.recordFailure('1.2.3.4')).resolves.toBeUndefined();
    expect(await throttle.blockedForSeconds('1.2.3.4')).toBe(0);
  });

  it('skips Redis for a few seconds after a failure, so an outage costs no deadline per request', async () => {
    const { redis } = fakeRedis();
    const throttle = new McpAuthFailureThrottle(redis as never);
    let now = 1_000_000;
    throttle.now = () => now;
    const multi = jest.spyOn(redis, 'multi');

    redis.fail = true;
    await throttle.blockedForSeconds('1.2.3.4');
    redis.fail = false;
    await throttle.blockedForSeconds('1.2.3.4');
    await throttle.recordFailure('1.2.3.4');
    expect(multi).toHaveBeenCalledTimes(1);

    now += SHARED_WINDOW_RETRY_MS;
    await throttle.blockedForSeconds('1.2.3.4');
    expect(multi).toHaveBeenCalledTimes(2);
  });
});

describe('the MCP catch-all and the refused-credential throttle', () => {
  const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };

  function setup(blockedFor = 0, refusal: Error = McpErrors.credentialInvalid()) {
    const sessions = {
      resolve: jest.fn(() => Promise.reject(refusal)),
    } as unknown as McpSessionPort & { resolve: jest.Mock };
    const throttle = {
      blockedForSeconds: jest.fn(() => Promise.resolve(blockedFor)),
      recordFailure: jest.fn(() => Promise.resolve()),
    };
    const controller = new McpController(
      sessions,
      { create: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      HOST,
      undefined,
      throttle as never,
    );
    return { controller, sessions, throttle };
  }

  function call(authorization?: string) {
    const headers: Record<string, string> = {};
    const response = { setHeader: (name: string, value: string) => (headers[name] = value) };
    const request = {
      method: 'POST',
      originalUrl: '/',
      ip: '203.0.113.9',
      headers: authorization ? { authorization, accept: 'application/json' } : {},
    };
    return { request: request as never, response: response as never, headers };
  }

  it('counts a presented, refused token against the address', async () => {
    const { controller, throttle } = setup();
    const { request, response } = call('Bearer assay_sk_live_made_up');

    await expect(controller.handle(request, response)).rejects.toMatchObject({
      errorCode: McpErrorCode.MCP_CREDENTIAL_INVALID,
    });
    expect(throttle.recordFailure).toHaveBeenCalledWith('203.0.113.9');
  });

  it.each(['expired', 'revoked', 'audience'] as const)(
    'never counts a %s token — it was a real credential, and access tokens expire hourly',
    async (unauthorizedReason) => {
      const { controller, throttle } = setup(
        0,
        McpErrors.credentialInvalid({ unauthorizedReason }),
      );
      const { request, response } = call('Bearer assay_at_x');

      await expect(controller.handle(request, response)).rejects.toMatchObject({
        errorCode: McpErrorCode.MCP_CREDENTIAL_INVALID,
      });
      expect(throttle.recordFailure).not.toHaveBeenCalled();
    },
  );

  it('never counts a request with no token — the first step of an OAuth sign-in', async () => {
    const { controller, throttle } = setup();
    const { request, response } = call();

    await expect(controller.handle(request, response)).rejects.toMatchObject({
      errorCode: McpErrorCode.MCP_CREDENTIAL_INVALID,
    });
    expect(throttle.recordFailure).not.toHaveBeenCalled();
  });

  it('refuses a blocked address with 429 and Retry-After, before any lookup', async () => {
    const { controller, sessions } = setup(120);
    const { request, response, headers } = call('Bearer assay_sk_live_made_up');

    await expect(controller.handle(request, response)).rejects.toMatchObject({
      errorCode: McpErrorCode.MCP_AUTH_RATE_LIMITED,
      statusCode: 429,
    });
    expect(headers['Retry-After']).toBe('120');
    expect(sessions.resolve).not.toHaveBeenCalled();
  });
});
