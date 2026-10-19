import type { Redis } from 'ioredis';

import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthErrorCode } from '@modules/oauth/errors/oauth.errors';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import { DcrService } from '@modules/oauth/services/dcr.service';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { OAuthRateLimiter } from '@modules/oauth/services/oauth-rate-limiter.service';
import { OAuthRequestStore } from '@modules/oauth/services/oauth-request.store';
import {
  REDIS_REQUEST_TIMEOUT_MS,
  RedisTimeoutError,
  withRedisTimeout,
} from '@shared/cache/redis-cache/with-redis-timeout';
import { AppError } from '@shared/errors/app-errors';
import { EgressHttpClient } from '@shared/network/egress';

import { FakeEgressHttpClient } from '../auth/helpers/fake-egress';
import {
  Clock,
  FakeOAuthClientRepository,
  hungCache,
  hungRedis,
  oauthConfig,
  timed,
} from './helpers/oauth-fakes';

/** The bound plus scheduling slack: every path below must finish inside it. */
const WITHIN_MS = REDIS_REQUEST_TIMEOUT_MS + 700;
const RID = 'a'.repeat(43);

describe('withRedisTimeout', () => {
  it('passes a prompt answer through', async () => {
    await expect(withRedisTimeout(async () => 'OK')).resolves.toBe('OK');
  });

  it('passes a prompt failure through', async () => {
    await expect(withRedisTimeout(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });

  it('turns a synchronous throw into a rejection', async () => {
    await expect(
      withRedisTimeout(() => {
        throw new Error('no client');
      }),
    ).rejects.toThrow('no client');
  });

  it('rejects with RedisTimeoutError after 500 ms by default when Redis never answers', async () => {
    expect(REDIS_REQUEST_TIMEOUT_MS).toBe(500);
    const started = Date.now();
    await expect(withRedisTimeout(() => new Promise(() => undefined))).rejects.toBeInstanceOf(
      RedisTimeoutError,
    );
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(REDIS_REQUEST_TIMEOUT_MS - 20);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it('takes a custom bound, and a late rejection after it is not unhandled', async () => {
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 50));
    await expect(withRedisTimeout(() => late, 10)).rejects.toBeInstanceOf(RedisTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe('OAuth Redis paths with a Redis that never answers', () => {
  const clock = new Clock();

  it('the rate limiter reads as unreachable (null) within its bound', async () => {
    const limiter = new OAuthRateLimiter(hungCache(), clock.now);
    const { value, ms } = await timed(limiter.count('token', 'k', 60));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(WITHIN_MS);
    await expect(limiter.take('token', 'k', 10, 60)).resolves.toBe(false);
  });

  it('a counter skips silently within its bound', async () => {
    const metrics = new OAuthMetrics(hungCache(), clock.now);
    const { value, ms } = await timed(metrics.incToken('authorization_code', 'ok'));
    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it.each([
    ['create', (store: OAuthRequestStore) => store.create({} as never)],
    ['bind', (store: OAuthRequestStore) => store.bind(RID, 'org')],
    ['decide', (store: OAuthRequestStore) => store.decide(RID, 'org', 'deny')],
    ['discardIfDecided', (store: OAuthRequestStore) => store.discardIfDecided(RID)],
    ['take', (store: OAuthRequestStore) => store.take(RID)],
  ])('the request store %s is a 503 within its bound', async (_name, call) => {
    const store = new OAuthRequestStore(hungRedis() as unknown as Redis);
    const { value: error, ms } = await timed(
      (call(store) as Promise<unknown>).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      errorCode: OAuthErrorCode.OAUTH_REQUEST_STORE_UNAVAILABLE,
      statusCode: 503,
    });
    expect(ms).toBeLessThan(WITHIN_MS * 2);
  });

  it('a store failure (not a hang) is the same 503', async () => {
    const store = new OAuthRequestStore({
      eval: () => Promise.reject(new Error('down')),
    } as unknown as Redis);
    await expect(store.take(RID)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('DCR fails closed within its bound and stores nothing', async () => {
    const repo = new FakeOAuthClientRepository();
    const dcr = new DcrService(
      repo as unknown as OAuthClientRepository,
      new OAuthRateLimiter(hungCache(), clock.now),
      oauthConfig(),
      clock.now,
    );
    const { value, ms } = await timed(
      dcr.register(
        { client_name: 'Example', redirect_uris: ['http://127.0.0.1/callback'] },
        '10.0.0.1',
      ),
    );
    expect(value.ok).toBe(false);
    expect(repo.rows.size).toBe(0);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it('a CIMD fetch is refused on its budget, without fetching, within its bound', async () => {
    const egress = new FakeEgressHttpClient();
    const cache = hungCache();
    const fetcher = new CimdFetcher(
      egress as unknown as EgressHttpClient,
      new FakeOAuthClientRepository() as unknown as OAuthClientRepository,
      new OAuthRateLimiter(cache, clock.now),
      cache,
      new OAuthMetrics(cache, clock.now),
      oauthConfig({ verifiedClients: [] }),
      clock.now,
    );
    const { value, ms } = await timed(
      fetcher.fetch('https://client.example.com/client.json', '10.0.0.2'),
    );
    expect(value).toEqual({ ok: false, reason: 'budget' });
    expect(egress.requests).toHaveLength(0);
    // The failure lookup, the budget and the counter: each bounded, in sequence.
    expect(ms).toBeLessThan(WITHIN_MS * 3);
  });
});
