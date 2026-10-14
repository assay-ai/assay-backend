import { Logger } from '@nestjs/common';

import { OperatorErrors } from '@modules/operator/errors/operator.errors';
import {
  OPERATOR_AUTH_FAILURE_WINDOW_SECONDS,
  OPERATOR_AUTH_MAX_FAILURES,
  OperatorAuthThrottle,
} from '@modules/operator/services/operator-auth-throttle.service';
import { OperatorAuthGuard } from '@shared/auth';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/** The Redis commands the throttle uses, in memory. */
class FakeRedis {
  readonly counts = new Map<string, number>();
  readonly ttl = new Map<string, number>();
  down = false;

  /** `SET key value EX seconds NX`, the only form the throttle sends. */
  async set(key: string, value: number, _ex: 'EX', seconds: number, _nx: 'NX'): Promise<'OK' | null> {
    if (this.down) throw new Error('redis down');
    if (this.counts.has(key)) return null;
    this.counts.set(key, Number(value));
    this.ttl.set(key, seconds);
    return 'OK';
  }

  multi() {
    const queued: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (key: string, value: number, ex: 'EX', seconds: number, nx: 'NX') => {
        queued.push(() => this.set(key, value, ex, seconds, nx));
        return chain;
      },
      incr: (key: string) => {
        queued.push(() => this.incr(key));
        return chain;
      },
      exec: async () => {
        const results: unknown[] = [];
        for (const run of queued) results.push([null, await run()]);
        return results;
      },
    };
    return chain;
  }

  async get(key: string): Promise<string | null> {
    if (this.down) throw new Error('redis down');
    const value = this.counts.get(key);
    return value === undefined ? null : String(value);
  }

  async incr(key: string): Promise<number> {
    if (this.down) throw new Error('redis down');
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  /** Never needed: the window's TTL is set with the count (N-4). */
  async expire(): Promise<number> {
    throw new Error('expire is not atomic with incr');
  }
}

function contextFor(headers: Record<string, string>, ip = '203.0.113.7') {
  const request = { headers, ip } as Record<string, unknown>;
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }) } as never,
  };
}

const SESSION = { operatorId: 'op-1', subject: 'dan@', roles: [] };

function build(resolve: (token: string | null) => Promise<unknown>) {
  const redis = new FakeRedis();
  const throttle = new OperatorAuthThrottle(redis as never);
  const guard = new OperatorAuthGuard({ resolve } as never, throttle);
  return { redis, guard };
}

describe('OperatorAuthGuard — failed sign-ins are counted per address', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const refuse = async () => {
    throw OperatorErrors.credentialInvalid();
  };

  it('answers 429 to an address over the limit that presents another bad token', async () => {
    const { guard, redis } = build(refuse);
    const { context } = contextFor({ authorization: 'Bearer wrong-token-value' });

    for (let attempt = 0; attempt < OPERATOR_AUTH_MAX_FAILURES; attempt += 1) {
      await expectErrorCodeAsync(() => guard.canActivate(context), 'OPERATOR_CREDENTIAL_INVALID');
    }
    await expectErrorCodeAsync(() => guard.canActivate(context), 'OPERATOR_AUTH_RATE_LIMITED');

    expect([...redis.ttl.values()]).toEqual([OPERATOR_AUTH_FAILURE_WINDOW_SECONDS]);
  });

  it('never refuses a valid session because its address is over the limit', async () => {
    const tokens = new Map([['good-token-value', SESSION]]);
    const { guard } = build(async (token) => {
      const session = token ? tokens.get(token) : undefined;
      if (!session) throw OperatorErrors.credentialInvalid();
      return session;
    });
    // Every caller behind one proxy shares this address.
    const bad = contextFor({ authorization: 'Bearer wrong-token-value' });
    for (let attempt = 0; attempt <= OPERATOR_AUTH_MAX_FAILURES; attempt += 1) {
      await guard.canActivate(bad.context).catch(() => undefined);
    }

    const good = contextFor({ authorization: 'Bearer good-token-value' });
    await expect(guard.canActivate(good.context)).resolves.toBe(true);
    expect(good.request.operator).toBe(SESSION);
  });

  it('logs one error line when the limit is reached, without the token', async () => {
    const { guard } = build(refuse);
    const { context } = contextFor({ authorization: 'Bearer wrong-token-value' });

    for (let attempt = 0; attempt < OPERATOR_AUTH_MAX_FAILURES; attempt += 1) {
      await guard.canActivate(context).catch(() => undefined);
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain('203.0.113.7');
    expect(line).not.toContain('wrong-token-value');
  });

  it('counts each address separately', async () => {
    const { guard } = build(refuse);
    const blocked = contextFor({ authorization: 'Bearer wrong-token-value' }, '203.0.113.7');
    const other = contextFor({ authorization: 'Bearer wrong-token-value' }, '198.51.100.9');

    for (let attempt = 0; attempt < OPERATOR_AUTH_MAX_FAILURES; attempt += 1) {
      await guard.canActivate(blocked.context).catch(() => undefined);
    }

    await expectErrorCodeAsync(
      () => guard.canActivate(other.context),
      'OPERATOR_CREDENTIAL_INVALID',
    );
  });

  it('does not count a request with no token, or a live session of an inactive operator', async () => {
    const missing = build(refuse);
    await missing.guard.canActivate(contextFor({}).context).catch(() => undefined);
    expect(missing.redis.counts.size).toBe(0);

    const suspended = build(async () => {
      throw OperatorErrors.notAuthorized();
    });
    await suspended.guard
      .canActivate(contextFor({ authorization: 'Bearer some-valid-token' }).context)
      .catch(() => undefined);
    expect(suspended.redis.counts.size).toBe(0);
  });

  it('attaches the session on success and counts nothing', async () => {
    const { guard, redis } = build(async () => SESSION);
    const { context, request } = contextFor({ authorization: 'Bearer good-token-value' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.operator).toBe(SESSION);
    expect(redis.counts.size).toBe(0);
  });

  it('gives every counter its window in the same transaction as the count (N-4)', async () => {
    const redis = new FakeRedis();
    const throttle = new OperatorAuthThrottle(redis as never);

    await throttle.countChallenge('ip:203.0.113.7');
    await throttle.countChallenge('ip:203.0.113.7');
    await throttle.recordFailure('ip:203.0.113.7');

    expect(redis.counts.get('operator:auth:challenges:ip:203.0.113.7')).toBe(2);
    expect(redis.counts.get('operator:auth:failures:ip:203.0.113.7')).toBe(1);
    expect([...redis.ttl.values()]).toEqual([
      OPERATOR_AUTH_FAILURE_WINDOW_SECONDS,
      OPERATOR_AUTH_FAILURE_WINDOW_SECONDS,
    ]);
  });

  it('fails open when Redis is down: the token is still checked', async () => {
    const { guard, redis } = build(async () => SESSION);
    redis.down = true;
    const { context } = contextFor({ authorization: 'Bearer good-token-value' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
