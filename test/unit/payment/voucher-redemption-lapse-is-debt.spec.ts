import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  DEBT_REFUSING_SQL,
  PaymentIntentRepository,
  RedeemableIntent,
} from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  DEBT_SPIKE_THRESHOLD,
  DEBT_SPIKE_WINDOW_SECONDS,
  VOUCHER_REDEMPTION_ALERTS,
} from '@modules/payment/constants/voucher-redemption.constants';
import {
  FEE_SPIKE_DEFERRED,
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import { BuyerDebtSpikeMonitor } from '@modules/payment/services/buyer-debt-spike.monitor';
import { PaymentIntentExpiryService } from '@modules/payment/services/payment-intent-expiry.service';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { Alert, AlertAggregation, AlertSeverity, SuppressingAlertSink } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import { noBlocks } from '../helpers/blocklist';

/**
 * Owner decision 2026-10-30: a voucher that can no longer be redeemed and
 * that the provider did not cause is BUYER DEBT, whatever left it unredeemed.
 * Nothing is voided automatically — the cases the reverted auto-void used to
 * void (an attempted send that never landed, an unnamed revert, a fee-spike
 * deferral) are debt, and an operator voids platform-caused debts in bulk
 * with a second operator (`M-1`). A burst of debts, counted from the table
 * wherever debt is made, pages once per asset per window.
 */

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const NOW = 1_800_000_000;
const ORG = 'org-buyer';
const PAYEE = `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;
const PROVIDER_ORG = '22222222-2222-4222-8222-222222222222';

function buyer(n: number): string {
  // Distinct payers, so the ordered (Solana) pass closes every row in one run.
  return `${CHAIN_IDS.SOLANA_DEVNET}:Buyer${String(n).padStart(4, '0')}${'1'.repeat(30)}`;
}

function row(overrides: Partial<RedeemableIntent> = {}): RedeemableIntent {
  return {
    organizationId: ORG,
    id: 'intent-1',
    agentAccount: buyer(0),
    providerAccount: PAYEE,
    assetId: USDC,
    decimals: getAssetMetadata(USDC).decimals,
    priceAmount: '1000000',
    requestHash: 'cd'.repeat(32),
    voucherSeq: '1',
    voucherSignature: 'sig',
    voucherResourceHash: `sha256:${'ab'.repeat(32)}`,
    voucherIssuedAt: String(NOW - 10),
    voucherDelegate: null,
    expiresAt: new Date((NOW + 300) * 1000),
    holdId: randomUUID(),
    providerId: PROVIDER_ORG,
    providerAmount: '800000',
    platformFee: '200000',
    redemptionLastError: null,
    ...overrides,
  };
}

function build(
  rows: () => RedeemableIntent[],
  outcome: { kind: RedeemOutcomeKind; programError: string | null },
) {
  const clock = { ms: NOW * 1000 };
  const emitted: Alert[] = [];
  const debtSpike = { check: jest.fn().mockResolvedValue(undefined) };
  const redeemer = {
    maxBatchSize: 1,
    async redeem(_request: RedeemVoucherRequest): Promise<RedeemOutcome> {
      return { kind: outcome.kind, signature: null, programError: outcome.programError };
    },
    async redeemBatch() {
      return [];
    },
    // The provider is clean, read live.
    providerBelowMinimumStake: jest.fn(async () => false),
  };
  const intents = {
    commitRedeemedHold: jest.fn().mockResolvedValue(undefined),
    releaseHold: jest.fn().mockResolvedValue(true),
  };
  const payments = {
    findAwaitingRedemption: jest.fn(async () => rows()),
    recordRedemptionError: jest.fn().mockResolvedValue(undefined),
    recordRedemptionRetry: jest.fn().mockResolvedValue(undefined),
    lapseRedemption: jest.fn().mockResolvedValue(undefined),
    recordProviderBlocks: jest.fn().mockResolvedValue(undefined),
  };
  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    redeemer as never,
    { emit: async (alert: Alert) => void emitted.push(alert) } as never,
    noBlocks(),
    () => clock.ms,
    null,
    debtSpike as never,
  );
  return { service, intents, payments, emitted, clock, debtSpike };
}

const EXPIRED = { kind: RedeemOutcomeKind.UNREDEEMABLE, programError: 'VoucherExpired' };

describe('VoucherRedemptionService — a lapse is buyer debt, never an automatic void', () => {
  it.each([
    ['an attempted send that never landed (no recorded refusal)', null, 'VoucherExpired'],
    ['an unnamed revert', 'UNKNOWN_REVERT:none', 'UNKNOWN_REVERT:none'],
    ['a fee-spike deferral recorded by an older build', FEE_SPIKE_DEFERRED, FEE_SPIKE_DEFERRED],
    ['a send failure recorded by an older build', 'PlatformSendFailed', 'PlatformSendFailed'],
  ])('%s becomes buyer debt with the hold kept open', async (_label, recorded, cause) => {
    const { service, intents, payments } = build(
      () => [row({ redemptionLastError: recorded, redemptionTxRefCount: 2 })],
      EXPIRED,
    );

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', cause);
    // Debt keeps the hold OPEN: nothing is released, nobody is credited.
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
  });

  it('a fee-spike deferral is not recorded on a row awaiting redemption', async () => {
    // Any recorded error kills the buyer's dispute refund guarantee
    // (`refundGuaranteedIfReported`); a deferral says nothing about the voucher.
    const { service, payments } = build(() => [row()], {
      kind: RedeemOutcomeKind.RETRY,
      programError: FEE_SPIKE_DEFERRED,
    });

    await service.run(USDC);

    expect(payments.recordRedemptionError).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });

  it('a named refusal on a RETRY is still recorded, as on main', async () => {
    const { service, payments } = build(() => [row()], {
      kind: RedeemOutcomeKind.RETRY,
      programError: 'EscrowInsufficient',
    });

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'EscrowInsufficient',
    );
  });
});

describe('VoucherRedemptionService — the buyer-debt spike check', () => {
  const lapsing = (count: number) =>
    Array.from({ length: count }, (_, i) => row({ id: `intent-${i}`, agentAccount: buyer(i) }));

  it('checks once per pass that made debt, for that asset, however many debts it made', async () => {
    const { service, debtSpike, payments } = build(() => lapsing(12), EXPIRED);

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledTimes(12);
    expect(debtSpike.check).toHaveBeenCalledTimes(1);
    expect(debtSpike.check).toHaveBeenCalledWith(new Date(NOW * 1000), USDC);
  });

  it('does not check after a pass that made no debt', async () => {
    const { service, debtSpike } = build(() => [row()], {
      kind: RedeemOutcomeKind.REDEEMED,
      programError: null,
    });

    await service.run(USDC);

    expect(debtSpike.check).not.toHaveBeenCalled();
  });
});

describe('BuyerDebtSpikeMonitor', () => {
  const NOW_DATE = new Date('2026-10-30T12:00:00Z');

  function monitorWith(counts: Array<{ assetId: string; count: number }> | Error) {
    const emitted: Alert[] = [];
    const payments = {
      countDebtsLapsedSince: jest.fn(async () => {
        if (counts instanceof Error) throw counts;
        return counts;
      }),
    };
    const monitor = new BuyerDebtSpikeMonitor(payments as never, {
      emit: async (alert: Alert) => void emitted.push(alert),
    });
    return { monitor, payments, emitted };
  }

  it('counts from the table over the window, so a restart loses nothing', async () => {
    const { monitor, payments } = monitorWith([]);

    await monitor.check(NOW_DATE, USDC);

    expect(payments.countDebtsLapsedSince).toHaveBeenCalledWith(
      new Date(NOW_DATE.getTime() - DEBT_SPIKE_WINDOW_SECONDS * 1000),
      USDC,
    );
  });

  it('stays quiet at the threshold', async () => {
    const { monitor, emitted } = monitorWith([{ assetId: USDC, count: DEBT_SPIKE_THRESHOLD }]);
    await monitor.check(NOW_DATE);
    expect(emitted).toEqual([]);
  });

  it('pages one aggregated CRITICAL alert per asset over the threshold, deduplicated per window', async () => {
    const OTHER = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831';
    const { monitor, emitted } = monitorWith([
      { assetId: USDC, count: DEBT_SPIKE_THRESHOLD + 1 },
      { assetId: OTHER, count: 3 },
    ]);

    await monitor.check(NOW_DATE);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      name: VOUCHER_REDEMPTION_ALERTS.DEBT_SPIKE,
      severity: AlertSeverity.CRITICAL,
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: USDC,
      suppressionWindowSeconds: DEBT_SPIKE_WINDOW_SECONDS,
      details: { asset: USDC, debts: DEBT_SPIKE_THRESHOLD + 1 },
    });
  });

  it('fires once per window through the suppressing sink, however often it is checked', async () => {
    const keys = new Set<string>();
    const redis = {
      set: jest.fn(async (key: string) => (keys.has(key) ? null : (keys.add(key), 'OK'))),
    };
    const delivered: Alert[] = [];
    const sink = new SuppressingAlertSink(
      { emit: async (alert: Alert) => void delivered.push(alert) },
      redis as never,
    );
    const payments = {
      countDebtsLapsedSince: jest.fn(async () => [
        { assetId: USDC, count: DEBT_SPIKE_THRESHOLD + 5 },
      ]),
    };
    // Two monitors: a restart between checks keeps the sink's window.
    await new BuyerDebtSpikeMonitor(payments as never, sink).check(NOW_DATE);
    await new BuyerDebtSpikeMonitor(payments as never, sink).check(NOW_DATE);

    expect(delivered).toHaveLength(1);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(`${VOUCHER_REDEMPTION_ALERTS.DEBT_SPIKE}:${USDC}`),
      '1',
      'EX',
      DEBT_SPIKE_WINDOW_SECONDS,
      'NX',
    );
  });

  it('never throws when the count cannot be read', async () => {
    const { monitor, emitted } = monitorWith(new Error('db down'));
    await expect(monitor.check(NOW_DATE)).resolves.toBeUndefined();
    expect(emitted).toEqual([]);
  });
});

describe('PaymentIntentExpiryService — verdict-deadline debts count toward the spike', () => {
  const NOW_DATE = new Date('2026-10-30T12:00:00Z');

  function sweepWith(expiresAt: Date) {
    let status = PaymentIntentStatus.VERIFYING;
    const repo = {
      findDueForExpiry: jest.fn().mockResolvedValue([]),
      findDueForHoldBackstop: jest.fn().mockResolvedValue([]),
      findTerminalWithUnreleasedHold: jest.fn().mockResolvedValue([]),
      findDueForVerdictDeadline: jest.fn(async () =>
        status === PaymentIntentStatus.VERIFYING
          ? [{ organizationId: ORG, id: 'late-1', status, holdId: 'hold-1' }]
          : [],
      ),
      findDueForWriteOff: jest.fn().mockResolvedValue([]),
      findClosedWithOpenHold: jest.fn().mockResolvedValue([]),
    };
    const intents = {
      findById: jest.fn(async () => ({
        id: 'late-1',
        status,
        price: MoneyUtil.of(1_000_000n, USDC, 6),
        rail: PaymentRail.RAIL_B_VOUCHER,
        chainId: CHAIN_IDS.SOLANA_DEVNET,
        expiresAt,
      })),
      resolve: jest.fn(async () => {
        status = PaymentIntentStatus.SETTLED;
        return { id: 'late-1', status };
      }),
      transition: jest.fn(),
      releaseHold: jest.fn(),
    };
    const debtSpike = { check: jest.fn().mockResolvedValue(undefined) };
    const service = new PaymentIntentExpiryService(
      repo as never,
      intents as never,
      { emit: jest.fn().mockResolvedValue(undefined) },
      null,
      debtSpike as never,
    );
    return { service, debtSpike };
  }

  it('checks every asset after the sweep settled a call as buyer debt', async () => {
    const { service, debtSpike } = sweepWith(new Date(NOW_DATE.getTime() - 24 * 3600 * 1000));
    await service.sweep(NOW_DATE);
    expect(debtSpike.check).toHaveBeenCalledWith(NOW_DATE);
  });

  it('does not check when the settled call is still redeemable (not debt)', async () => {
    const { service, debtSpike } = sweepWith(new Date(NOW_DATE.getTime() + 3600 * 1000));
    await service.sweep(NOW_DATE);
    expect(debtSpike.check).not.toHaveBeenCalled();
  });
});

describe('PaymentIntentRepository.countDebtsLapsedSince', () => {
  it('counts open rail-B debts lapsed in the window, on the open-debt index predicate', async () => {
    const dataSource = new DataSource({ type: 'postgres', entities: [PaymentIntentEntity] });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const repo = new PaymentIntentRepository(dataSource);
    const query = jest
      .spyOn(repo.manager, 'query')
      .mockResolvedValue([{ assetId: USDC, count: '12' }] as never);
    const since = new Date('2026-10-30T11:45:00Z');

    await expect(repo.countDebtsLapsedSince(since, USDC)).resolves.toEqual([
      { assetId: USDC, count: 12 },
    ]);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(DEBT_REFUSING_SQL);
    expect(sql).toContain(`"rail" = 'RAIL_B_VOUCHER'`);
    expect(sql).toContain(`"redemption_lapsed_at" >= $1`);
    expect(params).toEqual([since, USDC]);
  });
});
