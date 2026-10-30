import { randomUUID } from 'node:crypto';

import { RedeemableIntent } from '@database/postgres/repositories/payment-intent.repository';
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
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { Alert, AlertAggregation, AlertSeverity } from '@shared/alerting';

import { noBlocks } from '../helpers/blocklist';

/**
 * Owner decision 2026-10-30: a voucher that can no longer be redeemed and
 * that the provider did not cause is BUYER DEBT, whatever left it unredeemed.
 * Nothing is voided automatically — the cases the reverted auto-void used to
 * void (an attempted send that never landed, an unnamed revert, a fee-spike
 * deferral) are debt, and an operator voids platform-caused debts in bulk
 * with a second operator (`M-1`). A burst of debts pages once per window.
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
  );
  return { service, intents, payments, emitted, clock };
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

describe('VoucherRedemptionService — the buyer-debt spike alert', () => {
  const lapsing = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) =>
      row({ id: `intent-${from + i}`, agentAccount: buyer(from + i) }),
    );
  const spikes = (emitted: Alert[]) =>
    emitted.filter((alert) => alert.name === VOUCHER_REDEMPTION_ALERTS.DEBT_SPIKE);

  it('stays quiet at the threshold', async () => {
    const { service, payments, emitted } = build(() => lapsing(DEBT_SPIKE_THRESHOLD), EXPIRED);

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledTimes(DEBT_SPIKE_THRESHOLD);
    expect(spikes(emitted)).toEqual([]);
  });

  it('fires one aggregated CRITICAL alert per asset per window, then again in the next', async () => {
    let batch = lapsing(DEBT_SPIKE_THRESHOLD + 1);
    const { service, emitted, clock } = build(() => batch, EXPIRED);

    await service.run(USDC);
    expect(spikes(emitted)).toHaveLength(1);
    const [alert] = spikes(emitted);
    expect(alert.severity).toBe(AlertSeverity.CRITICAL);
    expect(alert.aggregation).toBe(AlertAggregation.ONCE_PER_INCIDENT);
    expect(alert.dedupeKey).toBe(USDC);
    expect(alert.suppressionWindowSeconds).toBe(DEBT_SPIKE_WINDOW_SECONDS);
    expect(alert.details).toMatchObject({ asset: USDC, debts: DEBT_SPIKE_THRESHOLD + 1 });

    // More debts in the same window: no second page.
    batch = lapsing(5, 100);
    clock.ms += 60_000;
    await service.run(USDC);
    expect(spikes(emitted)).toHaveLength(1);

    // A new burst after the window has passed pages again.
    batch = lapsing(DEBT_SPIKE_THRESHOLD + 1, 200);
    clock.ms += DEBT_SPIKE_WINDOW_SECONDS * 1000;
    await service.run(USDC);
    expect(spikes(emitted)).toHaveLength(2);
  });

  it('does not count debts that fell out of the sliding window', async () => {
    let batch = lapsing(DEBT_SPIKE_THRESHOLD);
    const { service, emitted, clock } = build(() => batch, EXPIRED);

    await service.run(USDC);
    batch = lapsing(1, 50);
    clock.ms += DEBT_SPIKE_WINDOW_SECONDS * 1000;
    await service.run(USDC);

    expect(spikes(emitted)).toEqual([]);
  });
});
