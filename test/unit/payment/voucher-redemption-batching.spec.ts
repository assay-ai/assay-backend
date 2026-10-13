import { randomUUID } from 'node:crypto';

import { RedeemableIntent } from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { Alert } from '@shared/alerting';
import { noBlocks } from '../helpers/blocklist';

/**
 * Batch forming — the half of batched voucher redemption that lives in the
 * domain rather than in the chain adapter.
 *
 * The redeemer says how many vouchers fit in one transaction; this service says
 * WHICH ones may go together. Two rules decide it, and both were already the
 * per-row loop's:
 *
 *  - a buyer's vouchers are strictly ordered among themselves, because a lower
 *    `seq` that lands after a higher one is dead permanently;
 *  - a buyer whose voucher did not land has the rest of theirs held back.
 *
 * Taking **one row per payer** satisfies both at once, and is also what
 * `redeemVoucherBatch` needs: the same payer twice in one batch reverts the
 * batch on the second copy.
 */
const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const DECIMALS = getAssetMetadata(USDC).decimals;
const ORG = 'org-11111111-1111-4111-8111-111111111111';
const PROVIDER_ORG = 'org-22222222-2222-4222-8222-222222222222';
const PROVIDER_ACCOUNT = `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;
const ALICE = `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo`;
const BOB = `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;

const NOW_SECONDS = 1_800_000_000;

function pending(
  seq: number,
  agentAccount: string,
  overrides: Partial<RedeemableIntent> = {},
): RedeemableIntent {
  return {
    organizationId: ORG,
    id: `intent-${seq}`,
    agentAccount,
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
  } as RedeemableIntent;
}

class FakeRedeemer {
  readonly singles: RedeemVoucherRequest[] = [];
  readonly batches: RedeemVoucherRequest[][] = [];
  /** `seq` → the outcome that seq gets. Anything absent is REDEEMED. */
  outcomes: Record<string, RedeemOutcomeKind> = {};

  constructor(readonly maxBatchSize: number) {}

  async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
    this.singles.push(request);
    return this.outcomeFor(request);
  }

  async redeemBatch(requests: readonly RedeemVoucherRequest[]): Promise<readonly RedeemOutcome[]> {
    this.batches.push([...requests]);
    return requests.map((request) => this.outcomeFor(request));
  }

  private outcomeFor(request: RedeemVoucherRequest): RedeemOutcome {
    const kind = this.outcomes[request.seq] ?? RedeemOutcomeKind.REDEEMED;
    return {
      kind,
      signature: kind === RedeemOutcomeKind.REDEEMED ? `sig-${request.seq}` : null,
      programError: kind === RedeemOutcomeKind.REDEEMED ? null : 'EscrowInsufficient',
    };
  }
}

function build(rows: RedeemableIntent[], maxBatchSize: number) {
  const redeemer = new FakeRedeemer(maxBatchSize);
  const emitted: Alert[] = [];
  const alerts = {
    emit: async (alert: Alert) => {
      emitted.push(alert);
    },
  };
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
    noBlocks(),
    () => NOW_SECONDS * 1000,
  );

  return { service, redeemer, intents, ledger, emitted };
}

