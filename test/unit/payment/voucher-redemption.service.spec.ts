import { randomUUID } from 'node:crypto';

import { RedeemableIntent } from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
  VOUCHER_REDEMPTION_ALERTS,
} from '@modules/payment/constants/voucher-redemption.constants';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { Alert, AlertSeverity } from '@shared/alerting';

/**
 * `VoucherRedemptionService` — what happens to a rail-B hold after the verdict
 * passes.
 *
 * The three things worth asserting are all about money:
 *
 *  - the ORDER, because `seq_high` advancing past an undecided hold is what
 *    breaks the in-flight gap between acceptance and redemption;
 *  - who bears an unredeemable voucher — the buyer keeps their money and the
 *    provider is still paid, so neither of them does;
 *  - that a paused program stops the pass rather than burning a fee per hold.
 */

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const DECIMALS = getAssetMetadata(USDC).decimals;
const ORG = 'org-11111111-1111-4111-8111-111111111111';
const BUYER = `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo`;
/** A second buyer, so a per-account rule can be told from a per-pass one. */
const OTHER_BUYER = `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;
const PROVIDER_ACCOUNT = `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;
const PROVIDER_ORG = 'org-22222222-2222-4222-8222-222222222222';

const NOW_SECONDS = 1_800_000_000;

function pending(seq: number, overrides: Partial<RedeemableIntent> = {}): RedeemableIntent {
  return {
    organizationId: ORG,
    id: `intent-${seq}`,
    agentAccount: BUYER,
    providerAccount: PROVIDER_ACCOUNT,
    assetId: USDC,
    decimals: DECIMALS,
    priceAmount: '1000000',
    requestHash: 'cd'.repeat(32),
    voucherSeq: String(seq),
    voucherSignature: `signature-${seq}`,
    voucherResourceHash: `sha256:${'ab'.repeat(32)}`,
    voucherIssuedAt: String(NOW_SECONDS - 10),
    expiresAt: new Date((NOW_SECONDS + 300) * 1000),
    holdId: randomUUID(),
    providerId: PROVIDER_ORG,
    providerAmount: '800000',
    platformFee: '200000',
    ...overrides,
  };
}

class FakeRedeemer {
  readonly calls: RedeemVoucherRequest[] = [];
  outcome: RedeemOutcomeKind = RedeemOutcomeKind.REDEEMED;
  programError: string | null = null;

  /**
   * `1`, which is Solana's, and it is what keeps every assertion in this file
   * about the per-row pass. Batch forming has its own suite
   * (`voucher-redemption-batching.spec.ts`); this one pins the behaviour that
   * must stay byte-identical when a chain with a real batch is added beside it.
   */
  readonly maxBatchSize = 1;

  /** Present because the port has it. A `maxBatchSize` of 1 never reaches it. */
  async redeemBatch(requests: readonly RedeemVoucherRequest[]): Promise<readonly RedeemOutcome[]> {
    const outcomes: RedeemOutcome[] = [];
    for (const request of requests) {
      outcomes.push(await this.redeem(request));
    }
    return outcomes;
  }

  async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
    this.calls.push(request);
    return {
      kind: this.outcome,
      signature: this.outcome === RedeemOutcomeKind.REDEEMED ? `sig-${request.seq}` : null,
      programError: this.programError,
    };
  }
}

class FakeAlerts {
  readonly emitted: Alert[] = [];
  async emit(alert: Alert): Promise<void> {
    this.emitted.push(alert);
  }
}

function build(rows: RedeemableIntent[]) {
  const redeemer = new FakeRedeemer();
  const alerts = new FakeAlerts();
  const intents = {
    commitRedeemedHold: jest.fn().mockResolvedValue(undefined),
    releaseHold: jest.fn().mockResolvedValue(true),
  };
  const ledger = { appendNow: jest.fn().mockResolvedValue(undefined) };
  const payments = { findAwaitingRedemption: jest.fn().mockResolvedValue(rows) };

  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    ledger as never,
    redeemer as never,
    alerts as never,
    () => NOW_SECONDS * 1000,
  );

  return { service, redeemer, alerts, intents, ledger, payments };
}

