import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Observable, lastValueFrom, of, throwError } from 'rxjs';

import { OPERATOR_REQUEST_KEY } from '@shared/auth/operator-request.key';
import { SESSION_REQUEST_KEY } from '@shared/auth/session-request.key';
import {
  normalizedQuery,
  tenantCacheCaller,
  tenantCacheEtag,
  tenantCacheKey,
} from '@shared/cache/http-cache/tenant-cache-key';
import {
  ORGANIZATION_EPOCH_SCOPES,
  TenantEpochService,
  tenantEpochKey,
} from '@shared/cache/redis-cache/tenant-epoch.service';
import {
  TENANT_CACHE_KEY,
  TenantCache,
  TenantCacheOptions,
} from '@shared/decorators/tenant-cache.decorator';
import { HttpCacheInterceptor } from '@shared/interceptors/http-cache.interceptor';
import { TenantWriteEpochInterceptor } from '@shared/interceptors/tenant-write-epoch.interceptor';
import {
  BUMPS_OPERATOR_CONSOLE_KEY,
  NO_EPOCH_BUMP_KEY,
} from '@shared/decorators/tenant-write.decorator';
import { BLOCKED_SESSION_READ_ONLY_METADATA } from '@shared/auth/blocked-session-read-only.decorator';

/** Just the commands the epoch service and the cache use. */
class FakeRedis {
  readonly values = new Map<string, string>();
  down = false;

