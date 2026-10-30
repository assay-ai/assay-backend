import { Logger } from '@nestjs/common';

import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_EVM_REDEEMER_HOURLY_SPEND_WEI,
  EVM_REDEEMER_BUDGET_SPENT_ALERT,
  EvmRedeemerHourlyBudget,
  redeemerHourlyKey,
} from '@modules/chains/evm/evm-redeemer-hourly-budget';
import { Alert, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { FakeWeiWindowRedis } from './helpers/fake-wei-window-redis';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;

describe('EvmRedeemerHourlyBudget', () => {
  let redis: FakeWeiWindowRedis;
  let emitted: Alert[];

  beforeEach(() => {
    redis = new FakeWeiWindowRedis();
    emitted = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function budget(limit?: bigint) {
    const alerts = { emit: async (alert: Alert) => void emitted.push(alert) } as AlertPort;
    return new EvmRedeemerHourlyBudget(redis.asCache(), alerts, limit, () => 1_000_000);
  }

  it('defaults to 0.0003 ETH an hour', () => {
    expect(budget().limitWei).toBe(300_000_000_000_000n);
    expect(DEFAULT_EVM_REDEEMER_HOURLY_SPEND_WEI).toBe(3n * 10n ** 14n);
  });

  it('admits within the budget and defers past it, with a WARN once per hour', async () => {
    const hourly = budget(100n);

    expect(await hourly.take(TESTNET, 100n, false, 'redeemVoucher')).not.toBeNull();
    expect(await hourly.take(TESTNET, 1n, false, 'redeemVoucher')).toBeNull();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      name: EVM_REDEEMER_BUDGET_SPENT_ALERT,
      severity: AlertSeverity.WARN,
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: `${TESTNET}:ordinary`,
      suppressionWindowSeconds: 3600,
    });
  });

  it('lets an urgent send take the hour up to 2x the budget, and no further', async () => {
    const hourly = budget(100n);
    await hourly.take(TESTNET, 100n, false, 'batch');

    expect(await hourly.take(TESTNET, 100n, true, 'urgent')).not.toBeNull();
    expect(redis.total(redeemerHourlyKey(TESTNET))).toBe(200n);
    expect(await hourly.take(TESTNET, 1n, true, 'urgent')).toBeNull();

    expect(emitted.map((alert) => alert.severity)).toEqual([AlertSeverity.CRITICAL]);
    expect(emitted[0].dedupeKey).toBe(`${TESTNET}:urgent`);
  });

  it('asks a lazy urgency only when the ordinary budget refuses', async () => {
    const hourly = budget(100n);
    const urgent = jest.fn(async () => true);

    await hourly.take(TESTNET, 50n, urgent, 'collectHeld');
    expect(urgent).not.toHaveBeenCalled();

    expect(await hourly.take(TESTNET, 100n, urgent, 'refundHeld')).not.toBeNull();
    expect(urgent).toHaveBeenCalledTimes(1);
  });

  it('settles a charge to the actual cost', async () => {
    const hourly = budget(100n);
    const admission = await hourly.take(TESTNET, 100n, false, 'batch');

    await hourly.settle(admission!, 40n);
    expect(redis.total(redeemerHourlyKey(TESTNET))).toBe(40n);
  });

  it('when Redis cannot answer: defers an ordinary send, sends an urgent one uncounted', async () => {
    redis.failWith = new Error('ECONNREFUSED');
    const hourly = budget(100n);

    expect(await hourly.take(TESTNET, 1n, false, 'batch')).toBeNull();
    expect(await hourly.take(TESTNET, 1n, true, 'urgent')).toEqual({ ticket: null });
    expect(emitted).toEqual([]);
  });

  it('a failing alert sink never fails the decision', async () => {
    const alerts = {
      emit: async () => {
        throw new Error('telegram down');
      },
    } as unknown as AlertPort;
    const hourly = new EvmRedeemerHourlyBudget(redis.asCache(), alerts, 1n, () => 1);

    await expect(hourly.take(TESTNET, 5n, false, 'batch')).resolves.toBeNull();
  });
});
