import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import {
  OAUTH_COUNTER_TTL_MS,
  OAUTH_COUNTERS,
  oauthCounterHour,
  oauthCounterKey,
} from '@modules/oauth/domain/oauth-counters';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { Clock, FakeOAuthRedis, counterValue, fakeCache } from './helpers/oauth-fakes';

describe('OAuthMetrics (Redis hourly counters, spec §6.7)', () => {
  function setup() {
    const redis = new FakeOAuthRedis();
    const clock = new Clock(Date.parse('2026-10-19T12:34:56Z'));
    return { redis, clock, metrics: new OAuthMetrics(fakeCache(redis), clock.now) };
  }

  it('counts under oauth:m:{name}:{label}:{yyyymmddhh UTC}, with an eight-day expiry', async () => {
    const { redis, metrics } = setup();

    await metrics.incAuthorize('stored');
    await metrics.incConsent('continue_cookie_missing');
    await metrics.incToken('authorization_code', 'ok');
    await metrics.incToken('refresh_token', 'invalid_grant');
    await metrics.incToken('authorization_code', 'ok');
    await metrics.incCimdFetch('blocked_address');
    await metrics.incMcpUnauthorized('audience');

    expect(Object.fromEntries(redis.strings)).toEqual({
      'oauth:m:authorize:stored:2026101912': '1',
      'oauth:m:consent:continue_cookie_missing:2026101912': '1',
      'oauth:m:token:authorization_code.ok:2026101912': '2',
      'oauth:m:token:refresh_token.invalid_grant:2026101912': '1',
      'oauth:m:cimd_fetch:blocked_address:2026101912': '1',
      'oauth:m:mcp_unauthorized:audience:2026101912': '1',
    });
    for (const key of redis.strings.keys()) {
      expect(redis.expiries.get(key)).toBe(OAUTH_COUNTER_TTL_MS);
    }
    expect(OAUTH_COUNTER_TTL_MS).toBe(8 * 24 * 3600 * 1000);
  });

  it('starts a new bucket each UTC hour', async () => {
    const { redis, clock, metrics } = setup();
    await metrics.incConsent('approved');
    clock.advance(3600);
    await metrics.incConsent('approved');
    expect(redis.keys('oauth:m:consent:approved:').sort()).toEqual([
      'oauth:m:consent:approved:2026101912',
      'oauth:m:consent:approved:2026101913',
    ]);
    expect(await counterValue(redis, 'consent', 'approved')).toBe(2);
  });

  it('never counts a label outside its allow-list', async () => {
    const { redis, metrics } = setup();
    // A value a caller could only produce by casting: never reaches a key.
    await metrics.incToken('authorization_code', 'assay_rt_secret' as never);
    await metrics.incConsent('../../evil' as never);
    await metrics.incMcpUnauthorized('x' as never);
    expect(redis.strings.size).toBe(0);
  });

  it('every allow-listed label is a fixed identifier, so no key carries free text', () => {
    for (const labels of Object.values(OAUTH_COUNTERS)) {
      for (const label of labels) expect(label).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
    }
    expect(OAUTH_COUNTERS.token).toHaveLength(3 * 11);
  });

  it('a Redis failure resolves and logs at debug', async () => {
    const { redis, metrics } = setup();
    redis.down = true;
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(metrics.incToken('authorization_code', 'ok')).resolves.toBeUndefined();
    await expect(metrics.incConsent('approved')).resolves.toBeUndefined();

    expect(debug).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    debug.mockRestore();
    warn.mockRestore();
  });

  it('a client that throws synchronously resolves too', async () => {
    const cache = {
      getRedisClient: () => {
        throw new Error('no connection');
      },
    } as unknown as CacheService;
    await expect(new OAuthMetrics(cache).incConsent('shown')).resolves.toBeUndefined();
  });

  it('without a cache it counts nothing and never throws', async () => {
    await expect(new OAuthMetrics().incAuthorize('stored')).resolves.toBeUndefined();
  });

  it('formats the bucket hour in UTC', () => {
    expect(oauthCounterHour(Date.parse('2026-01-02T03:59:59Z'))).toBe('2026010203');
    expect(oauthCounterKey('token', 'other.ok', Date.parse('2026-12-31T23:00:00Z'))).toBe(
      'oauth:m:token:other.ok:2026123123',
    );
  });

  it('prom-client is gone: no dependency, no import', () => {
    const root = join(__dirname, '../../..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['prom-client']).toBeUndefined();
    expect(pkg.devDependencies?.['prom-client']).toBeUndefined();
    expect(readFileSync(join(root, 'yarn.lock'), 'utf8')).not.toMatch(/^"?prom-client@/m);
  });
});
