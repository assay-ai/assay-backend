import { HttpException, Logger } from '@nestjs/common';
import { Subject, lastValueFrom, of } from 'rxjs';

import { McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import { REDIS_REQUEST_TIMEOUT_MS } from '@shared/cache/redis-cache/with-redis-timeout';
import { SHARED_WINDOW_RETRY_MS, SharedRateWindows } from '@shared/rate-limit/shared-rate-windows';
import {
  HEAVY_READ_LIMIT,
  PER_ITEM_WRITE_LIMIT,
  READ_RULE,
  ROUTE_RULES,
  WRITE_RULE,
  parseUserRateLimitsEnabled,
} from '@shared/rate-limit/user-rate-limit.config';
import {
  UserRateLimitInterceptor,
  decide,
  routePath,
} from '@shared/rate-limit/user-rate-limit.interceptor';

import { fakeRateRedis } from './fake-rate-redis';

const ORG = 'org-1';

/** A person's console session: their agent in their organization. */
const person = (agentId = 'agent-alice', organizationId = ORG) => ({
  session: {
    credentialId: `privy:${agentId}`,
    organizationId,
    agentId,
    agentAccount: `eip155:46630:0x${agentId.padEnd(40, '0').slice(0, 40)}`,
    chainId: 'eip155:46630',
    label: null,
    callerKind: McpCallerKind.HUMAN,
    paymentsAllowed: true,
  },
});

/** An agent API key (or an OAuth grant): its credential. */
const apiKey = (credentialId = 'cred-1', agentId = 'agent-bot') => ({
  session: { ...person(agentId).session, credentialId, callerKind: McpCallerKind.AGENT },
});

const operator = (operatorId = 'op-1') => ({ operator: { operatorId, roles: [] } });

type Caller = { session?: unknown; operator?: unknown; ip?: string };

/** A request as Express hands it over once a route matched and the guard ran. */
function request(method: string, path: string, caller: Caller = person(), concrete = path) {
  return {
    method,
    route: { path: `/api/v1${path}` },
    path: `/api/v1${concrete}`,
    ip: caller.ip ?? '203.0.113.7',
    ...caller,
  } as never;
}

function context(req: unknown) {
  const headers: Record<string, string> = {};
  return {
    headers,
    ctx: {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({
          setHeader: (name: string, value: string) => (headers[name] = value),
        }),
      }),
    } as never,
  };
}

function limiter(redis?: unknown, start = 7_000_020, enabled = true) {
  const interceptor = new UserRateLimitInterceptor(redis as never, enabled);
  let now = start;
  interceptor.now = () => now;
  return { interceptor, advance: (ms: number) => (now += ms) };
}

/** Run one request through the interceptor: its status as a client would see it. */
async function send(
  interceptor: UserRateLimitInterceptor,
  req: unknown,
  handler = () => of('ok'),
): Promise<{ status: number; retryAfter?: string }> {
  const { ctx, headers } = context(req);
  try {
    await lastValueFrom(interceptor.intercept(ctx, { handle: handler }));
    return { status: 200 };
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), retryAfter: headers['Retry-After'] };
    }
    throw error;
  }
}

async function sendMany(
  interceptor: UserRateLimitInterceptor,
  n: number,
  req: () => unknown,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) statuses.push((await send(interceptor, req())).status);
  return statuses;
}