describe('VoucherRedemptionService batch forming', () => {
  it('with maxBatchSize 1 the pass is exactly what it was before', async () => {
    // Solana's behaviour must be byte-identical: one `redeem` per row, in the
    // repository's order, and no `redeemBatch` anywhere.
    const { service, redeemer, intents } = build(
      [pending(1, ALICE), pending(2, ALICE), pending(3, BOB)],
      1,
    );

    await service.run(USDC);

    expect(redeemer.batches).toEqual([]);
    expect(redeemer.singles.map((r) => r.seq)).toEqual(['1', '2', '3']);
    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(3);
  });

  it('takes at most one row per payer into a batch', async () => {
    // Two rows for Alice (seq 5 and 6) and one for Bob (seq 9). Only Alice's
    // LOWEST may go with Bob's: the same payer twice in one batch reverts the
    // batch on the second copy, because the first already advanced `seqHigh`.
    const { service, redeemer } = build(
      [pending(5, ALICE), pending(6, ALICE), pending(9, BOB)],
      64,
    );

    await service.run(USDC);

    expect(redeemer.batches[0].map((r) => r.seq)).toEqual(['5', '9']);
  });

  it('comes back for the rows a batch could not carry', async () => {
    // The control for the test above: "one per payer" must not mean "the rest
    // are dropped". Alice's seq 6 goes in the SECOND batch, after her seq 5
    // settled.
    const { service, redeemer, intents } = build(
      [pending(5, ALICE), pending(6, ALICE), pending(9, BOB)],
      64,
    );

    await service.run(USDC);

    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['5', '9'], ['6']]);
    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(3);
  });

  it('never puts more than maxBatchSize in one call', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      pending(i, `${CHAIN_IDS.SOLANA_DEVNET}:payer${i}`),
    );
    const { service, redeemer } = build(rows, 2);

    await service.run(USDC);

    expect(redeemer.batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('a payer whose item did not settle is blocked for the rest of the pass', async () => {
    // The invariant the per-row loop protects and the batch must not lose:
    // submitting Alice's seq 6 would advance `seq_high` past the seq 5 still
    // being retried and kill it outright.
    const { service, redeemer } = build(
      [pending(5, ALICE), pending(6, ALICE), pending(9, BOB)],
      64,
    );
    redeemer.outcomes['5'] = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['5', '9']]);
    expect(redeemer.batches.flat().map((r) => r.seq)).not.toContain('6');
  });

  it('applies each positional outcome to its OWN row', async () => {
    // `outcomes[i]` is `requests[i]`'s. Getting this wrong retires the wrong
    // hold and pays the wrong provider — and every row here is otherwise
    // identical, so only the index distinguishes them.
    const { service, redeemer, intents, ledger } = build([pending(1, ALICE), pending(2, BOB)], 64);
    redeemer.outcomes['2'] = RedeemOutcomeKind.UNREDEEMABLE;

    await service.run(USDC);

    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(ORG, 'intent-1', 'sig-1');
    // The unredeemable one is absorbed: the buyer keeps their money and the
    // provider is credited out of platform funds.
    expect(ledger.appendNow).toHaveBeenCalledTimes(1);
    expect(ledger.appendNow.mock.calls[0][0]).toMatchObject({ intentId: 'intent-2' });
  });

  it('stops the whole pass on PAUSED rather than forming another batch', async () => {
    const { service, redeemer } = build(
      [pending(1, ALICE), pending(2, ALICE), pending(3, BOB)],
      64,
    );
    redeemer.outcomes['1'] = RedeemOutcomeKind.PAUSED;

    await service.run(USDC);

    expect(redeemer.batches).toHaveLength(1);
  });

  it('stops the whole pass on MISCONFIGURED and pages', async () => {
    const { service, redeemer, emitted } = build(
      [pending(1, ALICE), pending(2, ALICE), pending(3, BOB)],
      64,
    );
    redeemer.outcomes['1'] = RedeemOutcomeKind.MISCONFIGURED;

    await service.run(USDC);

    expect(redeemer.batches).toHaveLength(1);
    expect(emitted.map((alert) => alert.name)).toContain('voucher_redemption_misconfigured');
  });

  it('keeps a row that cannot be built out of the batch, and blocks its payer', async () => {
    // A row with no provider can never be redeemed, and the buyer's LATER
    // vouchers must not step over it while a human decides what to do with the
    // hold.
    const { service, redeemer } = build(
      [pending(5, ALICE, { providerAccount: null }), pending(6, ALICE), pending(9, BOB)],
      64,
    );

    await service.run(USDC);

    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['9']]);
  });

  it('never sends the same payer twice across one batch', async () => {
    const rows = [pending(1, ALICE), pending(2, ALICE), pending(3, ALICE)];
    const { service, redeemer } = build(rows, 64);

    await service.run(USDC);

    for (const batch of redeemer.batches) {
      expect(new Set(batch.map((r) => r.payer)).size).toBe(batch.length);
    }
    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['1'], ['2'], ['3']]);
  });
});
