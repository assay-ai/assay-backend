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
    redemptionLastError: null,
    ...overrides,
  } as RedeemableIntent;
}

class FakeRedeemer {
  readonly singles: RedeemVoucherRequest[] = [];
  readonly batches: RedeemVoucherRequest[][] = [];
  /** `seq` → the outcome that seq gets. Anything absent is REDEEMED. */
  outcomes: Record<string, RedeemOutcomeKind> = {};

  /** `undefined` leaves the port's method absent (the safe default, `true`). */
  ascending: boolean | undefined = undefined;

  /** `undefined` leaves `maxBatchSizeFor` absent, so the pass reads `maxBatchSize`. */
  perChain: number | undefined = undefined;

  constructor(readonly maxBatchSize: number) {}

  get maxBatchSizeFor(): (() => number) | undefined {
    const perChain = this.perChain;
    return perChain === undefined ? undefined : () => perChain;
  }

  get requiresAscendingSeq(): (() => boolean) | undefined {
    const ascending = this.ascending;
    return ascending === undefined ? undefined : () => ascending;
  }

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

function build(
  rows: RedeemableIntent[],
  maxBatchSize: number,
  chainState: {
    holdReason: (door: unknown, parties: { account: unknown }[]) => Promise<string | null>;
  } | null = null,
) {
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
    voidUnredeemed: jest.fn().mockResolvedValue(true),
  };
  const payments = {
    findAwaitingRedemption: jest.fn().mockResolvedValue(rows),
    lapseRedemption: jest.fn().mockResolvedValue(undefined),
    recordRedemptionError: jest.fn().mockResolvedValue(undefined),
    recordRedemptionRetry: jest.fn().mockResolvedValue(undefined),
  };

  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    redeemer as never,
    alerts as never,
    noBlocks(),
    () => NOW_SECONDS * 1000,
    chainState as never,
  );

  return { service, redeemer, intents, payments, emitted };
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
    const { service, redeemer, intents, payments } = build(
      [pending(1, ALICE), pending(2, BOB)],
      64,
    );
    redeemer.outcomes['2'] = RedeemOutcomeKind.UNREDEEMABLE;

    await service.run(USDC);

    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(ORG, 'intent-1', 'sig-1');
    // The unredeemable one is buyer debt: its hold stays open, nobody credited.
    expect(payments.lapseRedemption).toHaveBeenCalledTimes(1);
    expect(payments.lapseRedemption.mock.calls[0][1]).toBe('intent-2');
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

/**
 * D-23: on `eip155` each `(payer, seq)` is redeemed once, in any order, so the
 * hold-backs that exist only for Solana's `seq > seq_high` rule are off there
 * (`requiresAscendingSeq` is `false`). Solana keeps them.
 */