describe('UserRateLimitInterceptor: which window a request counts against', () => {
  it('keys a person by organization and agent, an API key by credential, an operator by id', () => {
    expect(decide(request('GET', '/tool-calls'))).toMatchObject({
      rule: READ_RULE,
      subject: `person:${ORG}:agent-alice`,
    });
    expect(decide(request('GET', '/tool-calls', apiKey('cred-9')))).toMatchObject({
      rule: READ_RULE,
      subject: 'cred:cred-9',
    });
    expect(decide(request('GET', '/operator/me', operator('op-7')))).toMatchObject({
      rule: READ_RULE,
      subject: 'op:op-7',
    });
  });

  it('puts each category on its own bucket and subject', () => {
    const cases: Array<[string, string, Caller, string, string]> = [
      ['GET', '/balances', person(), 'heavy', `person:${ORG}:agent-alice`],
      ['GET', '/overview', person(), 'heavy', `person:${ORG}:agent-alice`],
      ['GET', '/operator/health', operator(), 'heavy', 'op:op-1'],
      ['GET', '/escrow/delegates', person(), 'heavy', `person:${ORG}:agent-alice`],
      [
        'PATCH',
        '/notifications/:id/read',
        person(),
        'notification-read',
        `person:${ORG}:agent-alice`,
      ],
      ['PUT', '/toolsets/:id/entries', person(), 'toolset-entries', `person:${ORG}:agent-alice`],
      ['POST', '/mcp-urls/preview', person(), 'read', `person:${ORG}:agent-alice`],
      ['POST', '/auth/wallet/link', { ip: '192.0.2.1' }, 'wallet-link', 'ip:192.0.2.1'],
      ['GET', '/providers/me/calls/export', person(), 'export', `org:${ORG}`],
      ['POST', '/toolsets', person(), 'write', `person:${ORG}:agent-alice`],
      ['PATCH', '/agents/:agentId', person(), 'write', `person:${ORG}:agent-alice`],
      ['POST', '/agents/:agentId/credentials', person(), 'credential-mint', `org:${ORG}`],
      ['POST', '/tool-requests', apiKey(), 'tool-request', `org:${ORG}`],
      ['PUT', '/org/handle', person(), 'handle', `org:${ORG}`],
      ['POST', '/providers', person(), 'provider-register', `org:${ORG}`],
      ['POST', '/deposits', person(), 'deposit', `acct:${person().session.agentAccount}`],
      [
        'POST',
        '/deposits/:depositId/broadcast',
        person(),
        'deposit-confirm',
        `acct:${person().session.agentAccount}`,
      ],
      ['POST', '/escrow/debts/:intentId/voucher', apiKey('cred-3'), 'debt-voucher', 'cred:cred-3'],
      ['POST', '/providers/me/stake/unstake-intent', person(), 'stake-intent', `org:${ORG}`],
      [
        'POST',
        '/operator/arbiter/ruling-intent',
        operator('op-2'),
        'arbiter-ruling-intent',
        'op:op-2',
      ],
      // Debounced while the provider types: a window of its own.
      [
        'POST',
        '/providers/me/tool-bindings/validate-mapping',
        person(),
        'validate-mapping',
        `person:${ORG}:agent-alice`,
      ],
    ];
    for (const [method, path, caller, bucket, subject] of cases) {
      expect([path, decide(request(method, path, caller))]).toEqual([
        path,
        expect.objectContaining({ rule: expect.objectContaining({ bucket }), subject }),
      ]);
    }
  });

  it('counts the wallet link by client address, before any session exists', () => {
    expect(decide(request('POST', '/auth/wallet/link', { ip: '198.51.100.4' }))).toMatchObject({
      rule: ROUTE_RULES['POST /auth/wallet/link'],
      subject: 'ip:198.51.100.4',
    });
  });

  it('leaves exempt routes, own-limiter routes and callers no guard identified alone', () => {
    const anonymous: Caller = {};
    for (const [method, path, caller] of [
      ['GET', '/public/toolsets', anonymous],
      ['GET', '/public/catalogue/tools', person()],
      ['GET', '/health', anonymous],
      ['GET', '/.well-known/assay-request-keys.json', anonymous],
      ['GET', '/oauth/requests/:rid', person()],
      ['POST', '/oauth/requests/:rid/approve', person()],
      ['POST', '/operator/auth/verify', anonymous],
      ['GET', '/escrow/next-seq', apiKey()],
      ['POST', '/escrow/debts/:intentId/voucher-intent', apiKey()],
      ['POST', '/escrow/limits', person()],
      ['OPTIONS', '/balances', person()],
      // A route that would count, but the request carries no caller.
      ['GET', '/balances', anonymous],
      ['POST', '/toolsets', anonymous],
    ] as const) {
      expect([method, path, decide(request(method, path, caller))]).toEqual([method, path, null]);
    }
  });

  it('reads the route Express matched, without the global prefix and version', () => {
    expect(routePath({ route: { path: '/api/v1/deposits/:depositId' } } as never)).toBe(
      '/deposits/:depositId',
    );
    expect(routePath({ route: { path: '/api/health' } } as never)).toBe('/health');
    expect(routePath({ path: '/api/v1/toolsets/' } as never)).toBe('/toolsets');
    // HEAD is the GET route's window.
    expect(decide(request('HEAD', '/balances'))?.key).toBe(
      `heavy:/balances:person:${ORG}:agent-alice`,
    );
  });

  it('keys a heavy read by its concrete path, and counts it in the read window too', () => {
    expect(
      decide(request('GET', '/agents/:agentId/servers', person(), '/agents/agent-7/servers')),
    ).toMatchObject({
      key: `heavy:/agents/agent-7/servers:person:${ORG}:agent-alice`,
      readKey: `read:person:${ORG}:agent-alice`,
    });
    expect(decide(request('GET', '/tool-calls'))?.readKey).toBeUndefined();
  });

  it('counts the dashboard’s /mcp-urls routes: only /mcp itself would be another app', () => {
    const preview = {
      method: 'POST',
      route: { path: '/api/v1/mcp-urls/preview' },
      path: '/api/v1/mcp-urls/preview',
      ...person(),
    } as never;
    expect(decide(preview)).toMatchObject({ rule: READ_RULE });
  });
});

