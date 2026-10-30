import { Logger } from '@nestjs/common';

import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_EVM_REDEEMER_HOURLY_SPEND_WEI,
  DEFAULT_EVM_REDEEMER_PROVIDER_SHARE_BPS,
  EVM_REDEEMER_BUDGET_SPENT_ALERT,
  EVM_REDEEMER_BUDGET_UNCOUNTED_ALERT,
  EVM_REDEEMER_PROVIDER_SHARE_SPENT_ALERT,
  EvmRedeemerHourlyBudget,
  redeemerHourlyKey,
  redeemerProviderHourlyKey,
} from '@modules/chains/evm/evm-redeemer-hourly-budget';
import { Alert, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import { FakeWeiWindowRedis } from './helpers/fake-wei-window-redis';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const MAINNET = CHAIN_IDS.ROBINHOOD_MAINNET;

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

  let now: number;
  function budget(limit?: bigint, options = {}) {
    const alerts = { emit: async (alert: Alert) => void emitted.push(alert) } as AlertPort;
    now = 1_000_000;
    redis.clock = () => now;
    return new EvmRedeemerHourlyBudget(redis.asCache(), alerts, limit, () => now, options);
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
    // M-1: the first uncounted send of an outage is reported, once.
    expect(emitted.map((alert) => [alert.name, alert.severity])).toEqual([
      [EVM_REDEEMER_BUDGET_UNCOUNTED_ALERT, AlertSeverity.WARN],
    ]);
  });

  /**
   * Review 2026-10-30 M-1: while Redis cannot count, urgent sends were
   * unbounded. This process now sends at most one hourly budget of them per
   * outage window, then defers them, CRITICAL.
   */
  it('caps uncounted urgent sends at one budget per outage window, per process', async () => {
    redis.failWith = new Error('ECONNREFUSED');
    const hourly = budget(100n);

    expect(await hourly.take(TESTNET, 60n, true, 'urgent')).toEqual({ ticket: null });
    expect(await hourly.take(TESTNET, 40n, true, 'urgent')).toEqual({ ticket: null });
    expect(await hourly.take(TESTNET, 1n, true, 'urgent')).toBeNull();
    expect(emitted.map((alert) => alert.severity)).toEqual([
      AlertSeverity.WARN,
      AlertSeverity.CRITICAL,
    ]);
    expect(emitted[1]).toMatchObject({
      name: EVM_REDEEMER_BUDGET_UNCOUNTED_ALERT,
      dedupeKey: `${TESTNET}:uncounted-capped`,
      suppressionWindowSeconds: 3600,
    });
    // Another chain has its own cap.
    expect(await hourly.take(MAINNET, 100n, true, 'urgent')).toEqual({ ticket: null });

    // A new window opens an hour after the outage's first uncounted send.
    now += 3_600_000;
    expect(await hourly.take(TESTNET, 100n, true, 'urgent')).toEqual({ ticket: null });
  });

  it('counts the hour on the Redis server clock, not the app host (M-3)', async () => {
    const hourly = budget(100n);
    // The app host's clock is far ahead; the server's is what trims the window.
    const server = 5_000_000;
    redis.clock = () => server;
    now = 999_999_999;

    await hourly.take(TESTNET, 100n, false, 'batch');
    const [entry] = redis.sets.get(redeemerHourlyKey(TESTNET))!;
    expect(entry.score).toBe(server);
    expect(entry.member.startsWith(`${server}:`)).toBe(true);
    // Still in the server's hour, whatever the app host thinks.
    expect(await hourly.take(TESTNET, 1n, false, 'batch')).toBeNull();
  });

  describe('one provider’s share (review 2026-10-30 I-2)', () => {
    const A = 'eip155:46630:0xAAAA';
    const B = 'eip155:46630:0xBBBB';

    it('defaults to 25 % of the budget, and 25 % of the urgent allowance', () => {
      const hourly = budget(1_000n);
      expect(DEFAULT_EVM_REDEEMER_PROVIDER_SHARE_BPS).toBe(2_500);
      expect(hourly.providerLimitWei(false)).toBe(250n);
      expect(hourly.providerLimitWei(true)).toBe(500n);
    });

    it('stops one provider at its share while the others still redeem', async () => {
      const hourly = budget(1_000n);

      expect((await hourly.takeFor(TESTNET, 250n, false, 'r', [A])).admitted).toBe(true);
      const refused = await hourly.takeFor(TESTNET, 1n, false, 'r', [A]);
      expect(refused).toEqual({ admitted: false, admission: null, overShare: [A.toLowerCase()] });
      expect((await hourly.takeFor(TESTNET, 250n, false, 'r', [B])).admitted).toBe(true);

      expect(redis.total(redeemerHourlyKey(TESTNET))).toBe(500n);
      expect(redis.total(redeemerProviderHourlyKey(TESTNET, A))).toBe(250n);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        name: EVM_REDEEMER_PROVIDER_SHARE_SPENT_ALERT,
        severity: AlertSeverity.WARN,
        dedupeKey: `${TESTNET}:${A.toLowerCase()}`,
        suppressionWindowSeconds: 3600,
        details: expect.objectContaining({ provider: A.toLowerCase() }),
      });
    });

    it('splits a mixed batch by item count, all or nothing, and names only the providers over', async () => {
      const hourly = budget(1_000n);
      await hourly.takeFor(TESTNET, 200n, false, 'r', [A]);

      // 3 items of A, 1 of B, 400 wei: A's part is 300 (200 + 300 > 250).
      const mixed = await hourly.takeFor(TESTNET, 400n, false, 'r', [A, A, B, A]);
      expect(mixed.overShare).toEqual([A.toLowerCase()]);
      // Nothing of the refused batch was charged anywhere.
      expect(redis.total(redeemerHourlyKey(TESTNET))).toBe(200n);
      expect(redis.total(redeemerProviderHourlyKey(TESTNET, B))).toBe(0n);

      const rest = await hourly.takeFor(TESTNET, 100n, false, 'r', [B]);
      expect(rest.admitted).toBe(true);
    });

    it('lets an urgent send stretch to its 25 % share of the 2x allowance, and no further', async () => {
      const hourly = budget(1_000n);
      await hourly.takeFor(TESTNET, 250n, false, 'r', [A]);

      expect((await hourly.takeFor(TESTNET, 250n, true, 'r', [A])).admitted).toBe(true);
      expect((await hourly.takeFor(TESTNET, 1n, true, 'r', [A])).overShare).toEqual([
        A.toLowerCase(),
      ]);
    });

    it('a spent GLOBAL budget names no provider: everything waits', async () => {
      const hourly = budget(100n, { providerShareBps: 10_000 });
      await hourly.takeFor(TESTNET, 100n, false, 'r', [A]);

      expect(await hourly.takeFor(TESTNET, 1n, false, 'r', [B])).toEqual({
        admitted: false,
        admission: null,
        overShare: [],
      });
      expect(emitted[0].name).toBe(EVM_REDEEMER_BUDGET_SPENT_ALERT);
    });

    it('settles each part in proportion to the actual cost', async () => {
      const hourly = budget(1_000n);
      const verdict = await hourly.takeFor(TESTNET, 200n, false, 'r', [A, B]);

      await hourly.settle(verdict.admission!, 50n);
      expect(redis.total(redeemerHourlyKey(TESTNET))).toBe(50n);
      expect(redis.total(redeemerProviderHourlyKey(TESTNET, A))).toBe(25n);
      expect(redis.total(redeemerProviderHourlyKey(TESTNET, B))).toBe(25n);
    });
  });

  /**
   * Review 2026-10-30 M-7: with the budget spent, every pass simulated every
   * batch again only to be refused. A refusal now pauses the lane, in this
   * process, until the script says room frees.
   */
  describe('the pause after a refusal (M-7)', () => {
    const A = 'eip155:46630:0xAAAA';

    it('pauses the lane until the oldest charge leaves the window, then asks again', async () => {
      const hourly = budget(100n);
      expect(hourly.paused(TESTNET, false)).toBe(false);
      await hourly.take(TESTNET, 100n, false, 'batch');
      now += 60_000;
      await hourly.take(TESTNET, 1n, false, 'batch');

      expect(hourly.paused(TESTNET, false)).toBe(true);
      expect(hourly.paused(TESTNET, false, A)).toBe(true);
      // The urgent lane was not refused, so it is not paused.
      expect(hourly.paused(TESTNET, true)).toBe(false);
      expect(hourly.paused(MAINNET, false)).toBe(false);

      // The first charge (at 1,000,000) leaves at 1,000,000 + 1 h.
      now = 1_000_000 + 3_600_000 - 1;
      expect(hourly.paused(TESTNET, false)).toBe(true);
      now += 1;
      expect(hourly.paused(TESTNET, false)).toBe(false);
    });

    it('pauses one provider only when only its share refused', async () => {
      const hourly = budget(1_000n);
      await hourly.takeFor(TESTNET, 250n, false, 'r', [A]);
      await hourly.takeFor(TESTNET, 1n, false, 'r', [A]);

      expect(hourly.paused(TESTNET, false, A)).toBe(true);
      expect(hourly.paused(TESTNET, false, 'eip155:46630:0xBBBB')).toBe(false);
      expect(hourly.paused(TESTNET, false)).toBe(false);
    });

    it('a settle frees the pause: room may have come back', async () => {
      const hourly = budget(100n);
      const admission = await hourly.take(TESTNET, 100n, false, 'batch');
      await hourly.take(TESTNET, 1n, false, 'batch');
      expect(hourly.paused(TESTNET, false)).toBe(true);

      await hourly.settle(admission!, 10n);
      expect(hourly.paused(TESTNET, false)).toBe(false);
      expect(await hourly.take(TESTNET, 1n, false, 'batch')).not.toBeNull();
    });
  });

  it('a failing alert sink never fails the decision', async () => {
    const alerts = {
      emit: async () => {
        throw new Error('telegram down');
      },
    } as unknown as AlertPort;
    const hourly = new EvmRedeemerHourlyBudget(redis.asCache(), alerts, 1n, () => 1);
    redis.clock = () => 1;

    await expect(hourly.take(TESTNET, 5n, false, 'batch')).resolves.toBeNull();
  });
});