  private check() {
    if (this.down) throw new Error('redis down');
  }
  async get(key: string) {
    this.check();
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, ...options: string[]) {
    this.check();
    if (options.includes('NX') && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
  async mget(...keys: string[]) {
    this.check();
    return keys.map((key) => this.values.get(key) ?? null);
  }
  /** Only `TenantEpochService`'s bump script. */
  evalDelayMs = 0;
  async eval(_script: string, numKeys: number, ...args: string[]) {
    this.check();
    if (this.evalDelayMs) await new Promise((resolve) => setTimeout(resolve, this.evalDelayMs));
    const keys = args.slice(0, numKeys);
    const start = args[numKeys];
    for (const key of keys) {
      if (!this.values.has(key)) this.values.set(key, start);
      this.values.set(key, (BigInt(this.values.get(key)!) + 1n).toString());
    }
    return keys.length;
  }
  async exists(key: string) {
    this.check();
    return this.values.has(key) ? 1 : 0;
  }
  async incr(key: string) {
    this.check();
    const next = BigInt(this.values.get(key) ?? '0') + 1n;
    this.values.set(key, next.toString());
    return Number(next);
  }
}

function epochService(redis: FakeRedis) {
  return new TenantEpochService({ getRedisClient: () => redis } as never);
}

const ORG_A = 'org-a';
const ORG_B = 'org-b';

describe('TenantEpochService', () => {
  it('reads one value per scope and keeps reading the same until a bump', async () => {
    const epochs = epochService(new FakeRedis());
    const first = await epochs.read(ORG_A, ['money', 'notifications']);
    expect(first).toHaveLength(2);
    expect(await epochs.read(ORG_A, ['money', 'notifications'])).toEqual(first);
  });

  it('a bump changes only the bumped scope of the bumped organization', async () => {
    const epochs = epochService(new FakeRedis());
    const [moneyA, notesA] = (await epochs.read(ORG_A, ['money', 'notifications']))!;
    const [moneyB] = (await epochs.read(ORG_B, ['money']))!;

    await epochs.bump(ORG_A, 'money');

    const [moneyA2, notesA2] = (await epochs.read(ORG_A, ['money', 'notifications']))!;
    expect(moneyA2).not.toEqual(moneyA);
    expect(notesA2).toEqual(notesA);
    expect((await epochs.read(ORG_B, ['money']))![0]).toEqual(moneyB);
  });

  it('bumps every organization a write touched, once each, and skips nullish ids', async () => {
    const redis = new FakeRedis();
    const epochs = epochService(redis);
    const before = await Promise.all([
      epochs.read(ORG_A, ['disputes']),
      epochs.read(ORG_B, ['disputes']),
    ]);
    await epochs.bump([ORG_A, ORG_B, ORG_A, null, undefined, ''], 'disputes');
    const after = await Promise.all([
      epochs.read(ORG_A, ['disputes']),
      epochs.read(ORG_B, ['disputes']),
    ]);
    expect(BigInt(after[0]![0]) - BigInt(before[0]![0])).toBe(1n);
    expect(BigInt(after[1]![0]) - BigInt(before[1]![0])).toBe(1n);
  });

  it('keeps the operator scope global', async () => {
    const epochs = epochService(new FakeRedis());
    const a = await epochs.read(ORG_A, ['operator']);
    expect(await epochs.read(null, ['operator'])).toEqual(a);
    await epochs.bumpOperator();
    expect(await epochs.read(ORG_B, ['operator'])).not.toEqual(a);
    expect(tenantEpochKey('operator', ORG_A)).toBe(tenantEpochKey('operator', null));
  });

  it('a counter bumped while missing does not restart at a small value an old entry used', async () => {
    const redis = new FakeRedis();
    const epochs = epochService(redis);
    await epochs.bump(ORG_A, 'money');
    const value = redis.values.get(tenantEpochKey('money', ORG_A))!;
    expect(BigInt(value) > 1_000_000n).toBe(true);
  });

  it('reads null (do not cache) when Redis is down, and a bump never throws', async () => {
    const redis = new FakeRedis();
    const epochs = epochService(redis);
    redis.down = true;
    expect(await epochs.read(ORG_A, ['money'])).toBeNull();
    await expect(epochs.bump(ORG_A, 'money')).resolves.toBeUndefined();
  });

  it('reads null for a per-org scope without an organization', async () => {
    const epochs = epochService(new FakeRedis());
    expect(await epochs.read(null, ['money'])).toBeNull();
  });
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG_A,
    agentId: 'agent-1',
    agentAccount: 'eip155:1:0xaaa',
    chainId: 'eip155:1',
    credentialId: 'cred-1',
    callerKind: 'HUMAN',
    paymentsAllowed: true,
    ...overrides,
  };
}

const req = (s: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  ...(s ? { [SESSION_REQUEST_KEY]: s } : {}),
  ...extra,
});

describe('tenantCacheCaller', () => {
  it('fails closed without a session, an organization or a caller kind', () => {
    expect(tenantCacheCaller(req(null), 'org')).toBeNull();
    expect(tenantCacheCaller(req(session({ organizationId: '' })), 'org')).toBeNull();
    expect(tenantCacheCaller(req(session({ callerKind: undefined })), 'org')).toBeNull();
    expect(tenantCacheCaller(req(session({ agentId: undefined })), 'agent')).toBeNull();
    expect(tenantCacheCaller(req(session({ credentialId: undefined })), 'credential')).toBeNull();
  });

  it('separates organizations, caller kinds and block states at every level', () => {
    for (const vary of ['org', 'agent', 'credential'] as const) {
      const base = tenantCacheCaller(req(session()), vary)!.fingerprint;
      expect(
        tenantCacheCaller(req(session({ organizationId: ORG_B })), vary)!.fingerprint,
      ).not.toBe(base);
      expect(tenantCacheCaller(req(session({ callerKind: 'AGENT' })), vary)!.fingerprint).not.toBe(
        base,
      );
      expect(
        tenantCacheCaller(req(session({ blocked: { reasonCode: 'X' } })), vary)!.fingerprint,
      ).not.toBe(base);
    }
  });

  it('shares an org entry across agents, but not an agent or credential one', () => {
    const one = req(session());
    const other = req(session({ agentId: 'agent-2', credentialId: 'cred-2' }));
    expect(tenantCacheCaller(one, 'org')!.fingerprint).toBe(
      tenantCacheCaller(other, 'org')!.fingerprint,
    );
    expect(tenantCacheCaller(one, 'agent')!.fingerprint).not.toBe(
      tenantCacheCaller(other, 'agent')!.fingerprint,
    );
    const otherKey = req(session({ credentialId: 'cred-2' }));
    expect(tenantCacheCaller(one, 'agent')!.fingerprint).toBe(
      tenantCacheCaller(otherKey, 'agent')!.fingerprint,
    );
    expect(tenantCacheCaller(one, 'credential')!.fingerprint).not.toBe(
      tenantCacheCaller(otherKey, 'credential')!.fingerprint,
    );
    expect(
      tenantCacheCaller(req(session({ delegateAccount: 'eip155:1:0xd' })), 'agent')!.fingerprint,
    ).not.toBe(tenantCacheCaller(one, 'agent')!.fingerprint);
  });

  it('caches an operator route only behind the operator guard', () => {
    expect(tenantCacheCaller(req(session()), 'operator')).toBeNull();
    expect(
      tenantCacheCaller(req(null, { [OPERATOR_REQUEST_KEY]: { operatorId: 'op-1' } }), 'operator'),
    ).toEqual({ organizationId: null, fingerprint: 'operator' });
  });
});

describe('tenantCacheKey and ETag', () => {
  const caller = { organizationId: ORG_A, fingerprint: 'f' };
  const key = (over: Partial<Parameters<typeof tenantCacheKey>[0]> = {}) =>
    tenantCacheKey({
      path: '/api/v1/x',
      query: {},
      caller,
      epochs: ['1'],
      scopes: ['money'],
      ...over,
    });

  it('normalizes the query order', () => {
    expect(normalizedQuery({ b: '1', a: ['2', '3'] })).toBe(
      normalizedQuery({ a: ['2', '3'], b: '1' }),
    );
    expect(key({ query: { b: '1', a: '2' } })).toBe(key({ query: { a: '2', b: '1' } }));
  });

  it('changes with the path, the query, the caller and every epoch', () => {
    const base = key();
    expect(key({ path: '/api/v1/y' })).not.toBe(base);
    expect(key({ query: { a: '1' } })).not.toBe(base);
    expect(key({ caller: { organizationId: ORG_A, fingerprint: 'g' } })).not.toBe(base);
    expect(key({ epochs: ['2'] })).not.toBe(base);
  });

  it('is a weak validator that changes with the key and with the body', () => {
    const etag = tenantCacheEtag('k1', { a: 1 });
    expect(etag).toMatch(/^W\/"tc-[A-Za-z0-9_-]+"$/);
    expect(tenantCacheEtag('k1', { a: 1 })).toBe(etag);
    expect(tenantCacheEtag('k2', { a: 1 })).not.toBe(etag);
    expect(tenantCacheEtag('k1', { a: 2 })).not.toBe(etag);
  });
});

describe('HttpCacheInterceptor with @TenantCache', () => {
  function build(options: TenantCacheOptions, redis = new FakeRedis()) {
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => {
        if (redis.down) throw new Error('redis down');
        return store.get(key) ?? null;
      }),
      set: jest.fn(async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)));
      }),
    };
    const reflector = {
      get: jest.fn((key: string) => (key === TENANT_CACHE_KEY ? options : undefined)),
    } as unknown as Reflector;
    const config = { get: jest.fn().mockReturnValue(true) } as unknown as ConfigService;
    const epochs = epochService(redis);
    const singleFlight = {
      execute: jest.fn(async ({ fn }: { fn: () => Promise<unknown> }) => fn()),
    };
    const interceptor = new HttpCacheInterceptor(
      cache as never,
      reflector,
      config,
      epochs,
      singleFlight as never,
    );
    return { interceptor, cache, store, epochs, singleFlight, redis };
  }

  function call(
    interceptor: HttpCacheInterceptor,
    request: Record<string, unknown>,
    handle: () => Observable<unknown>,
  ) {
    const headers: Record<string, string> = {};
    const response = { statusCode: 200, setHeader: (k: string, v: string) => (headers[k] = v) };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => function handler() {},
    } as unknown as ExecutionContext;
    return {
      headers,
      run: async () => lastValueFrom(await interceptor.intercept(context, { handle })),
    };
  }

  const get = (s: Record<string, unknown>, query: Record<string, unknown> = {}) =>
    req(s, {
      method: 'GET',
      path: '/api/v1/balances',
      url: '/api/v1/balances',
      query,
      headers: {},
    });

  const options: TenantCacheOptions = { ttl: 5, vary: 'org', epochs: ['money'] };

  it('serves the second read from the cache with the same ETag', async () => {
    const { interceptor } = build(options);
    const handler = jest.fn(() => of({ total: '1' }));
    const first = call(interceptor, get(session()), handler);
    expect(await first.run()).toEqual({ total: '1' });
    const second = call(interceptor, get(session()), handler);
    expect(await second.run()).toEqual({ total: '1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.headers.ETag).toBe(first.headers.ETag);
  });

  it('a bump makes the next read run the handler and changes the ETag', async () => {
    const { interceptor, epochs } = build(options);
    let total = '1';
    const handler = jest.fn(() => of({ total }));
    const first = call(interceptor, get(session()), handler);
    await first.run();
    total = '2';
    await epochs.bump(ORG_A, 'money');
    const second = call(interceptor, get(session()), handler);
    expect(await second.run()).toEqual({ total: '2' });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(second.headers.ETag).not.toBe(first.headers.ETag);
  });

  it('does not answer another organization, caller kind or query from an entry', async () => {
    const { interceptor } = build(options);
    const handler = jest.fn(() => of({ total: '1' }));
    await call(interceptor, get(session()), handler).run();
    await call(interceptor, get(session({ organizationId: ORG_B })), handler).run();
    await call(interceptor, get(session({ callerKind: 'AGENT' })), handler).run();
    await call(interceptor, get(session(), { from: 'x' }), handler).run();
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('runs the handler and stores nothing when the caller cannot be attributed', async () => {
    const { interceptor, cache } = build(options);
    const handler = jest.fn(() => of({ total: '1' }));
    await call(interceptor, get({}), handler).run();
    await call(interceptor, get({}), handler).run();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('runs the handler when Redis is down', async () => {
    const { interceptor, redis } = build(options);
    redis.down = true;
    const handler = jest.fn(() => of({ total: '1' }));
    expect(await call(interceptor, get(session()), handler).run()).toEqual({ total: '1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure, and passes the error through unchanged', async () => {
    const { interceptor, cache } = build({ ...options, singleFlight: true });
    const failure = Object.assign(new Error('nope'), { status: 404 });
    await expect(
      call(interceptor, get(session()), () => throwError(() => failure)).run(),
    ).rejects.toBe(failure);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('a single-flight waiter told the leader failed runs the handler itself', async () => {
    const { interceptor, singleFlight } = build({ ...options, singleFlight: true });
    singleFlight.execute.mockResolvedValueOnce({ ok: false });
    const handler = jest.fn(() => of({ total: '3' }));
    expect(await call(interceptor, get(session()), handler).run()).toEqual({ total: '3' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a single-flight waiter answers with the leader's body and ETag", async () => {
    const { interceptor, singleFlight } = build({ ...options, singleFlight: true });
    singleFlight.execute.mockResolvedValueOnce({ ok: true, e: 'W/"tc-leader"', d: { total: '9' } });
    const handler = jest.fn(() => of({ total: 'mine' }));
    const waiter = call(interceptor, get(session()), handler);
    expect(await waiter.run()).toEqual({ total: '9' });
    expect(waiter.headers.ETag).toBe('W/"tc-leader"');
    expect(handler).not.toHaveBeenCalled();
  });

  it('caches an operator route once for every operator', async () => {
    const { interceptor } = build({ ttl: 30, vary: 'operator', epochs: ['operator'] });
    const handler = jest.fn(() => of({ queue: [] }));
    const op = (id: string) =>
      req(null, {
        [OPERATOR_REQUEST_KEY]: { operatorId: id },
        method: 'GET',
        path: '/api/v1/operator/health',
        url: '/api/v1/operator/health',
        query: {},
        headers: {},
      });
    await call(interceptor, op('op-1'), handler).run();
    await call(interceptor, op('op-2'), handler).run();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ttl 0 coalesces but stores nothing', async () => {
    const { interceptor, cache, singleFlight } = build({
      ttl: 0,
      vary: 'operator',
      epochs: [],
      singleFlight: true,
    });
    const handler = jest.fn(() => of({ chain: 'live' }));
    const op = req(null, {
      [OPERATOR_REQUEST_KEY]: { operatorId: 'op-1' },
      method: 'GET',
      path: '/api/v1/operator/arbiter/disputes',
      url: '/api/v1/operator/arbiter/disputes',
      query: {},
      headers: {},
    });
    const first = call(interceptor, op, handler);
    await first.run();
    await call(interceptor, op, handler).run();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(singleFlight.execute).toHaveBeenCalledTimes(2);
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(first.headers.ETag).toBeUndefined();
  });

  it('stores nothing when cacheIf refuses the body', async () => {
    const { interceptor, cache } = build({
      ...options,
      cacheIf: (body) => (body as { part: unknown }).part !== null,
    });
    const handler = jest.fn(() => of({ part: null }));
    await call(interceptor, get(session()), handler).run();
    await call(interceptor, get(session()), handler).run();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('leaves a non-GET alone', async () => {
    const { interceptor, cache } = build(options);
    const handler = jest.fn(() => of({ ok: true }));
    await call(interceptor, { ...get(session()), method: 'POST' }, handler).run();
    expect(cache.get).not.toHaveBeenCalled();
  });
});

describe('TenantWriteEpochInterceptor', () => {
  function run(
    request: Record<string, unknown>,
    handle: () => Observable<unknown>,
    metadata: Record<string, boolean> = {},
  ) {
    const real = epochService(new FakeRedis());
    const epochs = {
      bump: jest.fn(async () => undefined),
      trackRequestBumps: real.trackRequestBumps.bind(real),
      settleRequestBumps: real.settleRequestBumps.bind(real),
    };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    } as unknown as Reflector;
    const interceptor = new TenantWriteEpochInterceptor(reflector, epochs as never);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;
    return { epochs, result: lastValueFrom(interceptor.intercept(context, { handle })) };
  }

  it("bumps every per-organization scope of the caller's org after a write, not the operator's", async () => {
    const { epochs, result } = run({ method: 'POST', [SESSION_REQUEST_KEY]: session() }, () =>
      of({ ok: true }),
    );
    expect(await result).toEqual({ ok: true });
    expect(epochs.bump).toHaveBeenCalledWith(ORG_A, ...ORGANIZATION_EPOCH_SCOPES);
  });

  it('bumps the operator scope for a write the console lists', async () => {
    const { epochs, result } = run(
      { method: 'POST', [SESSION_REQUEST_KEY]: session() },
      () => of({ ok: true }),
      { [BUMPS_OPERATOR_CONSOLE_KEY]: true },
    );
    await result;
    expect(epochs.bump).toHaveBeenCalledWith(ORG_A, ...ORGANIZATION_EPOCH_SCOPES, 'operator');
  });

  it('bumps after a failed write too, and rethrows it', async () => {
    const failure = new Error('partly committed');
    const { epochs, result } = run({ method: 'PATCH', [SESSION_REQUEST_KEY]: session() }, () =>
      throwError(() => failure),
    );
    await expect(result).rejects.toBe(failure);
    expect(epochs.bump).toHaveBeenCalled();
  });

  it('bumps nothing after a refusal no handler ran for (a pipe or limiter HttpException)', async () => {
    const refusal = new BadRequestException('invalid body');
    const { epochs, result } = run({ method: 'POST', [SESSION_REQUEST_KEY]: session() }, () =>
      throwError(() => refusal),
    );
    await expect(result).rejects.toBe(refusal);
    expect(epochs.bump).not.toHaveBeenCalled();
  });

  it("bumps the operator and shared scopes after an operator's write", async () => {
    const { epochs, result } = run(
      { method: 'DELETE', [OPERATOR_REQUEST_KEY]: { operatorId: 'op-1' } },
      () => of(null),
    );
    await result;
    expect(epochs.bump).toHaveBeenCalledWith(null, 'operator', 'shared');
  });

  it('bumps nothing for a read, or a POST that only reads', async () => {
    const read = run({ method: 'GET', [SESSION_REQUEST_KEY]: session() }, () => of(1));
    await read.result;
    expect(read.epochs.bump).not.toHaveBeenCalled();
    for (const key of [NO_EPOCH_BUMP_KEY, BLOCKED_SESSION_READ_ONLY_METADATA]) {
      const lookup = run({ method: 'POST', [SESSION_REQUEST_KEY]: session() }, () => of(1), {
        [key]: true,
      });
      await lookup.result;
      expect(lookup.epochs.bump).not.toHaveBeenCalled();
    }
  });

  it('awaits the bumps a commit hook fired during the request before it answers', async () => {
    const redis = new FakeRedis();
    redis.evalDelayMs = 50;
    const real = epochService(redis);
    const subscribers: Array<{ afterTransactionCommit?: (e: unknown) => Promise<void> }> = [];
    const queryRunner = { isTransactionActive: true, data: {}, connection: { subscribers } };
    const reflector = { getAllAndOverride: jest.fn(() => undefined) } as unknown as Reflector;
    const interceptor = new TenantWriteEpochInterceptor(reflector, real);
    const context = {
      getType: () => 'http',
      // No session: only the hook's bump is in play.
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST' }) }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;
    const before = await real.read(ORG_B, ['money']);
    const handler = () =>
      new Observable((subscriber) => {
        void (async () => {
          await real.bumpAfterCommit(queryRunner as never, ORG_B, 'money');
          queryRunner.isTransactionActive = false;
          // The commit hook returns at once: it does not await the bump.
          await subscribers[0].afterTransactionCommit!({ queryRunner });
          subscriber.next('ok');
          subscriber.complete();
        })();
      });
    await lastValueFrom(interceptor.intercept(context, { handle: handler }));
    expect(await real.read(ORG_B, ['money'])).not.toEqual(before);
  });
});

describe('TenantEpochService.bumpAfterCommit', () => {
  it('bumps at once when not in a transaction', async () => {
    const redis = new FakeRedis();
    const epochs = epochService(redis);
    const before = await epochs.read(ORG_A, ['money']);
    await epochs.bumpAfterCommit(null, ORG_A, 'money');
    expect(await epochs.read(ORG_A, ['money'])).not.toEqual(before);
  });

  it('defers to the outermost commit, and drops on rollback', async () => {
    const redis = new FakeRedis();
    const epochs = epochService(redis);
    const subscribers: Array<{
      afterTransactionCommit?: (e: unknown) => Promise<void>;
      afterTransactionRollback?: (e: unknown) => Promise<void>;
    }> = [];
    const queryRunner = {
      isTransactionActive: true,
      data: {},
      connection: { subscribers },
    };
    const before = await epochs.read(ORG_A, ['money']);
    await epochs.bumpAfterCommit(queryRunner as never, ORG_A, 'money');
    expect(await epochs.read(ORG_A, ['money'])).toEqual(before);

    // A savepoint released inside the transaction is not the commit.
    await subscribers[0].afterTransactionCommit!({ queryRunner });
    expect(await epochs.read(ORG_A, ['money'])).toEqual(before);

    queryRunner.isTransactionActive = false;
    await subscribers[0].afterTransactionCommit!({ queryRunner });
    expect(await epochs.read(ORG_A, ['money'])).not.toEqual(before);

    const mid = await epochs.read(ORG_A, ['money']);
    queryRunner.isTransactionActive = true;
    await epochs.bumpAfterCommit(queryRunner as never, ORG_A, 'money');
    queryRunner.isTransactionActive = false;
    await subscribers[0].afterTransactionRollback!({ queryRunner });
    await subscribers[0].afterTransactionCommit!({ queryRunner });
    expect(await epochs.read(ORG_A, ['money'])).toEqual(mid);
    expect(subscribers).toHaveLength(1);
  });
});

describe('@TenantCache validation', () => {
  it('fails at definition for an unknown vary or scope, a bad TTL or an operator per-org scope', () => {
    expect(() => TenantCache({ ttl: 5, vary: 'tenant' as never, epochs: [] })).toThrow(/vary/);
    expect(() => TenantCache({ ttl: 5, vary: 'org', epochs: ['cash' as never] })).toThrow(/scope/);
    expect(() => TenantCache({ ttl: -1, vary: 'org', epochs: [] })).toThrow(/ttl/);
    expect(() => TenantCache({ ttl: 0, vary: 'org', epochs: [] })).toThrow(/singleFlight/);
    expect(() => TenantCache({ ttl: 30, vary: 'operator', epochs: ['money'] })).toThrow(
      /organization/,
    );
    expect(() =>
      TenantCache({ ttl: 0, vary: 'operator', epochs: [], singleFlight: true }),
    ).not.toThrow();
  });
});