describe('UserRateLimitInterceptor: windows', () => {
  it('allows the read limit, then answers 429 with the wait until a request would pass', async () => {
    const { interceptor, advance } = limiter();

    const statuses = await sendMany(interceptor, READ_RULE.limit, () =>
      request('GET', '/tool-calls'),
    );
    expect(statuses.every((status) => status === 200)).toBe(true);

    advance(15_000);
    // 45 s left in the window, and under a second into the next for the burst's weight to fall under the limit.
    expect(await send(interceptor, request('GET', '/tool-calls'))).toEqual({
      status: 429,
      retryAfter: '46',
    });
  });

  it('does not call the handler of a refused request', async () => {
    const { interceptor } = limiter();
    await sendMany(interceptor, WRITE_RULE.limit, () => request('POST', '/toolsets'));
    const handler = jest.fn(() => of('ok'));

    expect((await send(interceptor, request('POST', '/toolsets'), handler)).status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it('gives each heavy route its own window, apart from the read window', async () => {
    const { interceptor } = limiter();

    await sendMany(interceptor, HEAVY_READ_LIMIT, () => request('GET', '/balances'));
    expect((await send(interceptor, request('GET', '/balances'))).status).toBe(429);
    expect((await send(interceptor, request('GET', '/overview'))).status).toBe(200);
    expect((await send(interceptor, request('GET', '/tool-calls'))).status).toBe(200);
  });

  it('gives each agent card its own servers window', async () => {
    const { interceptor } = limiter();
    const servers = (agent: string) =>
      request('GET', '/agents/:agentId/servers', person(), `/agents/${agent}/servers`);

    await sendMany(interceptor, HEAVY_READ_LIMIT, () => servers('a1'));
    expect((await send(interceptor, servers('a1'))).status).toBe(429);
    expect((await send(interceptor, servers('a2'))).status).toBe(200);
  });

  it('bounds heavy reads with varying ids by the read window', async () => {
    const { interceptor } = limiter();
    let n = 0;
    const statuses = await sendMany(interceptor, READ_RULE.limit + 1, () =>
      request('GET', '/agents/:agentId/servers', person(), `/agents/a${(n += 1)}/servers`),
    );
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('allows /escrow/delegates 60 a minute: two 5 s timers on one page', async () => {
    const { interceptor } = limiter();
    const statuses = await sendMany(interceptor, 61, () => request('GET', '/escrow/delegates'));
    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
  });

  it('gives the per-item writes 120 a minute each, apart from the write window', async () => {
    const { interceptor } = limiter();
    for (const [method, path] of [
      ['PATCH', '/notifications/:id/read'],
      ['PUT', '/toolsets/:id/entries'],
      ['POST', '/providers/me/tool-bindings/validate-mapping'],
    ]) {
      const statuses = await sendMany(interceptor, PER_ITEM_WRITE_LIMIT + 1, () =>
        request(method, path),
      );
      expect([path, statuses.filter((status) => status === 200).length]).toEqual([
        path,
        PER_ITEM_WRITE_LIMIT,
      ]);
    }
    expect((await send(interceptor, request('POST', '/toolsets'))).status).toBe(200);
  });

  it('allows the wallet link 60 a minute from one address', async () => {
    const { interceptor } = limiter();
    const statuses = await sendMany(interceptor, 61, () =>
      request('POST', '/auth/wallet/link', { ip: '192.0.2.9' }),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
  });

  it('gives two people of one organization a window each, but one organization window', async () => {
    const { interceptor } = limiter();

    await sendMany(interceptor, WRITE_RULE.limit, () => request('POST', '/toolsets'));
    expect((await send(interceptor, request('POST', '/toolsets'))).status).toBe(429);
    expect(
      (await send(interceptor, request('POST', '/toolsets', person('agent-bob')))).status,
    ).toBe(200);

    // Credential minting is counted for the organization, whoever asks.
    const mint = (who: Caller) => request('POST', '/agents/:agentId/credentials', who);
    await sendMany(interceptor, 5, () => mint(person()));
    await sendMany(interceptor, 5, () => mint(person('agent-bob')));
    expect((await send(interceptor, mint(person('agent-carol')))).status).toBe(429);
    expect((await send(interceptor, mint(person('agent-dan', 'org-2')))).status).toBe(200);
  });

  it('allows again once the burst has slid out of the window', async () => {
    const { interceptor, advance } = limiter();
    await sendMany(interceptor, WRITE_RULE.limit + 1, () => request('POST', '/toolsets'));

    advance(WRITE_RULE.windowMs);
    expect((await send(interceptor, request('POST', '/toolsets'))).status).toBe(429);
    advance(WRITE_RULE.windowMs);
    expect((await send(interceptor, request('POST', '/toolsets'))).status).toBe(200);
  });

  it('holds tool requests to 20 a day for the organization', async () => {
    const { interceptor, advance } = limiter();
    const ask = () => request('POST', '/tool-requests');

    expect(await sendMany(interceptor, 20, ask)).toEqual(Array(20).fill(200));
    advance(23 * 60 * 60_000);
    expect((await send(interceptor, ask())).status).toBe(429);
  });

  it('counts nothing when turned off', async () => {
    const { interceptor } = limiter(undefined, 7_000_020, false);
    const statuses = await sendMany(interceptor, WRITE_RULE.limit * 3, () =>
      request('POST', '/toolsets'),
    );
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('reads API_USER_RATE_LIMITS_ENABLED as on unless it says false', () => {
    expect(parseUserRateLimitsEnabled(undefined)).toBe(true);
    expect(parseUserRateLimitsEnabled('')).toBe(true);
    expect(parseUserRateLimitsEnabled('true')).toBe(true);
    expect(parseUserRateLimitsEnabled(' FALSE ')).toBe(false);
  });
});

describe('UserRateLimitInterceptor: the export runs one at a time', () => {
  it('refuses a second export while the first is streaming, and frees the slot after', async () => {
    const { interceptor } = limiter();
    const exportReq = () => request('GET', '/providers/me/calls/export');
    const streaming = new Subject<string>();

    const first = send(interceptor, exportReq(), () => streaming);
    await new Promise((resolve) => setImmediate(resolve));

    expect(await send(interceptor, exportReq())).toEqual({ status: 429, retryAfter: '5' });
    // Another organization is not held up.
    expect(
      (await send(interceptor, request('GET', '/providers/me/calls/export', person('x', 'org-2'))))
        .status,
    ).toBe(200);

    streaming.next('csv');
    streaming.complete();
    expect((await first).status).toBe(200);
    expect((await send(interceptor, exportReq())).status).toBe(200);
  });

  it('frees the slot when the export fails', async () => {
    const { interceptor } = limiter();
    const exportReq = () => request('GET', '/providers/me/calls/export');

    await expect(
      send(interceptor, exportReq(), () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await send(interceptor, exportReq())).status).toBe(200);
  });

  it('does not count an attempt refused for the slot against the five a minute', async () => {
    const { interceptor } = limiter();
    const exportReq = () => request('GET', '/providers/me/calls/export');
    const streaming = new Subject<string>();

    const first = send(interceptor, exportReq(), () => streaming);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 10; i += 1) expect((await send(interceptor, exportReq())).status).toBe(429);
    streaming.next('csv');
    streaming.complete();
    await first;

    expect(await sendMany(interceptor, 5, exportReq)).toEqual([200, 200, 200, 200, 429]);
  });

  it('allows five exports a minute for the organization', async () => {
    const { interceptor } = limiter();
    const statuses = await sendMany(interceptor, 6, () =>
      request('GET', '/providers/me/calls/export'),
    );
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('UserRateLimitInterceptor: a burst across a window boundary', () => {
  const health = () => request('GET', '/operator/health', operator());

  /** `HEAVY_READ_LIMIT` requests just before a minute boundary, then as many just after. */
  async function straddle(redis?: unknown): Promise<number[]> {
    const boundary = 7_020_000; // a whole minute
    const { interceptor, advance } = limiter(redis, boundary - 1_000);
    const before = await sendMany(interceptor, HEAVY_READ_LIMIT, health);
    advance(2_000);
    return [...before, ...(await sendMany(interceptor, HEAVY_READ_LIMIT, health))];
  }

  it('allows the heavy-read limit once per rolling minute, not once per window', async () => {
    const statuses = await straddle();
    expect(statuses.filter((status) => status === 200)).toHaveLength(HEAVY_READ_LIMIT);
  });

  it('does the same in the shared window', async () => {
    const { redis } = fakeRateRedis();
    const statuses = await straddle(redis);
    expect(statuses.filter((status) => status === 200)).toHaveLength(HEAVY_READ_LIMIT);
  });

  it('lets a steady rate within the limit through, across boundaries', async () => {
    const { redis } = fakeRateRedis();
    const { interceptor, advance } = limiter(redis);
    const statuses: number[] = [];
    for (let i = 0; i < HEAVY_READ_LIMIT * 4; i += 1) {
      statuses.push((await send(interceptor, health())).status);
      advance(60_000 / HEAVY_READ_LIMIT + 100);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('answers Retry-After with the wait until a request would pass', async () => {
    const { redis } = fakeRateRedis();
    const { interceptor, advance } = limiter(redis, 7_020_000 - 1_000);
    await sendMany(interceptor, HEAVY_READ_LIMIT, health);
    advance(2_000);
    const refused = await send(interceptor, health());
    expect(refused.status).toBe(429);

    advance(Number(refused.retryAfter) * 1_000);
    expect((await send(interceptor, health())).status).toBe(200);
  });
});

describe('UserRateLimitInterceptor with Redis', () => {
  it('shares one window across instances, so N replicas do not allow N × the limit', async () => {
    const { redis } = fakeRateRedis();
    const a = limiter(redis).interceptor;
    const b = limiter(redis).interceptor;

    for (let i = 0; i < WRITE_RULE.limit; i += 1) {
      expect((await send(i % 2 ? a : b, request('POST', '/toolsets'))).status).toBe(200);
    }
    expect((await send(a, request('POST', '/toolsets'))).status).toBe(429);
    expect((await send(b, request('POST', '/toolsets'))).status).toBe(429);
  });

  it('keys the shared window by category, subject and window index', async () => {
    const { redis, store } = fakeRateRedis();
    const { interceptor } = limiter(redis, 7_000_020);

    await send(interceptor, request('GET', '/balances'));
    await send(interceptor, request('POST', '/deposits'));
    await send(interceptor, request('GET', '/tool-calls', apiKey('cred-5')));

    const index = Math.floor(7_000_020 / 60_000);
    expect([...store.keys()].sort()).toEqual(
      [
        `rate:user:heavy:/balances:person:${ORG}:agent-alice:${index}`,
        `rate:user:read:person:${ORG}:agent-alice:${index}`,
        `rate:user:deposit:acct:${person().session.agentAccount}:${index}`,
        `rate:user:read:cred:cred-5:${index}`,
      ].sort(),
    );
  });

  it('shares the export slot across instances', async () => {
    const { redis, sets } = fakeRateRedis();
    const a = limiter(redis).interceptor;
    const b = limiter(redis).interceptor;
    const streaming = new Subject<string>();

    const first = send(a, request('GET', '/providers/me/calls/export'), () => streaming);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await send(b, request('GET', '/providers/me/calls/export'))).status).toBe(429);

    streaming.next('csv');
    streaming.complete();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    expect(sets.get(`rate:user:export:inflight:org:${ORG}`)?.size).toBe(0);
    expect((await send(b, request('GET', '/providers/me/calls/export'))).status).toBe(200);
  });

  it('falls back to the in-process window when Redis fails, which still limits', async () => {
    const { redis } = fakeRateRedis();
    redis.fail = true;
    const { interceptor } = limiter(redis);

    const statuses = await sendMany(interceptor, WRITE_RULE.limit + 1, () =>
      request('POST', '/toolsets'),
    );
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('fails open for money too: a deposit is counted per instance, not refused', async () => {
    const { redis } = fakeRateRedis();
    redis.fail = true;
    const { interceptor } = limiter(redis);

    expect((await send(interceptor, request('POST', '/deposits'))).status).toBe(200);
  });

  it(`skips Redis for ${SHARED_WINDOW_RETRY_MS} ms after a failure, then asks it again`, async () => {
    const { redis } = fakeRateRedis();
    const { interceptor, advance } = limiter(redis);

    redis.fail = true;
    await send(interceptor, request('POST', '/toolsets'));
    const afterFailure = redis.calls;
    redis.fail = false;

    await send(interceptor, request('POST', '/toolsets'));
    expect(redis.calls).toBe(afterFailure);

    advance(SHARED_WINDOW_RETRY_MS);
    await send(interceptor, request('POST', '/toolsets'));
    expect(redis.calls).toBe(afterFailure + 1);
  });

  it('does not wait on a Redis that never answers', async () => {
    jest.useFakeTimers();
    try {
      const hung = {
        multi: () => ({
          incr: () => hung.chain,
          pexpire: () => hung.chain,
          exec: () => new Promise(() => undefined),
        }),
        chain: null as unknown,
      };
      hung.chain = hung.multi();
      const interceptor = new UserRateLimitInterceptor(hung as never, true);

      const pending = send(interceptor, request('GET', '/tool-calls'));
      await jest.advanceTimersByTimeAsync(REDIS_REQUEST_TIMEOUT_MS);
      expect((await pending).status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('frees a slot whose release was lost once it expires, however often the caller retries', async () => {
    const { redis } = fakeRateRedis();
    let now = 10_000_000;
    const windows = new SharedRateWindows({
      redis: redis as never,
      keyPrefix: 'rate:test:',
      maxKeys: 10,
      now: () => now,
      logger: new Logger('test'),
    });

    // Taken and never given back: the replica died mid-run.
    expect(await windows.acquireSlot('export', 1, 120_000)).not.toBeNull();
    for (let i = 0; i < 20; i += 1) {
      now += 5_000;
      expect(await windows.acquireSlot('export', 1, 120_000)).toBeNull();
    }
    now = 10_000_000 + 120_000;
    expect(await windows.acquireSlot('export', 1, 120_000)).not.toBeNull();
  });

  it('gives a slot back by run id, so a repeated or late release frees nobody else’s', async () => {
    const { redis, sets } = fakeRateRedis();
    const windows = new SharedRateWindows({
      redis: redis as never,
      keyPrefix: 'rate:test:',
      maxKeys: 10,
      now: () => 10_000_000,
      logger: new Logger('test'),
    });

    const first = await windows.acquireSlot('export', 2, 120_000);
    const second = await windows.acquireSlot('export', 2, 120_000);
    first?.();
    first?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sets.get('rate:test:export')?.size).toBe(1);
    second?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sets.get('rate:test:export')?.size).toBe(0);
  });
});
