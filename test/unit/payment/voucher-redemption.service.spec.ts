import { randomUUID } from 'node:crypto';

import {
  RedeemableIntent,
  RedemptionExclusions,
} from '@database/postgres/repositories/payment-intent.repository';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
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
import {
  PROVIDER_FORFEIT_PREFIX,
  VoucherRedemptionService,
} from '@modules/payment/services/voucher-redemption.service';
import { Alert, AlertSeverity } from '@shared/alerting';
import { BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';

import { addBlock, blocklistOf, noBlocks } from '../helpers/blocklist';

/**
 * `VoucherRedemptionService` — what happens to a rail-B hold after the verdict
 * passes.
 *
 * The three things worth asserting are all about money:
 *
 *  - the ORDER, because `seq_high` advancing past an undecided hold is what
 *    breaks the in-flight gap between acceptance and redemption;
 *  - who bears an unredeemable voucher — never the platform: the provider
 *    forfeits when it caused it, otherwise the call becomes buyer debt (the
 *    hold stays open and nobody is credited);
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
    redemptionLastError: null,
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
  const payments = {
    findAwaitingRedemption: jest.fn().mockResolvedValue(rows),
    recordRedemptionError: jest.fn().mockResolvedValue(undefined),
    lapseRedemption: jest.fn().mockResolvedValue(undefined),
    recordProviderBlocks: jest.fn().mockResolvedValue(undefined),
  };

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

  it('turns an unredeemable voucher into BUYER DEBT: hold kept open, nobody credited, pages', async () => {
    const { service, redeemer, alerts, intents, ledger, payments } = build([pending(1)]);
    redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;
    redeemer.programError = 'VoucherTooOld';

    await service.run(USDC);

    // The buyer's hold stays OPEN — neither released nor committed — and the
    // platform credits nobody: the buyer owes the call until it re-signs.
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'VoucherTooOld');

    expect(alerts.emitted).toContainEqual(
      expect.objectContaining({
        name: VOUCHER_REDEMPTION_ALERTS.UNREDEEMABLE,
        severity: AlertSeverity.CRITICAL,
      }),
    );
    expect(alerts.emitted[0].summary).toContain('buyer debt');
    expect(alerts.emitted[0].summary).not.toContain('platform pays the provider');
  });

  it('never writes a platform_absorbed credit, whatever the refusal', async () => {
    for (const programError of [
      'DelegateIsRevoked',
      'DelegateIsExpired',
      'VoucherExpired',
      'VoucherSeqNotIncreasing',
      null,
    ]) {
      const { service, redeemer, ledger } = build([pending(1)]);
      redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;
      redeemer.programError = programError;
      await service.run(USDC);
      expect(ledger.appendNow).not.toHaveBeenCalled();
    }
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
    // `UNREDEEMABLE` lapses that seq — nothing will ever redeem it (a
    // replacement takes a new seq) — so there is nothing left to step over.
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
  /** The provider's bonded stake is below the program's minimum (it unstaked). */
  let stakeBelowMinimum = false;
  const lastErrors = new Map<string, string>();
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
      if (stakeBelowMinimum) {
        return {
          kind: RedeemOutcomeKind.RETRY,
          signature: null,
          programError: 'ProviderBelowMinimumStake',
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
        const live = all
          .filter((row) => open.has(row.id))
          .map((row) => ({ ...row, redemptionLastError: lastErrors.get(row.id) ?? null }));
        // Payer-side parties only: a blocked provider or payee is returned and
        // forfeited by the pass, not left waiting in the queue.
        const blockedRow = (row: RedeemableIntent) =>
          !!exclude &&
          (exclude.organizationIds.includes(row.organizationId) ||
            [row.agentAccount, row.voucherDelegate].some(
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
    recordRedemptionError: jest.fn(async (_org: string, id: string, error: string) => {
      lastErrors.set(id, error);
    }),
    // A lapsed row leaves the queue and keeps its hold (it is not released).
    lapseRedemption: jest.fn(async (_org: string, id: string, cause: string) => {
      lastErrors.set(id, cause);
      open.delete(id);
    }),
    recordProviderBlocks: jest.fn(async (_asset: string, blocked: RedemptionExclusions) => {
      for (const row of all) {
        if (!open.has(row.id)) continue;
        const cause = blocked.organizationIds.includes(row.providerId ?? '')
          ? 'ProviderBlocked'
          : walletKey(row.providerAccount) !== null &&
              blocked.walletKeys.includes(walletKey(row.providerAccount)!)
            ? 'PayeeBlocked'
            : null;
        if (cause && !lastErrors.has(row.id)) lastErrors.set(row.id, cause);
      }
    }),
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
  return {
    service,
    calls,
    intents,
    ledger,
    payments,
    setNow: (s: number) => (now = s),
    setStakeBelowMinimum: (below: boolean) => (stakeBelowMinimum = below),
  };
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

  it('forfeits at once a voucher whose provider is blocked, and redeems the payer’s later seqs', async () => {
    // Finding 14: holding it until it expired used to end in absorb(), so the
    // platform paid a banned provider. The provider forfeits instead: the
    // buyer's hold is released and nobody is credited.
    const { service, redeemer, intents, ledger, payments, alerts } = build(
      [pending(1, { providerId: PROVIDER_UUID }), pending(2), pending(3)],
      blocklistOf({ kind: BlockSubjectKind.ORGANIZATION, subject: PROVIDER_UUID }),
    );

    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(intents.releaseHold).toHaveBeenCalledWith(expect.objectContaining({ id: 'intent-1' }));
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}ProviderBlocked`,
    );
    expect(alerts.emitted).toContainEqual(
      expect.objectContaining({
        name: VOUCHER_REDEMPTION_ALERTS.PROVIDER_FORFEIT,
        severity: AlertSeverity.WARN,
      }),
    );
    // A forfeited seq is never redeemed, so the later ones may go.
    expect(redeemer.calls.map((call) => call.seq)).toEqual(['2', '3']);
  });

  it('forfeits at once a voucher whose payee wallet is blocked', async () => {
    const { service, redeemer, intents, ledger, payments } = build(
      [pending(1)],
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: PROVIDER_ACCOUNT }),
    );

    await service.run(USDC);

    expect(redeemer.calls).toEqual([]);
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}PayeeBlocked`,
    );
  });

  it('forfeits at once a voucher whose payee is blocked on chain', async () => {
    const { payments, intents, ledger } = realisticBuild([pending(1)]);
    // Only the payee is blocked: a realistic gate answers for the parties it
    // is asked about, and the payer-side hold no longer asks about the payee.
    const chainState = {
      holdReason: jest.fn(async (_door: unknown, parties: { role: string }[]) =>
        parties.some((party) => party.role === 'PAYEE') ? 'the payee is blocked on chain' : null,
      ),
      blockedAccounts: jest.fn().mockResolvedValue([PROVIDER_ACCOUNT.toLowerCase()]),
    };
    const redeemer = new FakeRedeemer();
    const service = new VoucherRedemptionService(
      payments as never,
      intents as never,
      ledger as never,
      redeemer as never,
      new FakeAlerts() as never,
      noBlocks(),
      () => NOW_SECONDS * 1000,
      chainState as never,
    );

    await service.run(USDC);

    expect(redeemer.calls).toEqual([]);
    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}PayeeBlockedOnChain`,
    );
  });

  it('blocked payee: the next pass after the block releases the hold, with no credit', async () => {
    const blocklist = noBlocks();
    const { service, calls, intents, ledger } = realisticBuild([pending(1), pending(2)], blocklist);
    addBlock(blocklist, { kind: BlockSubjectKind.WALLET, subject: PROVIDER_ACCOUNT });

    await service.run(USDC);

    expect(calls).toEqual([]);
    expect(intents.releaseHold).toHaveBeenCalledTimes(2);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });

  it('still holds a voucher whose delegate is blocked (a payer-side block, E-2)', async () => {
    const delegate = `${CHAIN_IDS.SOLANA_DEVNET}:DeLeGaTe1111111111111111111111111111111111`;
    const signer = build(
      [pending(1, { voucherDelegate: delegate })],
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: delegate }),
    );
    await signer.service.run(USDC);
    expect(signer.redeemer.calls).toEqual([]);
    expect(signer.intents.releaseHold).not.toHaveBeenCalled();
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

  it('blocking a buyer freezes collection; past expiry after the unblock it is buyer debt', async () => {
    // Owner rule: the platform never pays. While blocked the hold is frozen
    // and the provider is not paid; after the unblock the dead voucher is debt.
    const blocklist = blocklistOf({ kind: BlockSubjectKind.WALLET, subject: BUYER });
    const { service, calls, ledger, intents, payments, setNow } = realisticBuild(
      [pending(1)],
      blocklist,
    );
    await service.run(USDC);
    expect(calls).toEqual([]);
    expect(intents.releaseHold).not.toHaveBeenCalled();

    setNow(NOW_SECONDS + 3600); // the block lasted an hour
    await blocklist.applied({
      kind: 'unblocked',
      subjectKind: BlockSubjectKind.WALLET,
      subjectKey: subjectKey(BlockSubjectKind.WALLET, BUYER) as string,
    });
    await service.run(USDC);
    expect(calls).toHaveLength(1);
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'VoucherExpired');
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

describe('VoucherRedemptionService.run, provider forfeit on a stake below the minimum', () => {
  it('records the program error of every RETRY that names one, and not a bare RPC failure', async () => {
    const { service, redeemer, payments } = build([pending(1)]);
    redeemer.outcome = RedeemOutcomeKind.RETRY;
    redeemer.programError = 'ProviderBelowMinimumStake';
    await service.run(USDC);
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      'ProviderBelowMinimumStake',
    );

    const rpc = build([pending(1)]);
    rpc.redeemer.outcome = RedeemOutcomeKind.RETRY;
    await rpc.service.run(USDC);
    expect(rpc.payments.recordRedemptionError).not.toHaveBeenCalled();
  });

  it('forfeits an UNREDEEMABLE ProviderBelowMinimumStake: hold released, nobody credited', async () => {
    const { service, redeemer, intents, ledger, alerts, payments } = build([pending(1)]);
    redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;
    redeemer.programError = 'ProviderBelowMinimumStake';

    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(payments.recordRedemptionError).toHaveBeenCalledWith(
      ORG,
      'intent-1',
      `${PROVIDER_FORFEIT_PREFIX}ProviderBelowMinimumStake`,
    );
    expect(alerts.emitted).toContainEqual(
      expect.objectContaining({
        name: VOUCHER_REDEMPTION_ALERTS.PROVIDER_FORFEIT,
        severity: AlertSeverity.WARN,
      }),
    );
    expect(alerts.emitted.map((alert) => alert.name)).not.toContain(
      VOUCHER_REDEMPTION_ALERTS.UNREDEEMABLE,
    );
  });

  it('forfeits a VoucherExpired whose last refusal was ProviderBelowMinimumStake', async () => {
    const { service, redeemer, intents, ledger } = build([
      pending(1, { redemptionLastError: 'ProviderBelowMinimumStake' }),
    ]);
    redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;
    redeemer.programError = 'VoucherExpired';

    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });

  it('does not forfeit a VoucherExpired whose last refusal was the buyer’s: buyer debt', async () => {
    const { service, redeemer, ledger, intents, payments } = build([
      pending(1, { redemptionLastError: 'EscrowInsufficient' }),
    ]);
    redeemer.outcome = RedeemOutcomeKind.UNREDEEMABLE;
    redeemer.programError = 'VoucherExpired';

    await service.run(USDC);

    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'EscrowInsufficient');
  });

  it('unstake during the window: retried, then forfeited at expiry — no credit, hold released', async () => {
    const { service, calls, intents, ledger, setNow, setStakeBelowMinimum } = realisticBuild([
      pending(1),
    ]);
    setStakeBelowMinimum(true);

    await service.run(USDC);
    expect(calls).toHaveLength(1);
    expect(intents.releaseHold).not.toHaveBeenCalled();

    setNow(NOW_SECONDS + 3600); // past expiresAt + grace: the chain says VoucherExpired
    await service.run(USDC);

    expect(intents.releaseHold).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });

  it('pays the provider normally when it restakes inside the window', async () => {
    const { service, intents, ledger, setStakeBelowMinimum } = realisticBuild([pending(1)]);
    setStakeBelowMinimum(true);
    await service.run(USDC);

    setStakeBelowMinimum(false);
    await service.run(USDC);

    expect(intents.commitRedeemedHold).toHaveBeenCalledTimes(1);
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });
});

/**
 * Review-buyer-debt M3: an honest revoke or cap change made every in-flight
 * call buyer debt at once, and a re-grant before the deadline did not undo it.
 * The delegate and cap refusals are now retried until one pass before the
 * voucher's on-chain deadline.
 */
describe('VoucherRedemptionService — a buyer tightening is retried until the deadline', () => {
  it.each([
    'DelegateIsRevoked',
    'DelegateIsExpired',
    'DelegateVoucherExceedsPerCallLimit',
    'EscrowWindowLimitExceeded',
  ])('%s mid-window: kept, recorded, retried — not debt', async (programError) => {
    const { service, redeemer, payments, intents } = build([pending(1)]);
    redeemer.outcome = RedeemOutcomeKind.RETRY;
    redeemer.programError = programError;

    await service.run(USDC);

    expect(payments.recordRedemptionError).toHaveBeenCalledWith(ORG, 'intent-1', programError);
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('a re-grant before the deadline redeems the same voucher on the next pass', async () => {
    const first = build([pending(1)]);
    first.redeemer.outcome = RedeemOutcomeKind.RETRY;
    first.redeemer.programError = 'DelegateIsRevoked';
    await first.service.run(USDC);

    const second = build([pending(1, { redemptionLastError: 'DelegateIsRevoked' })]);
    await second.service.run(USDC);

    expect(second.intents.commitRedeemedHold).toHaveBeenCalledWith(ORG, 'intent-1', 'sig-1');
    expect(second.payments.lapseRedemption).not.toHaveBeenCalled();
  });

  it('still refused one pass before the deadline: it becomes buyer debt then', async () => {
    // expiresAt + 1,800 - 60 s is now: the last pass that could redeem it.
    const expiresAt = new Date((NOW_SECONDS - REDEEM_GRACE_SECONDS + 60) * 1000);
    const { service, redeemer, payments, intents } = build([pending(1, { expiresAt })]);
    redeemer.outcome = RedeemOutcomeKind.RETRY;
    redeemer.programError = 'DelegateIsRevoked';

    await service.run(USDC);

    expect(payments.lapseRedemption).toHaveBeenCalledWith(ORG, 'intent-1', 'DelegateIsRevoked');
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('a stake refusal is not a buyer tightening: still retried at the deadline', async () => {
    const expiresAt = new Date((NOW_SECONDS - REDEEM_GRACE_SECONDS + 60) * 1000);
    const { service, redeemer, payments } = build([pending(1, { expiresAt })]);
    redeemer.outcome = RedeemOutcomeKind.RETRY;
    redeemer.programError = 'ProviderBelowMinimumStake';

    await service.run(USDC);

    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });
});
