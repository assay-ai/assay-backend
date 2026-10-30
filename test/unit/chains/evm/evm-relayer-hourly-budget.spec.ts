import { Logger } from '@nestjs/common';

import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { readWeiBudget } from '@modules/chains/evm/evm-hourly-wei-budget';
import {
  DEFAULT_EVM_RELAYER_HOURLY_SPEND_WEI,
  DEFAULT_EVM_RELAYER_RESERVED_LANE_WEI,
  EVM_RELAYER_HOURLY_WINDOW_SECONDS,
  EvmRelayerHourlyBudget,
  relayerHourlyKey,
  relayerReservedLaneKey,
} from '@modules/chains/evm/evm-relayer-hourly-budget';

import { FakeWeiWindowRedis } from './helpers/fake-wei-window-redis';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const MAINNET = CHAIN_IDS.ROBINHOOD_MAINNET;

describe('EvmRelayerHourlyBudget (wei, with a reserved lane)', () => {
  let redis: FakeWeiWindowRedis;
  let now: number;

  beforeEach(() => {
    redis = new FakeWeiWindowRedis();
    now = 1_000_000;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function budget(limit?: bigint, reserved?: bigint) {
    return new EvmRelayerHourlyBudget(redis.asCache(), limit, reserved, () => now);
  }

  const spend = (wei: bigint, funded: boolean | (() => Promise<boolean>) = false) => ({
    wei,
    purpose: 'relayed SET_LIMITS',
    funded,
  });

  it('defaults to 0.0002 ETH shared and 0.0001 ETH reserved an hour', () => {
    expect(budget().limitWei).toBe(200_000_000_000_000n);
    expect(budget().reservedWei).toBe(100_000_000_000_000n);
    expect(DEFAULT_EVM_RELAYER_HOURLY_SPEND_WEI).toBe(2n * 10n ** 14n);
    expect(DEFAULT_EVM_RELAYER_RESERVED_LANE_WEI).toBe(10n ** 14n);
  });

  it('counts wei, not sends: admits while the sum stays within the limit, refuses the rest', async () => {
    const hourly = budget(100n, 0n);

    expect(await hourly.take(TESTNET, spend(60n))).not.toBeNull();
    expect(await hourly.take(TESTNET, spend(40n))).not.toBeNull();
    expect(await hourly.take(TESTNET, spend(1n))).toBeNull();
    // Refusals are not recorded, so nobody can hold the window shut by asking.
    expect(redis.total(relayerHourlyKey(TESTNET))).toBe(100n);
  });

  it('one expensive send can spend what many cheap ones would', async () => {
    const hourly = budget(100n, 0n);
    expect(await hourly.take(TESTNET, spend(100n))).not.toBeNull();
    expect(await hourly.take(TESTNET, spend(1n))).toBeNull();
  });

  it('frees up as sends leave the window', async () => {
    const hourly = budget(100n, 0n);
    expect(await hourly.take(TESTNET, spend(100n))).not.toBeNull();

    now += EVM_RELAYER_HOURLY_WINDOW_SECONDS * 1000 + 1;
    expect(await hourly.take(TESTNET, spend(100n))).not.toBeNull();
  });

  it('keeps one budget per chain: two floats, two budgets', async () => {
    const hourly = budget(100n, 0n);

    expect(await hourly.take(TESTNET, spend(100n))).not.toBeNull();
    expect(await hourly.take(MAINNET, spend(100n))).not.toBeNull();
  });

  it('gives a funded account the reserved lane once the shared lane is spent; never an unfunded one', async () => {
    const hourly = budget(100n, 50n);
    expect(await hourly.take(TESTNET, spend(100n))).not.toBeNull();

    expect(await hourly.take(TESTNET, spend(10n, false))).toBeNull();
    expect(await hourly.take(TESTNET, spend(30n, true))).not.toBeNull();
    expect(
      await hourly.take(
        TESTNET,
        spend(20n, async () => true),
      ),
    ).not.toBeNull();
    // The reserve has its own ceiling.
    expect(await hourly.take(TESTNET, spend(1n, true))).toBeNull();
    expect(redis.total(relayerReservedLaneKey(TESTNET))).toBe(50n);
  });

  it('asks whether the account is funded only when the shared lane refuses', async () => {
    const hourly = budget(100n, 50n);
    const funded = jest.fn(async () => true);

    await hourly.take(TESTNET, spend(10n, funded));
    expect(funded).not.toHaveBeenCalled();

    await hourly.take(TESTNET, spend(95n, funded));
    expect(funded).toHaveBeenCalledTimes(1);
  });

  it('treats a funded check that throws as unfunded', async () => {
    const hourly = budget(10n, 50n);
    await hourly.take(TESTNET, spend(10n));

    const funded = async () => {
      throw new Error('rpc down');
    };
    expect(await hourly.take(TESTNET, spend(10n, funded))).toBeNull();
  });

  it('settles a charge to the actual cost, freeing what the estimate over-counted', async () => {
    const hourly = budget(100n, 0n);
    const ticket = await hourly.take(TESTNET, spend(100n));
    expect(ticket).not.toBeNull();

    await hourly.settle(ticket!, 30n);
    expect(redis.total(relayerHourlyKey(TESTNET))).toBe(30n);
    expect(await hourly.take(TESTNET, spend(70n))).not.toBeNull();
  });

  it('fails closed when the sum cannot be made', async () => {
    redis.failWith = new Error('ECONNREFUSED');

    expect(await budget().take(TESTNET, spend(1n, true))).toBeNull();
  });
});

describe('readWeiBudget', () => {
  it('reads a whole number of wei, defaults when unset, and refuses anything else', () => {
    expect(readWeiBudget(undefined, 7n, 'X')).toBe(7n);
    expect(readWeiBudget(' ', 7n, 'X')).toBe(7n);
    expect(readWeiBudget('123', 7n, 'X')).toBe(123n);
    expect(() => readWeiBudget('1e14', 7n, 'X')).toThrow();
    expect(() => readWeiBudget('-1', 7n, 'X')).toThrow();
  });
});