describe('VoucherRedemptionService — a chain that redeems any seq order', () => {
  function anyOrder(rows: RedeemableIntent[], maxBatchSize: number) {
    const built = build(rows, maxBatchSize);
    built.redeemer.ascending = false;
    return built;
  }

  it('asks the queue for every payer row, not only the lowest open seq', async () => {
    const { service, payments } = anyOrder([pending(5, ALICE)], 64);

    await service.run(USDC);

    expect(payments.findAwaitingRedemption.mock.calls[0][5]).toEqual({ orderedBySeq: false });
  });

  it('a Solana pass asks the queue exactly as before', async () => {
    const { service, payments, redeemer } = build([pending(5, ALICE)], 1);
    redeemer.ascending = true;

    await service.run(USDC);

    expect(payments.findAwaitingRedemption.mock.calls[0]).toHaveLength(5);
  });

  it('puts several of one payer’s vouchers in one batch', async () => {
    const { service, redeemer, intents } = anyOrder(
      [pending(5, ALICE), pending(6, ALICE), pending(9, BOB)],
      64,
    );

    await service.run(USDC);

    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['5', '6', '9']]);
    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(3);
  });

  it('batches at the asset chain’s size even when another chain wired caps maxBatchSize at 1', async () => {
    // The multiplexer's `maxBatchSize` is the minimum across chains, `1` while
    // the Solana redeemer is wired; an eip155 pass must still batch.
    const { service, redeemer, intents } = anyOrder(
      [pending(5, ALICE), pending(6, ALICE), pending(9, BOB)],
      1,
    );
    redeemer.perChain = 64;

    await service.run(USDC);

    expect(redeemer.singles).toEqual([]);
    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['5', '6', '9']]);
    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(3);
  });

  it('a chain whose own answer is 1 stays on the per-row path', async () => {
    const { service, redeemer } = build([pending(1, ALICE), pending(2, BOB)], 64);
    redeemer.perChain = 1;

    await service.run(USDC);

    expect(redeemer.batches).toEqual([]);
    expect(redeemer.singles.map((r) => r.seq)).toEqual(['1', '2']);
  });

  it('never puts the same (payer, seq) twice in one batch', async () => {
    // Two rows naming one voucher cannot exist (a unique index), but if they
    // did the second copy would revert the whole batch with VoucherSeqUsed.
    const twin = pending(5, ALICE, { id: 'intent-5-twin' });
    const { service, redeemer } = anyOrder([pending(5, ALICE), twin, pending(6, ALICE)], 64);

    await service.run(USDC);

    for (const batch of redeemer.batches) {
      const keys = batch.map((r) => `${r.payer}#${r.seq}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['5', '6'], ['5']]);
  });

  it('a retry does not hold back the payer’s later vouchers in a batch', async () => {
    const { service, redeemer, intents } = anyOrder(
      [pending(5, ALICE), pending(6, ALICE), pending(9, BOB)],
      64,
    );
    redeemer.outcomes['5'] = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(redeemer.batches.flat().map((r) => r.seq)).toEqual(['5', '6', '9']);
    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(2);
  });

  it('a retry does not hold back the payer’s later vouchers one by one either', async () => {
    const { service, redeemer } = anyOrder([pending(5, ALICE), pending(6, ALICE)], 1);
    redeemer.outcomes['5'] = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(redeemer.singles.map((r) => r.seq)).toEqual(['5', '6']);
  });

  it('a row that cannot be built holds back nothing', async () => {
    const { service, redeemer } = anyOrder(
      [pending(5, ALICE, { providerAccount: null }), pending(6, ALICE)],
      64,
    );

    await service.run(USDC);

    expect(redeemer.batches.map((batch) => batch.map((r) => r.seq))).toEqual([['6']]);
  });

  // Review 2026-10-23 I-1: a refused row waits out a back-off, so a run of
  // them cannot fill every pass's LIMIT ahead of rows that would redeem.
  it('backs off every row refused as retryable, batched or one by one, and only those', async () => {
    for (const maxBatchSize of [64, 1]) {
      const { service, redeemer, payments } = anyOrder(
        [pending(5, ALICE), pending(6, ALICE), pending(9, BOB)],
        maxBatchSize,
      );
      redeemer.outcomes['5'] = RedeemOutcomeKind.RETRY;
      redeemer.outcomes['9'] = RedeemOutcomeKind.RETRY;

      await service.run(USDC);

      expect(payments.recordRedemptionRetry.mock.calls.map((call) => call[1])).toEqual([
        'intent-5',
        'intent-9',
      ]);
    }
  });

  it('Solana retries every pass, as before: no back-off', async () => {
    const { service, redeemer, payments } = build([pending(5, ALICE)], 1);
    redeemer.ascending = true;
    redeemer.outcomes['5'] = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(redeemer.singles).toHaveLength(1);
    expect(payments.recordRedemptionRetry).not.toHaveBeenCalled();
  });

  it('Solana still holds back a payer’s later vouchers after a retry', async () => {
    const { service, redeemer } = build([pending(5, ALICE), pending(6, ALICE)], 1);
    redeemer.ascending = true;
    redeemer.outcomes['5'] = RedeemOutcomeKind.RETRY;

    await service.run(USDC);

    expect(redeemer.singles.map((r) => r.seq)).toEqual(['5']);
  });
});

describe('VoucherRedemptionService — the on-chain pause and blocklist (D-19)', () => {
  it('holds a voucher the chain would refuse, so the atomic batch carries only good ones', async () => {
    // Bob's payer is blocked on chain. One bad voucher in `redeemVoucherBatch`
    // reverts all 64; held, it keeps its hold and resumes after the unblock.
    const chainState = {
      holdReason: async (_door: unknown, parties: { role?: string; account: unknown }[]) =>
        parties.some((party) => party.role === 'PAYER' && party.account === BOB)
          ? 'the payer is blocked on chain'
          : null,
    };
    const { service, redeemer, intents } = build(
      [pending(5, ALICE), pending(9, BOB), pending(10, BOB)],
      64,
      chainState,
    );

    await service.run(USDC);

    const sent = [...redeemer.batches.flat(), ...redeemer.singles].map((r) => r.seq);
    expect(sent).toEqual(['5']);
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });
});
