import { randomUUID } from 'node:crypto';

import {
  RedeemableIntent,
  RedemptionExclusions,
} from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS,
  REDEEM_GRACE_SECONDS,
  VOUCHER_REDEMPTION_ALERTS,
  VOUCHER_REDEMPTION_BATCH,
} from '@modules/payment/constants/voucher-redemption.constants';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { Alert, AlertSeverity } from '@shared/alerting';
import { BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';

import { blocklistOf, noBlocks } from '../helpers/blocklist';

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
    voucherDelegate: null,
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

function build(rows: RedeemableIntent[], blocklist = noBlocks()) {
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
    blocklist,
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

  /** Review S2-2: the redeemer pre-validates the signing delegate's grant. */
  it('carries the signing delegate to the redeemer, and null for the payer’s own voucher', async () => {
    const delegate = `${CHAIN_IDS.SOLANA_DEVNET}:Delegate11111111111111111111111111111111111`;
    const { service, redeemer } = build([pending(7, { voucherDelegate: delegate })]);
    await service.run(USDC);
    expect(redeemer.calls[0].delegate).toBe(delegate);

    const plain = build([pending(8)]);
    await plain.service.run(USDC);
    expect(plain.redeemer.calls[0].delegate).toBeNull();
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

/**
 * The queue as Postgres answers it: `ORDER BY agent_account, voucher_seq`,
 * the `LIMIT`, and the blocked-party exclusion applied BEFORE the limit (a
 * row is left out when it or an earlier seq of the same payer has a blocked
 * party). The redeemer models the chain's expiry: `VoucherExpired` once
 * `now > expiresAt + REDEEM_GRACE_SECONDS`. Audit T-1: the fake used to ignore
 * both the clock and `limit`, so it could not express E-1 or E-2.
 */
function realisticBuild(all: RedeemableIntent[], blocklist = noBlocks()) {
  let now = NOW_SECONDS;
  const calls: RedeemVoucherRequest[] = [];
  const redeemer = {
    maxBatchSize: 1,
    async redeemBatch(requests: readonly RedeemVoucherRequest[]) {
      return Promise.all(requests.map((request) => redeemer.redeem(request)));
    },
    async redeem(request: RedeemVoucherRequest): Promise<RedeemOutcome> {
      calls.push(request);
      if (now > request.expiresAt + REDEEM_GRACE_SECONDS) {
        return {
          kind: RedeemOutcomeKind.UNREDEEMABLE,
          signature: null,
          programError: 'VoucherExpired',
        };
      }
      return {
        kind: RedeemOutcomeKind.REDEEMED,
        signature: `sig-${request.seq}`,
        programError: null,
      };
    },
  };
  const open = new Set(all.map((row) => row.id));
  const intents = {
    commitRedeemedHold: jest.fn(async (_org: string, id: string) => void open.delete(id)),
    releaseHold: jest.fn(async ({ id }: { id: string }) => open.delete(id)),
  };
  const ledger = { appendNow: jest.fn().mockResolvedValue(undefined) };
  const walletKey = (account: string | null) =>
    account ? subjectKey(BlockSubjectKind.WALLET, account) : null;
  const payments = {
    findAwaitingRedemption: jest.fn(
      async (_a: string, _s: string, _r: string, limit: number, exclude?: RedemptionExclusions) => {
        const live = all.filter((row) => open.has(row.id));
        const blockedRow = (row: RedeemableIntent) =>
          !!exclude &&
          (exclude.organizationIds.includes(row.organizationId) ||
            exclude.organizationIds.includes(row.providerId ?? '') ||
            [row.agentAccount, row.providerAccount, row.voucherDelegate].some(
              (account) =>
                (walletKey(account) !== null && exclude.walletKeys.includes(walletKey(account)!)) ||
                (!!account && exclude.chainAccounts.includes(account.toLowerCase())),
            ));
        return live
          .filter(
            (row) =>
              !live.some(
                (other) =>
                  other.agentAccount === row.agentAccount &&
                  Number(other.voucherSeq) <= Number(row.voucherSeq) &&
                  blockedRow(other),
              ),
          )
          .sort(
            (a, b) =>
              a.agentAccount.localeCompare(b.agentAccount) ||
              Number(a.voucherSeq) - Number(b.voucherSeq),
          )
          .slice(0, limit);
      },
    ),
  };
  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    ledger as never,
    redeemer as never,
    new FakeAlerts() as never,
    blocklist,
    () => now * 1000,
  );
  return { service, calls, intents, ledger, payments, setNow: (s: number) => (now = s) };
}

describe('VoucherRedemptionService.run, with a party blocked', () => {
  const PROVIDER_UUID = '33333333-3333-4333-8333-333333333333';

  it('redeems nothing whose payer wallet is blocked, and keeps the hold open', async () => {
    const { service, redeemer, intents } = build(
      [pending(1), pending(2, { agentAccount: OTHER_BUYER })],
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: BUYER }),
    );

    await service.run(USDC);

    expect(redeemer.calls.map((call) => call.payer)).toEqual([OTHER_BUYER]);
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(1);
  });

  it('holds a voucher whose provider is blocked, and the payer’s later seqs behind it', async () => {
    const { service, redeemer } = build(
      [pending(1, { providerId: PROVIDER_UUID }), pending(2), pending(3)],
      blocklistOf({ kind: BlockSubjectKind.ORGANIZATION, subject: PROVIDER_UUID }),
    );

    await service.run(USDC);

    // Redeeming seq 2 would make seq 1 unredeemable for ever.
    expect(redeemer.calls).toEqual([]);
  });

  it('holds a voucher whose payee wallet or delegate is blocked', async () => {
    const delegate = `${CHAIN_IDS.SOLANA_DEVNET}:DeLeGaTe1111111111111111111111111111111111`;
    const payee = build(
      [pending(1)],
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: PROVIDER_ACCOUNT }),
    );
    await payee.service.run(USDC);
    expect(payee.redeemer.calls).toEqual([]);

    const signer = build(
      [pending(1, { voucherDelegate: delegate })],
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: delegate }),
    );
    await signer.service.run(USDC);
    expect(signer.redeemer.calls).toEqual([]);
  });

  it('resumes after a short block, inside the voucher’s on-chain life', async () => {
    const blocklist = blocklistOf({ kind: BlockSubjectKind.WALLET, subject: BUYER });
    const { service, calls, ledger, setNow } = realisticBuild([pending(1)], blocklist);
    await service.run(USDC);
    expect(calls).toEqual([]);

    setNow(NOW_SECONDS + 600); // a ten-minute block: expiresAt + grace not reached
    await blocklist.applied({
      kind: 'unblocked',
      subjectKind: BlockSubjectKind.WALLET,
      subjectKey: subjectKey(BlockSubjectKind.WALLET, BUYER) as string,
    });
    await service.run(USDC);
    expect(calls.map((call) => call.seq)).toEqual(['1']);
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });

  it('AUDIT E-2: past its on-chain expiry a held voucher is absorbed: provider paid, buyer not charged', async () => {
    // Owner decision: the platform bears a voucher held past its expiry.
    const blocklist = blocklistOf({ kind: BlockSubjectKind.WALLET, subject: BUYER });
    const { service, calls, ledger, intents, setNow } = realisticBuild([pending(1)], blocklist);
    await service.run(USDC);
    expect(calls).toEqual([]);

    setNow(NOW_SECONDS + 3600); // the block lasted an hour
    await blocklist.applied({
      kind: 'unblocked',
      subjectKind: BlockSubjectKind.WALLET,
      subjectKey: subjectKey(BlockSubjectKind.WALLET, BUYER) as string,
    });
    await service.run(USDC);
    expect(calls).toHaveLength(1);
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.PROVIDER_CREDIT }),
    );
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
  });

  it('AUDIT E-1: a blocked payer with a full batch of holds does not starve another buyer', async () => {
    const rows = [
      ...Array.from({ length: VOUCHER_REDEMPTION_BATCH + 5 }, (_, i) =>
        pending(i + 1, { id: `blocked-${i + 1}` }),
      ),
      pending(1, { id: 'honest-1', agentAccount: OTHER_BUYER }),
    ];
    // BUYER sorts before OTHER_BUYER, so its rows are at the head of the queue.
    expect(BUYER.localeCompare(OTHER_BUYER)).toBeLessThan(0);
    const { service, calls, payments } = realisticBuild(
      rows,
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: BUYER }),
    );
    await service.run(USDC);
    expect(calls.map((call) => call.payer)).toEqual([OTHER_BUYER]);
    expect(payments.findAwaitingRedemption.mock.calls[0][4]).toEqual({
      organizationIds: [],
      walletKeys: [subjectKey(BlockSubjectKind.WALLET, BUYER)],
      chainAccounts: [],
    });
  });

  it('AUDIT E-1: an on-chain blocked payer is left out of the query too', async () => {
    const rows = [pending(1), pending(1, { id: 'honest-1', agentAccount: OTHER_BUYER })];
    const { payments } = realisticBuild(rows);
    const chainState = {
      holdReason: jest.fn().mockResolvedValue(null),
      blockedAccounts: jest.fn().mockResolvedValue([BUYER.toLowerCase()]),
    };
    const service = new VoucherRedemptionService(
      payments as never,
      { commitRedeemedHold: jest.fn(), releaseHold: jest.fn() } as never,
      { appendNow: jest.fn() } as never,
      new FakeRedeemer() as never,
      new FakeAlerts() as never,
      noBlocks(),
      () => NOW_SECONDS * 1000,
      chainState as never,
    );
    await service.run(USDC);
    expect(chainState.blockedAccounts).toHaveBeenCalledWith(USDC.split('/')[0]);
    expect(payments.findAwaitingRedemption.mock.calls[0][4].chainAccounts).toEqual([
      BUYER.toLowerCase(),
    ]);
  });
});