describe('VoucherRedemptionService.run', () => {
  it("redeems a buyer's holds in ascending seq order", async () => {
    // The repository already orders; this asserts the service does not reorder
    // them, because out-of-order redemption advances `seq_high` past holds that
    // have not been decided and quietly voids the in-flight gap.
    const { service, redeemer } = build([pending(1), pending(2), pending(3)]);

    await service.run(USDC);

    expect(redeemer.calls.map((call) => call.seq)).toEqual(['1', '2', '3']);
  });

  it('retires each redeemed hold with the signature that moved the money', async () => {
    const { service, intents } = build([pending(1)]);

    await service.run(USDC);

    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(ORG, 'intent-1', 'sig-1');
  });

  it('carries every signed voucher field through to the redeemer, unmodified', async () => {
    const { service, redeemer } = build([pending(7)]);

    await service.run(USDC);

    expect(redeemer.calls[0]).toMatchObject({
      payer: BUYER,
      provider: PROVIDER_ACCOUNT,
      resourceHash: `sha256:${'ab'.repeat(32)}`,
      requestHash: 'cd'.repeat(32),
      seq: '7',
      issuedAt: NOW_SECONDS - 10,
      expiresAt: NOW_SECONDS + 300,
      signature: 'signature-7',
    });
    expect(redeemer.calls[0].amount.amount).toBe('1000000');
  });

  it('leaves a RETRY hold open for the next pass and retires nothing', async () => {
    const { service, redeemer, intents } = build([pending(1)]);
    redeemer.outcome = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('warns once when a hold outlives the window the program will still accept', async () => {
    const overdue = pending(1, {
      voucherIssuedAt: String(NOW_SECONDS - MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS - 1),
    });
    const { service, redeemer, alerts } = build([overdue]);
    redeemer.outcome = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(alerts.emitted).toContainEqual(
      expect.objectContaining({
        name: VOUCHER_REDEMPTION_ALERTS.OVERDUE,
        severity: AlertSeverity.WARN,
        dedupeKey: 'intent-1',
      }),
    );
  });

  it('gives the money back to the BUYER and charges the platform when a voucher is unredeemable', async () => {
    const { service, redeemer, alerts, intents, ledger } = build([pending(1)]);
    redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;
    redeemer.programError = 'VoucherTooOld';

    await service.run(USDC);

    // The buyer keeps the money — a release, never a commit.
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();

    // And the provider is still paid, out of the platform's own funds.
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: PROVIDER_ORG,
        accountId: PROVIDER_ACCOUNT,
        entryType: LedgerEntryType.PROVIDER_CREDIT,
        intentId: 'intent-1',
      }),
    );
    expect(ledger.appendNow.mock.calls[0][0].money.amount).toBe('800000');
    expect(ledger.appendNow.mock.calls[0][0].chainTxRef).toContain('platform_absorbed');

    expect(alerts.emitted).toContainEqual(
      expect.objectContaining({
        name: VOUCHER_REDEMPTION_ALERTS.UNREDEEMABLE,
        severity: AlertSeverity.CRITICAL,
      }),
    );
  });

  it('credits the provider BEFORE releasing the buyer, so a crash between them is recoverable', async () => {
    // Releasing first would take the row out of `findAwaitingRedemption`, and
    // the provider would never be paid. This way a crash leaves the row where
    // the next pass finds it, and the credit's own unique index refuses a
    // second one.
    const order: string[] = [];
    const { service, redeemer, intents, ledger } = build([pending(1)]);
    redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;
    ledger.appendNow.mockImplementation(async () => void order.push('credit'));
    intents.releaseHold.mockImplementation(async () => {
      order.push('release');
      return true;
    });

    await service.run(USDC);

    expect(order).toEqual(['credit', 'release']);
  });

  it('stops the whole pass when the program is paused, without burning a fee per hold', async () => {
    const { service, redeemer } = build([pending(1), pending(2), pending(3)]);
    redeemer.outcome = RedeemOutcomeKind.PAUSED;

    await service.run(USDC);

    expect(redeemer.calls).toHaveLength(1);
  });

  it('does not let one BUYER’s hold that throws stop another buyer’s', async () => {
    // Two different buyers: nothing about one buyer's failure says anything
    // about the other's sequence space.
    const { service, redeemer, intents } = build([
      pending(1),
      pending(2, { agentAccount: OTHER_BUYER }),
    ]);
    intents.commitRedeemedHold
      .mockRejectedValueOnce(new Error('ledger unavailable'))
      .mockResolvedValueOnce(undefined);

    await service.run(USDC);

    expect(redeemer.calls).toHaveLength(2);
    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(2);
  });

  it('holds back a buyer’s later vouchers when an earlier one did not land', async () => {
    // Lean v3 admits a voucher on `seq > escrow.seq_high` and nothing else, so
    // redeeming seq 2 while seq 1 is still being retried does not delay seq 1 —
    // it kills it. The call was served and the buyer keeps their money, so the
    // platform pays the provider out of its own funds. Skipping costs this
    // buyer one tick.
    const { service, redeemer } = build([pending(1), pending(2), pending(3)]);
    redeemer.outcome = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(redeemer.calls).toHaveLength(1);
    expect(redeemer.calls[0].seq).toBe('1');
  });

  it('lets a buyer’s next voucher through once the earlier one is settled', async () => {
    // `UNREDEEMABLE` closes the hold and nothing will ever redeem that seq, so
    // there is nothing left for a later seq to step over.
    const { service, redeemer } = build([pending(1), pending(2)]);
    redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;

    await service.run(USDC);

    expect(redeemer.calls.map((call) => call.seq)).toEqual(['1', '2']);
  });

  it('submits a buyer’s vouchers in the order the repository returned them', async () => {
    // The repository orders `(agent_account, voucher_seq)` ascending. This
    // asserts the service does not reorder them, because ascending seq is the
    // only order in which every voucher can land.
    const { service, redeemer } = build([pending(1), pending(2), pending(3)]);

    await service.run(USDC);

    expect(redeemer.calls.map((call) => call.seq)).toEqual(['1', '2', '3']);
  });

  it('skips a row with no provider to pay rather than guessing at one', async () => {
    const { service, redeemer } = build([pending(1, { providerAccount: null })]);

    await service.run(USDC);

    // Refused before the transaction is built: submitting a redemption whose
    // earnings account is derived from a provider the row does not name would
    // move a buyer's money to nobody.
    expect(redeemer.calls).toEqual([]);
  });
});
