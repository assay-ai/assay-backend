import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { OAUTH_COUNTERS, oauthCounterKey } from '@modules/oauth/domain/oauth-counters';
import { OAuthSignalsReader } from '@modules/observability/services/oauth-signals.reader';

import { FakeOAuthRedis, fakeCache } from '../oauth/helpers/oauth-fakes';

const HOUR = 3_600_000;
// 12:15 UTC: a quarter of the current hour has passed.
const NOW = Date.parse('2026-10-19T12:15:00Z');

function setup(query: jest.Mock = jest.fn().mockResolvedValue([{ liveGrants: 1 }])) {
  const redis = new FakeOAuthRedis();
  const reader = new OAuthSignalsReader({ query } as unknown as DataSource, fakeCache(redis));
  const put = (name: keyof typeof OAUTH_COUNTERS, label: string, hoursAgo: number, n: number) =>
    redis.strings.set(oauthCounterKey(name, label, NOW - hoursAgo * HOUR), String(n));
  return { redis, reader, put, query };
}

describe('OAuthSignalsReader', () => {
  it('sums each label over the last 24 hourly buckets, the current one included', async () => {
    const { reader, put } = setup();
    put('token', 'authorization_code.ok', 0, 2);
    put('token', 'authorization_code.ok', 23, 3);
    put('token', 'authorization_code.ok', 24, 100); // outside the window
    put('mcp_unauthorized', 'missing', 5, 7);

    const { last24h } = await reader.counterFigures(NOW);

    expect(last24h.token['authorization_code.ok']).toBe(5);
    expect(last24h.token['refresh_token.ok']).toBe(0);
    expect(last24h.mcp_unauthorized.missing).toBe(7);
    expect(Object.keys(last24h.consent).sort()).toEqual([...OAUTH_COUNTERS.consent].sort());
  });

  it('estimates the trailing hour from the current bucket and the rest of the previous one', async () => {
    const { reader, put } = setup();
    put('consent', 'approved', 0, 10);
    put('consent', 'approved', 1, 8); // three quarters of it is still inside the hour
    put('consent', 'continue_cookie_missing', 1, 4);
    put('consent', 'continue_cookie_missing', 2, 50); // older than an hour

    const { lastHour } = await reader.counterFigures(NOW);

    expect(lastHour.consentApproved).toBeCloseTo(16);
    expect(lastHour.continueCookieMissing).toBeCloseTo(3);
  });

  it('reads every allow-listed label in one MGET and nothing else', async () => {
    const { reader, redis } = setup();
    const mget = jest.spyOn(redis, 'mget');
    await reader.counterFigures(NOW);
    expect(mget).toHaveBeenCalledTimes(1);
    const keys = mget.mock.calls[0][0];
    const labels = Object.values(OAUTH_COUNTERS).reduce((n, list) => n + list.length, 0);
    expect(keys).toHaveLength(labels * 24);
    for (const key of keys) expect(key).toMatch(/^oauth:m:[a-z_]+:[a-z_.]+:\d{10}$/);
  });

  it('passes the window and the revoked_by markers to one database query', async () => {
    const { reader, query } = setup();
    const facts = await reader.databaseFacts(new Date(NOW - 24 * HOUR));
    expect(facts).toEqual({ liveGrants: 1 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"audit_log_entries"');
    expect(sql).toContain("'oauth.refresh_grace_used'");
    expect(params).toEqual([
      'OAUTH',
      new Date(NOW - 24 * HOUR),
      'system:oauth-refresh-reuse',
      'system:oauth-code-reused',
      'DCR',
      'CIMD',
    ]);
  });

  it('a failed source reads as null; the other is still read', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { reader, redis, put } = setup(jest.fn().mockRejectedValue(new Error('db down')));
    put('consent', 'shown', 0, 1);

    const dbDown = await reader.read(NOW);
    expect(dbDown.database).toBeNull();
    expect(dbDown.counters?.last24h.consent.shown).toBe(1);

    redis.down = true;
    const bothDown = await reader.read(NOW);
    expect(bothDown).toEqual({ database: null, counters: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
