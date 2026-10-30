import type Redis from 'ioredis';
import { validate } from 'class-validator';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { ProtocolAnalyticsService } from '@modules/protocol-analytics/services/protocol-analytics.service';
import { ProtocolAnalyticsRepository } from '@database/postgres/repositories/protocol-analytics.repository';
import { ProtocolAnalyticsQueryDto } from '@modules/protocol-analytics/dto/protocol-analytics.dto';
import { analyticsWindow } from '@modules/protocol-analytics/domain/analytics-window';

const FIGURES = {
  paidCalls: 0,
  payingAgents: 0,
  toolsEarning: 0,
  collectedCalls: 0,
  refundedCalls: 0,
  pendingCalls: 0,
  volume: '0',
  revenue: '0',
  providerEarnings: '0',
  refunded: '0',
  pending: '0',
  notCharged: '0',
  passRate: null,
};

describe('ProtocolAnalyticsService', () => {
  let repository: { read: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock };
  let service: ProtocolAnalyticsService;
  let cache: Map<string, string>;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-29T12:30:00Z') });
    cache = new Map();
    repository = {
      read: jest.fn().mockResolvedValue({
        from: '2026-10-23T00:00:00Z',
        totals: FIGURES,
        previous: FIGURES,
        daily: [],
        topTools: [],
        recent: [],
        escrow: { available: '0', held: '0' },
        withheldForPrivacy: false,
      }),
    };
    redis = {
      get: jest.fn(async (key: string) => cache.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        cache.set(key, value);
        return 'OK';
      }),
    };
    service = new ProtocolAnalyticsService(
      repository as unknown as ProtocolAnalyticsRepository,
      redis as unknown as Redis,
      [CHAIN_IDS.ROBINHOOD_TESTNET],
    );
  });
  afterEach(() => jest.useRealTimers());

  it('uses a five-minute deadline tied to the snapshot, then reads fresh data', async () => {
    await service.read({ range: '7d' });
    expect(redis.set.mock.calls[0].slice(-2)).toEqual(['PX', 300000]);
    await service.read({ range: '7d' });
    expect(repository.read).toHaveBeenCalledTimes(1);
    // Expired timestamps are refused even if Redis returned an old entry.
    jest.advanceTimersByTime(299999);
    await service.read({ range: '7d' });
    expect(repository.read).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2);
    await service.read({ range: '7d' });
    expect(repository.read).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent requests and isolates cache keys by range', async () => {
    await Promise.all([
      service.read({ range: '7d' }),
      service.read({ range: '7d' }),
      service.read({ range: '7d' }),
    ]);
    expect(repository.read).toHaveBeenCalledTimes(1);
    await service.read({ range: '30d' });
    expect(repository.read).toHaveBeenCalledTimes(2);
  });

  it('continues with PostgreSQL when Redis fails or holds invalid JSON', async () => {
    redis.get.mockRejectedValueOnce(new Error('offline'));
    redis.set.mockRejectedValueOnce(new Error('offline'));
    expect((await service.read({ range: '7d' })).state).toBe('OK');
    redis.get.mockResolvedValueOnce('{broken');
    await service.read({ range: '7d' });
    expect(repository.read).toHaveBeenCalledTimes(2);
  });

  it('bounds a Redis call that never responds', async () => {
    redis.get.mockImplementation(() => new Promise(() => undefined));
    const pending = service.read({});
    await jest.advanceTimersByTimeAsync(151);
    expect((await pending).state).toBe('OK');
  });

  it('does not cache database errors or report them as zero', async () => {
    repository.read.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.read({})).rejects.toThrow('database unavailable');
    expect(redis.set).not.toHaveBeenCalled();
    expect((await service.read({})).state).toBe('OK');
  });

  it('rejects disabled assets and invalid ranges before Redis or PostgreSQL', async () => {
    expect(() => service.read({ asset: ASSET_IDS.USDC_SOLANA_MAINNET })).toThrow(
      'Asset is not enabled',
    );
    expect(() => service.read({ range: '2d' as never })).toThrow('Invalid analytics range');
    expect(repository.read).not.toHaveBeenCalled();
  });

  it('returns unavailable rather than fabricated zero when no asset is configured', async () => {
    const unavailable = new ProtocolAnalyticsService(
      repository as unknown as ProtocolAnalyticsRepository,
      redis as unknown as Redis,
      [],
    );
    expect(await unavailable.read({})).toMatchObject({
      state: 'UNAVAILABLE',
      totals: null,
      escrow: null,
      asset: null,
    });
    expect(repository.read).not.toHaveBeenCalled();
  });

  it('isolates cache keys by enabled chains', async () => {
    const other = new ProtocolAnalyticsService(
      repository as unknown as ProtocolAnalyticsRepository,
      redis as unknown as Redis,
      [CHAIN_IDS.ROBINHOOD_TESTNET, CHAIN_IDS.SOLANA_DEVNET],
    );
    await service.read({});
    await other.read({});
    expect(repository.read).toHaveBeenCalledTimes(2);
    expect(redis.set.mock.calls[0][0]).not.toBe(redis.set.mock.calls[1][0]);
  });
});

describe('analytics input contracts', () => {
  it('validates range and asset inputs', async () => {
    const query = Object.assign(new ProtocolAnalyticsQueryDto(), { range: '100d', asset: 5 });
    expect((await validate(query)).map((error) => error.property).sort()).toEqual([
      'asset',
      'range',
    ]);
  });
  it('uses calendar UTC days and an equal-length previous period', () => {
    const now = new Date('2026-10-29T12:30:00Z');
    const window = analyticsWindow('7d', now);
    expect(window.from?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
    expect(window.to.getTime() - window.from!.getTime()).toBe(
      window.from!.getTime() - window.previousFrom!.getTime(),
    );
    expect(analyticsWindow('all', now).previousFrom).toBeNull();
  });
});
