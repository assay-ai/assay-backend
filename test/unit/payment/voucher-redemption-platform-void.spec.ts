import { randomUUID } from 'node:crypto';

import { RedeemableIntent } from '@database/postgres/repositories/payment-intent.repository';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  FEE_SPIKE_DEFERRED,
  VOUCHER_REDEMPTION_ALERTS,
} from '@modules/payment/constants/voucher-redemption.constants';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import {
  PROVIDER_FORFEIT_PREFIX,
  VoucherRedemptionService,
} from '@modules/payment/services/voucher-redemption.service';
import { Alert, AlertAggregation, AlertSeverity } from '@shared/alerting';

import { addBlock, noBlocks } from '../helpers/blocklist';

/**
 * Incident 2026-10-29: the redeemer ran out of gas, every send failed, and
 * the vouchers expired. They were closed as BUYER DEBT (`VoucherExpired`,
 * `UNKNOWN_REVERT:none`), blocking buyers who had done nothing. A voucher the
 * PLATFORM failed to redeem is now VOIDED: hold released, buyer not charged,
 * provider not paid. Buyer-side refusals and provider causes are unchanged,
 * and a voucher that actually landed is still committed.
 */

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const NOW = 1_800_000_000;
const ORG = 'org-buyer';
const BUYER = `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo`;
const PAYEE = `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;
/** Past `expiresAt + skew + grace + LANDING_SETTLE_SECONDS` for a voucher issued at NOW. */
const EXPIRED_AT = new Date((NOW - 3 * 3600) * 1000);

function row(overrides: Partial<RedeemableIntent> = {}): RedeemableIntent {
  return {
    organizationId: ORG,
    id: 'intent-1',
    agentAccount: BUYER,
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
    expiresAt: EXPIRED_AT,
    holdId: randomUUID(),
    providerId: '22222222-2222-4222-8222-222222222222',
    providerAmount: '800000',
    platformFee: '200000',
    redemptionLastError: null,
    ...overrides,
  };
}

const EXPIRED: RedeemOutcome = {
  kind: RedeemOutcomeKind.UNREDEEMABLE,
  signature: null,
  programError: 'VoucherExpired',
};

function build(
  rows: RedeemableIntent[],
  redeem: (request: RedeemVoucherRequest) => Promise<RedeemOutcome> = async () => EXPIRED,
  options: {
    landed?: string | null;
    refs?: string[];
    voided?: boolean;
    usedSeq?: () => Promise<string>;
  } = {},
) {
  const alerts: Alert[] = [];
  const redeemer: Record<string, unknown> = {
    maxBatchSize: 1,
    redeem: jest.fn(redeem),
    redeemBatch: jest.fn(async () => []),
    providerBelowMinimumStake: jest.fn(async () => false),
  };
  if (options.landed !== undefined) {
    redeemer.findLanding = jest.fn(async () => options.landed);
  }
  if (options.usedSeq !== undefined) {
    redeemer.usedSeqRecord = jest.fn(options.usedSeq);
  }
  const intents = {
    commitRedeemedHold: jest.fn().mockResolvedValue(undefined),
    releaseHold: jest.fn().mockResolvedValue(true),
    voidUnredeemed: jest.fn().mockResolvedValue(options.voided ?? true),
  };
  const payments = {
    findAwaitingRedemption: jest.fn().mockResolvedValue(rows),
    recordRedemptionError: jest.fn().mockResolvedValue(undefined),
    recordRedemptionTxRef: jest.fn().mockResolvedValue(undefined),
    findRedemptionTxRefs: jest.fn().mockResolvedValue(options.refs ?? []),
    lapseRedemption: jest.fn().mockResolvedValue(undefined),
    recordProviderBlocks: jest.fn().mockResolvedValue(undefined),
    recordPayerBlocks: jest.fn().mockResolvedValue(undefined),
  };
  const blocklist = noBlocks();
  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    redeemer as never,
    { emit: jest.fn(async (alert: Alert) => void alerts.push(alert)) } as never,
    blocklist,
    () => NOW * 1000,
  );
  return { service, intents, payments, redeemer, alerts, blocklist };
}

/** Voided, never debt, never credited, and with the payer's lock target. */
function expectVoided(
  intents: ReturnType<typeof build>['intents'],
  payments: ReturnType<typeof build>['payments'],
  reason: string,
  holdId: string,
) {
  expect(intents.voidUnredeemed).toHaveBeenCalledTimes(1);
  expect(intents.voidUnredeemed).toHaveBeenCalledWith(
    { organizationId: ORG, id: 'intent-1', payer: BUYER, holdId },
    reason,
  );
  expect(payments.lapseRedemption).not.toHaveBeenCalled();
  expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
  expect(intents.releaseHold).not.toHaveBeenCalled();
}

describe('VoucherRedemptionService — a voucher the platform failed to redeem is voided', () => {
  it('an expiry after only transport failures voids: hold released, no debt, no credit', async () => {
    const live = row({ expiresAt: new Date((NOW + 300) * 1000) });
    let sendFails = true;
    const { service, intents, payments, redeemer } = build([live], async () => {
      if (sendFails) throw new Error('eth_sendRawTransaction failed: code -32000');
      return EXPIRED;
    });

    // While the redeemer cannot send: nothing is recorded, nothing is closed.
    await service.run(USDC);
    expect(payments.recordRedemptionError).not.toHaveBeenCalled();
    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();

    // Past the deadline the chain answers `VoucherExpired` with no recorded cause.
    sendFails = false;
    payments.findAwaitingRedemption.mockResolvedValue([{ ...live, expiresAt: EXPIRED_AT }]);
    await service.run(USDC);

    expect(redeemer.redeem).toHaveBeenCalledTimes(2);
    expectVoided(intents, payments, 'voided:PLATFORM_UNREDEEMED', live.holdId);
  });

  it('voids only once the chain says the seq was never used', async () => {
    const expired = row();
    const { service, intents, payments, redeemer } = build([expired], undefined, {
      usedSeq: async () => 'NONE',
    });

    await service.run(USDC);

    expect(redeemer.usedSeqRecord).toHaveBeenCalledTimes(1);
    expectVoided(intents, payments, 'voided:PLATFORM_UNREDEEMED', expired.holdId);
  });

  it('never voids a seq the chain shows as used: it goes the VoucherSeqUsed way', async () => {
    const expired = row();
    const { service, intents, payments } = build([expired], undefined, {
      usedSeq: async () => 'MISMATCH',
    });

    await service.run(USDC);

    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('keeps the hold open when the chain record cannot be read', async () => {
    const expired = row();
    const { service, intents, payments } = build([expired], undefined, {
      usedSeq: async () => {
        throw new Error('rpc down');
      },
    });

    await service.run(USDC);

    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('UNKNOWN_REVERT:none recorded on the retries voids', async () => {
    const expired = row({ redemptionLastError: 'UNKNOWN_REVERT:none' });
    const { service, intents, payments } = build([expired]);

    await service.run(USDC);

    expectVoided(intents, payments, 'voided:PLATFORM_UNKNOWN_REVERT', expired.holdId);
  });

  it('a refusal UNKNOWN_REVERT:0x… with a selector nobody names voids too', async () => {
    const expired = row({ redemptionLastError: 'UNKNOWN_REVERT:0xdeadbeef' });
    const { service, intents, payments } = build([expired]);

    await service.run(USDC);

    expectVoided(intents, payments, 'voided:PLATFORM_UNKNOWN_REVERT', expired.holdId);
  });

  it('FeeSpikeDeferred as the last refusal voids', async () => {
    expect(FEE_SPIKE_DEFERRED).toBe('FeeSpikeDeferred');
    const expired = row({ redemptionLastError: FEE_SPIKE_DEFERRED });
    const { service, intents, payments } = build([expired]);

    await service.run(USDC);

    expectVoided(intents, payments, 'voided:PLATFORM_FEE_SPIKE_DEFERRED', expired.holdId);
  });

  it('pages once per asset and cause, aggregated, not once per voucher', async () => {
    const rows = [
      row({ id: 'intent-1' }),
      row({ id: 'intent-2', voucherSeq: '2' }),
      row({ id: 'intent-3', voucherSeq: '3' }),
    ];
    const { service, intents, alerts } = build(rows);

    await service.run(USDC);

    expect(intents.voidUnredeemed).toHaveBeenCalledTimes(3);
    const voided = alerts.filter((a) => a.name === VOUCHER_REDEMPTION_ALERTS.PLATFORM_VOIDED);
    expect(voided).toHaveLength(3);
    for (const alert of voided) {
      expect(alert.severity).toBe(AlertSeverity.CRITICAL);
      expect(alert.aggregation).toBe(AlertAggregation.ONCE_PER_INCIDENT);
      expect(alert.dedupeKey).toBe(`${USDC}:PLATFORM_UNREDEEMED`);
    }
    // Not reported as buyer debt.
    expect(alerts.map((a) => a.name)).not.toContain(VOUCHER_REDEMPTION_ALERTS.UNREDEEMABLE);
  });

  it('a row that changed underneath is left alone and does not page', async () => {
    const { service, alerts, payments } = build([row()], undefined, { voided: false });

    await service.run(USDC);

    expect(alerts).toEqual([]);
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });
});

describe('VoucherRedemptionService — what is NOT a platform void', () => {
  it('a buyer tightening (DelegateIsRevoked) still becomes buyer debt', async () => {
    const { service, intents, payments, alerts } = build([
      row({ redemptionLastError: 'DelegateIsRevoked' }),
    ]);

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'DelegateIsRevoked');
    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(alerts.map((a) => a.name)).toContain(VOUCHER_REDEMPTION_ALERTS.UNREDEEMABLE);
  });

  it('an empty escrow (EscrowInsufficient) still becomes buyer debt', async () => {
    const { service, intents, payments } = build([
      row({ redemptionLastError: 'EscrowInsufficient' }),
    ]);

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'EscrowInsufficient');
    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
  });

  it('a payer block recorded while frozen still becomes buyer debt', async () => {
    const { service, intents, payments } = build([row({ redemptionLastError: 'PayerBlocked' })]);

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'PayerBlocked');
    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
  });

  it('an unclassified named refusal takes the buyer-debt default', async () => {
    const { service, intents, payments } = build([row()], async () => ({
      kind: RedeemOutcomeKind.UNREDEEMABLE,
      signature: null,
      programError: 'VoucherSeqNotIncreasing',
    }));

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'VoucherSeqNotIncreasing',
    );
    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
  });

  it('a provider cause still forfeits', async () => {
    const { service, intents, payments } = build([
      row({ redemptionLastError: 'ProviderBelowMinimumStake' }),
    ]);

    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}ProviderBelowMinimumStake`,
    );
    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });

  it('a voucher that landed is committed with its transaction, never voided', async () => {
    const { service, intents, payments } = build([row()], undefined, {
      landed: '0xlanded',
      refs: ['0xlanded'],
    });

    await service.run(USDC);

    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(ORG, 'intent-1', '0xlanded');
    expect(intents.voidUnredeemed).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });

  it('records a payer-side block each pass, keeping provider causes', async () => {
    const { service, payments, blocklist } = build([]);
    addBlock(blocklist, { kind: BlockSubjectKind.WALLET, subject: BUYER });

    await service.run(USDC);

    expect(payments.recordPayerBlocks).toHaveBeenCalledWith(
      USDC,
      expect.objectContaining({ walletKeys: expect.any(Array) }),
      'PayerBlocked',
      expect.arrayContaining(['ProviderBelowMinimumStake', 'ProviderBlocked', 'PayeeBlocked']),
    );
  });
});
