import { Logger } from '@nestjs/common';

import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { readWeiBudget } from '@modules/chains/evm/evm-hourly-wei-budget';
import {
  DEFAULT_EVM_RELAYER_HOURLY_SPEND_WEI,
  DEFAULT_EVM_RELAYER_RESERVED_LANE_WEI,
  EVM_RELAYER_HOURLY_WINDOW_SECONDS,
  EvmRelayerHourlyBudget,
  relayerHourlyKey,
  relayerReservedLaneAccountKey,
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

  function budget(limit?: bigint, reserved?: bigint, options = {}) {
    // The window counts on the Redis SERVER's clock (review 2026-10-30 M-3).
    redis.clock = () => now;
    return new EvmRelayerHourlyBudget(redis.asCache(), limit, reserved, {
      // The whole lane to one account unless a test says otherwise.
      reservedAccountShareBps: 10_000,
      ...options,
    });
  }

  const FUNDED = { balance: 1_000_000n, withdrawRequested: 0n };
  type Holding = typeof FUNDED | null;

  const spend = (
    wei: bigint,
    funded: boolean | (() => Promise<boolean>) = false,
    account = '0xBuyer',
  ) => ({
    wei,
    purpose: 'relayed SET_LIMITS',
    account,
    escrow:
      typeof funded === 'function'
        ? async (): Promise<Holding> => ((await funded()) ? FUNDED : null)
        : funded
          ? FUNDED
          : null,
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

  it('admits to the reserved lane only an account holding at least $1 (review 2026-10-30 I-3)', async () => {
    const hourly = budget(10n, 50n);
    await hourly.take(TESTNET, spend(10n));
    const holding = (balance: bigint, withdrawRequested = 0n) => ({
      wei: 1n,
      purpose: 'relayed SET_LIMITS',
      account: '0xBuyer',
      escrow: { balance, withdrawRequested },
    });

    expect(hourly.reservedMinBalanceAtomic).toBe(1_000_000n);
    // A dust deposit is not "funded".
    expect(await hourly.take(TESTNET, holding(1n))).toBeNull();
    expect(await hourly.take(TESTNET, holding(999_999n))).toBeNull();
    expect(await hourly.take(TESTNET, holding(1_000_000n))).not.toBeNull();
    // A pending withdrawal of at least the minimum counts too.
    expect(await hourly.take(TESTNET, holding(0n, 1_000_000n))).not.toBeNull();
    expect(await hourly.take(TESTNET, holding(0n, 999_999n))).toBeNull();
  });

  it('honours a configured minimum', async () => {
    const hourly = budget(0n, 50n, { reservedMinBalanceAtomic: 5n });
    expect(
      await hourly.take(TESTNET, {
        wei: 1n,
        purpose: 'p',
        account: '0xA',
        escrow: { balance: 5n, withdrawRequested: 0n },
      }),
    ).not.toBeNull();
  });

  it('caps one account at its share of the reserved lane, 10 % by default (I-3)', async () => {
    const defaults = new EvmRelayerHourlyBudget(redis.asCache(), 0n, 1_000n);
    expect(defaults.reservedAccountShareBps).toBe(1_000);
    expect(defaults.reservedAccountWei).toBe(100n);

    redis.clock = () => now;
    expect(await defaults.take(TESTNET, spend(100n, true, '0xA'))).not.toBeNull();
    // The same account, any case of its address, is refused past its share…
    expect(await defaults.take(TESTNET, spend(1n, true, '0xa'))).toBeNull();
    // …and the lane itself is untouched by the refusal.
    expect(redis.total(relayerReservedLaneKey(TESTNET))).toBe(100n);
    // Another funded account still has its own share.
    expect(await defaults.take(TESTNET, spend(100n, true, '0xB'))).not.toBeNull();
    expect(redis.total(relayerReservedLaneAccountKey(TESTNET, '0xA'))).toBe(100n);
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
