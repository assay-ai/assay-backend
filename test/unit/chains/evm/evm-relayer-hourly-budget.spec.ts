import { Logger } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  EVM_RELAYER_HOURLY_SEND_BUDGET,
  EVM_RELAYER_HOURLY_WINDOW_SECONDS,
  EvmRelayerHourlyBudget,
  relayerHourlyKey,
} from '@modules/chains/evm/evm-relayer-hourly-budget';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const MAINNET = CHAIN_IDS.ROBINHOOD_MAINNET;

/**
 * Runs the budget's Lua script's semantics over a map: drop what left the
 * window, refuse at the limit, else record. The real script is one EVAL, so
 * the count and the add cannot interleave across replicas.
 */
class FakeRedis {
  readonly sets = new Map<string, { score: number; member: string }[]>();
  failWith: Error | null = null;

  async eval(
    _script: string,
    _keys: number,
    key: string,
    now: string,
    windowMs: string,
    limit: string,
    member: string,
  ): Promise<number> {
    if (this.failWith) throw this.failWith;
    const kept = (this.sets.get(key) ?? []).filter(
      (entry) => entry.score > Number(now) - Number(windowMs),
    );
    if (kept.length >= Number(limit)) {
      this.sets.set(key, kept);
      return 0;
    }
    this.sets.set(key, [...kept, { score: Number(now), member }]);
    return 1;
  }
}

describe('EvmRelayerHourlyBudget', () => {
  let redis: FakeRedis;
  let now: number;

  beforeEach(() => {
    redis = new FakeRedis();
    now = 1_000_000;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function budget(limit?: number) {
    return new EvmRelayerHourlyBudget(
      { getRedisClient: () => redis } as unknown as CacheService,
      limit,
      () => now,
    );
  }

  it('defaults to the documented constant', () => {
    expect(budget().limit).toBe(EVM_RELAYER_HOURLY_SEND_BUDGET);
    expect(EVM_RELAYER_HOURLY_SEND_BUDGET).toBe(120);
  });

  it('admits up to the limit across all callers, then refuses, and counts only admitted sends', async () => {
    const hourly = budget(3);

    for (let i = 0; i < 3; i += 1) expect(await hourly.take(TESTNET, 'relayed')).toBe(true);
    expect(await hourly.take(TESTNET, 'relayed')).toBe(false);
    expect(await hourly.take(TESTNET, 'gas grant')).toBe(false);
    // Refusals are not recorded, so nobody can hold the window shut by asking.
    expect(redis.sets.get(relayerHourlyKey(TESTNET))).toHaveLength(3);
  });

  it('frees up as sends leave the window', async () => {
    const hourly = budget(1);
    expect(await hourly.take(TESTNET, 'relayed')).toBe(true);

    now += EVM_RELAYER_HOURLY_WINDOW_SECONDS * 1000 + 1;
    expect(await hourly.take(TESTNET, 'relayed')).toBe(true);
  });

  it('keeps one budget per chain: two floats, two budgets', async () => {
    const hourly = budget(1);

    expect(await hourly.take(TESTNET, 'relayed')).toBe(true);
    expect(await hourly.take(MAINNET, 'relayed')).toBe(true);
  });

  it('fails closed when the count cannot be made', async () => {
    redis.failWith = new Error('ECONNREFUSED');

    expect(await budget().take(TESTNET, 'relayed')).toBe(false);
  });
});
