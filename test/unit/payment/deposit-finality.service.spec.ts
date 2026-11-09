import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { EscrowBalanceReaderPort } from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { DepositFinalityService } from '@modules/payment/services/deposit-finality.service';
import { MoneyUtil } from '@shared/utils/money.util';
import { ChainErrors } from '@modules/chains/errors/chains.errors';
import {
  DEPOSIT_DROP_MIN_AGE_MS,
  DEPOSIT_DROP_RECHECK_MS,
  DEPOSIT_UNCOVERED_ALERT_AFTER_MS,
  DEPOSIT_UNCOVERED_ALERT_WINDOW_SECONDS,
  DEPOSIT_UNCOVERED_BACKOFF_MAX_MS,
  DEPOSIT_UNCOVERED_BACKOFF_MIN_MS,
} from '@modules/payment/constants/deposit-intent.constants';
import { DepositCoverageService } from '@modules/payment/services/deposit-coverage.service';
import { AlertAggregation, AlertSeverity } from '@shared/alerting';

/**
 * The finality sweep's three answers.
 *
 * The one that was wrong: on `eip155:46630` the `finalized` head trails
 * `latest` by ~17 minutes, the sweep runs every 5, and `observeTransfer` at
 * `finalized` answers `null` for a transfer that is merely NOT FINAL YET — the
 * same `null` it gives for one a reorg dropped. The sweep read every `null` as
 * a drop and wrote DEPOSIT_REJECT. Measured 2026-09-22 on the real testnet: a
 * 25 USDG deposit sat in the escrow on chain while the ledger rejected it, 3
 * minutes after settle. Solana (finality ~13 s) and anvil (blocks mined by
 * hand) never produce the gap, which is why nothing caught it.
 */
const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const ACCOUNT = `${CHAIN}:0x66d7CA4cD09C65197B2f3239c1fe79631747dd00`;
const TX = `0x${'ab'.repeat(32)}`;
const money = MoneyUtil.of('25000000', ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6);

function build(
  observe: (commitment: string | undefined) => unknown,
  options: {
    appendFails?: boolean;
    notify?: jest.Mock;
    coverage?: jest.Mock;
    pendingAt?: Date;
    alerts?: { emit: jest.Mock };
    uncoveredSince?: Date;
  } = {},
) {
  // The queue row, as the repository would return it: `markFinalityUncovered`
  // persists `uncoveredSince` on it like the database does.
  const row: Record<string, unknown> = {
    id: 'dep-1',
    organizationId: 'org-1',
    chainId: CHAIN,
    chainTxRef: TX,
    uncoveredSince: options.uncoveredSince ?? null,
  };
  const deposits = {
    findSettledAwaitingFinality: jest.fn(async () => [{ ...row }]),
    markFinalityResolved: jest.fn().mockResolvedValue(undefined),
    deferFinalityCheck: jest.fn().mockResolvedValue(1),
    markFinalityUncovered: jest.fn(async (_org: string, _id: string, since: Date) => {
      row.uncoveredSince = since;
      return 1;
    }),
  };
  const ledger = {
    readJournal: jest.fn().mockResolvedValue([
      {
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        accountId: ACCOUNT,
        money,
        createdAt: options.pendingAt ?? new Date(),
      },
    ]),
    appendNow: options.appendFails
      ? jest.fn().mockRejectedValue(new Error('Balance folded negative'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const audit = { recordAfterCommit: jest.fn().mockResolvedValue(undefined) };
  const coverage =
    options.coverage ??
    jest.fn().mockResolvedValue({ chain: 25_000_000n, claim: 25_000_000n, covered: true });
  const adapter = {
    observeTransfer: jest.fn(async (_intent, _tx, options?: { commitment?: string }) =>
      observe(options?.commitment),
    ),
  };
  const service = new DepositFinalityService(
    deposits as unknown as DepositIntentRepository,
    { resolve: () => adapter } as unknown as ChainAdapterRegistry,
    {
      escrowAddresses: async () => ({
        escrowPda: `${CHAIN}:0x60aBdb81796322b1bA6674068a3861309a9f8D37`,
      }),
    } as unknown as EscrowBalanceReaderPort,
    ledger as unknown as LedgerService,
    { check: coverage } as never,
    options.notify ? ({ notify: options.notify } as never) : undefined,
    audit as never,
    (options.alerts ?? { emit: jest.fn().mockResolvedValue(undefined) }) as never,
  );
  return { service, deposits, ledger, adapter, audit, coverage };
}

/** A pending credit old enough that "gone at every commitment" may count as a drop. */
const OLD = { pendingAt: new Date(Date.now() - DEPOSIT_DROP_MIN_AGE_MS - 60_000) };

const LANDED = { amount: '25000000', asset: ASSET_IDS.USDG_ROBINHOOD_TESTNET, decimals: 6 };

describe('DepositFinalityService sweep', () => {
  it('waits — writes nothing, leaves the deposit queued — when the transfer is confirmed but not final yet', async () => {
    const { service, ledger, deposits } = build((c) => (c === 'finalized' ? null : LANDED));

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({
      confirmed: 0,
      rejected: 0,
      skipped: 1,
    });
    expect(ledger.appendNow).not.toHaveBeenCalled();
    // Still in the queue: the next sweep must look again.
    expect(deposits.markFinalityResolved).not.toHaveBeenCalled();
  });

  it('rejects only a transfer the chain no longer shows at any commitment', async () => {
    const { service, ledger } = build(() => null, OLD);

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ rejected: 1 });
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_REJECT, chainTxRef: TX }),
    );
  });

  // Money #1: one "not found" can come from a lagging or failover endpoint. A
  // young deposit is never rejected on it: it is re-checked a minute later and
  // stays pending, whatever the reads say, until the minimum age has passed.
  it('never rejects a deposit that is merely not visible yet: defers it until the minimum age', async () => {
    const { service, ledger, deposits } = build(() => null, {
      pendingAt: new Date(Date.now() - DEPOSIT_DROP_MIN_AGE_MS + 60_000),
    });
    const before = Date.now();

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({
      rejected: 0,
      skipped: 1,
    });
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(deposits.markFinalityResolved).not.toHaveBeenCalled();
    expect(deposits.markFinalityUncovered).not.toHaveBeenCalled();
    expect(deposits.deferFinalityCheck).toHaveBeenCalledWith('org-1', 'dep-1', expect.any(Date));
    const next = (deposits.deferFinalityCheck.mock.calls[0][2] as Date).getTime();
    expect(next).toBeGreaterThanOrEqual(before + DEPOSIT_DROP_RECHECK_MS);
  });

  it('treats a pending credit with no timestamp as young (never rejects on it)', async () => {
    const { service, ledger } = build(() => null);
    ledger.readJournal.mockResolvedValue([
      { entryType: LedgerEntryType.DEPOSIT_PENDING, accountId: ACCOUNT, money },
    ]);

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ rejected: 0 });
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });

  it('confirms a finalized transfer', async () => {
    const { service, ledger } = build(() => LANDED);

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ confirmed: 1 });
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_CONFIRM, chainTxRef: TX }),
    );
  });
});

describe('DepositFinalityService audit rows (B7)', () => {
  it('logs a confirmed deposit once, after the credit, as bookkeeping', async () => {
    const { service, ledger, audit } = build(() => LANDED);

    await service.promotePendingDeposits(10);

    expect(audit.recordAfterCommit).toHaveBeenCalledTimes(1);
    expect(audit.recordAfterCommit).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actor: { type: 'system', id: 'deposit-finality' },
      action: 'deposit.credited',
      resourceType: 'deposit',
      resourceId: 'dep-1',
      before: null,
      after: expect.objectContaining({
        amount: '25.000000',
        amountAtomic: '25000000',
        chainId: CHAIN,
        transactionHash: TX,
      }),
    });
    expect(ledger.appendNow.mock.invocationCallOrder[0]).toBeLessThan(
      audit.recordAfterCommit.mock.invocationCallOrder[0],
    );
  });

  it('logs a rejected deposit', async () => {
    const { service, audit } = build(() => null, OLD);

    await service.promotePendingDeposits(10);

    expect(audit.recordAfterCommit.mock.calls[0][0]).toMatchObject({ action: 'deposit.rejected' });
  });

  it('logs nothing while the deposit waits for finality', async () => {
    const { service, audit } = build((c) => (c === 'finalized' ? null : LANDED));

    await service.promotePendingDeposits(10);

    expect(audit.recordAfterCommit).not.toHaveBeenCalled();
  });

  it('logs nothing when another trigger resolved the deposit first', async () => {
    const { service, ledger, audit } = build(() => LANDED, { appendFails: true });
    ledger.readJournal
      .mockResolvedValueOnce([
        { entryType: LedgerEntryType.DEPOSIT_PENDING, accountId: ACCOUNT, money },
      ])
      .mockResolvedValueOnce([
        { entryType: LedgerEntryType.DEPOSIT_PENDING, accountId: ACCOUNT, money },
        { entryType: LedgerEntryType.DEPOSIT_CONFIRM, accountId: ACCOUNT, money },
      ]);

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ skipped: 1 });
    expect(audit.recordAfterCommit).not.toHaveBeenCalled();
  });

  // HIGH-1 regression: a row whose resolution throws sat at the head of the
  // `updatedAt ASC` queue and aborted every later pass, freezing every buyer's
  // deposits. It must be skipped and left queued while the rest still drain.
  it('skips a row whose resolution throws and still resolves the rows behind it', async () => {
    const { service, deposits, ledger } = build(() => LANDED);
    deposits.findSettledAwaitingFinality.mockResolvedValue([
      { id: 'dep-poison', organizationId: 'org-1', chainId: CHAIN, chainTxRef: TX },
      { id: 'dep-2', organizationId: 'org-1', chainId: CHAIN, chainTxRef: `0x${'cd'.repeat(32)}` },
    ]);
    // The poison row's confirm fails and its journal still shows no resolution,
    // so `appendResolution` re-raises — the shape that used to abort the pass.
    ledger.appendNow
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
      .mockResolvedValueOnce(undefined);

    await expect(service.promotePendingDeposits(10)).resolves.toEqual({
      checked: 2,
      confirmed: 1,
      rejected: 0,
      skipped: 1,
    });
    expect(deposits.markFinalityResolved).toHaveBeenCalledTimes(1);
    expect(deposits.markFinalityResolved).toHaveBeenCalledWith('org-1', 'dep-2', expect.any(Date));
  });
});

describe('DepositFinalityService notices (B8)', () => {
  it('writes the credited and failed bodies in dollars', async () => {
    const credited = jest.fn().mockResolvedValue(undefined);
    await build(() => LANDED, { notify: credited }).service.promotePendingDeposits(10);
    expect(credited.mock.calls[0][0].body).toBe(
      'Your deposit of $25.00 has been credited and is now spendable.',
    );

    const failed = jest.fn().mockResolvedValue(undefined);
    await build(() => null, { ...OLD, notify: failed }).service.promotePendingDeposits(10);
    expect(failed.mock.calls[0][0].body).toBe(
      'Your deposit of $25.00 could not be finalized on chain. No balance was affected.',
    );
  });
});

/**
 * H-1, the second check: final on chain is not enough to make a deposit
 * spendable; the money must still be in the buyer's escrow. The ordering this
 * covers is claim -> withdraw: the credit was covered when it was written, and
 * the buyer withdrew it on chain before finality (the withdrawal booker debits
 * only `available`, never this `pending`).
 */
describe('DepositFinalityService escrow coverage (H-1)', () => {
  const uncovered = () =>
    jest.fn().mockResolvedValue({ chain: 0n, claim: 25_000_000n, covered: false });

  it('checks the escrow covers the ledger claim, with nothing extra, before confirming', async () => {
    const { service, coverage } = build(() => LANDED);

    await service.promotePendingDeposits(10);

    expect(coverage).toHaveBeenCalledWith('org-1', ACCOUNT, money.asset, 0n);
  });

  afterEach(() => jest.useRealTimers());

  it('claim -> withdraw: never confirms an uncovered deposit, and keeps it queued', async () => {
    const { service, ledger, deposits } = build(() => LANDED, { coverage: uncovered() });

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({
      confirmed: 0,
      rejected: 0,
      skipped: 1,
    });
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(deposits.markFinalityResolved).not.toHaveBeenCalled();
  });

  it('never rejects for being uncovered: it stays pending and alerts once the delay has passed', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-03T00:00:00Z') });
    const notify = jest.fn().mockResolvedValue(undefined);
    const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
    const { service, ledger, deposits } = build(() => LANDED, {
      coverage: uncovered(),
      notify,
      alerts,
    });

    await service.promotePendingDeposits(10);
    jest.setSystemTime(Date.now() + DEPOSIT_UNCOVERED_ALERT_AFTER_MS - 1_000);
    await service.promotePendingDeposits(10);
    expect(alerts.emit).not.toHaveBeenCalled();

    jest.setSystemTime(Date.now() + 2_000);
    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({
      rejected: 0,
      skipped: 1,
    });
    expect(alerts.emit).toHaveBeenCalledTimes(1);
    expect(alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: AlertSeverity.WARN,
        name: 'deposit_pending_uncovered',
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: 'dep-1',
        details: expect.objectContaining({
          intentId: 'dep-1',
          account: ACCOUNT,
          shortfall: '25000000',
        }),
      }),
    );
    // Hours later: still pending, never a DEPOSIT_REJECT, no buyer notice.
    jest.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    await service.promotePendingDeposits(10);
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(deposits.markFinalityResolved).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('slow finality (M-3): the alert delay runs from the first uncovered pass, not from the credit', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-03T00:00:00Z') });
    const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
    // Credited 40 minutes ago; final (and first checked) only now.
    const { service } = build(() => LANDED, {
      coverage: uncovered(),
      alerts,
      pendingAt: new Date(Date.now() - 40 * 60 * 1000),
    });

    await service.promotePendingDeposits(10);
    expect(alerts.emit).not.toHaveBeenCalled();

    jest.setSystemTime(Date.now() + DEPOSIT_UNCOVERED_ALERT_AFTER_MS);
    await service.promotePendingDeposits(10);
    expect(alerts.emit).toHaveBeenCalledTimes(1);
  });

  it('uncovered, then covered later: becomes spendable (a booking lag, not a withdrawal)', async () => {
    const coverage = jest
      .fn()
      .mockResolvedValueOnce({ chain: 0n, claim: 25_000_000n, covered: false })
      .mockResolvedValue({ chain: 25_000_000n, claim: 25_000_000n, covered: true });
    const { service, ledger } = build(() => LANDED, { coverage });

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ skipped: 1 });
    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ confirmed: 1 });
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: LedgerEntryType.DEPOSIT_CONFIRM }),
    );
  });

  it('leaves the row queued when the escrow cannot be read', async () => {
    const { service, ledger, deposits } = build(() => LANDED, {
      coverage: jest.fn().mockRejectedValue(new Error('rpc down')),
    });

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ skipped: 1 });
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(deposits.markFinalityResolved).not.toHaveBeenCalled();
  });
});

/** M-2: an RPC failure at finality used to read as "dropped by a reorg". */
describe('DepositFinalityService chain read failures (M-2)', () => {
  it('writes no DEPOSIT_REJECT when the chain read fails; the row is retried next pass', async () => {
    const { service, ledger, deposits } = build(() => {
      throw ChainErrors.rpcReadFailed({ method: 'eth_getTransactionReceipt' });
    });

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({
      rejected: 0,
      skipped: 1,
    });
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(deposits.markFinalityResolved).not.toHaveBeenCalled();
  });
});

/**
 * Two concurrent claims for one buyer, each covered alone, together more than
 * the escrow holds (L-6): both are written pending (the deposit path checks
 * no balance), and the real coverage check keeps both from becoming spendable
 * until the escrow holds the sum.
 */
describe('DepositFinalityService two claims together exceeding the escrow', () => {
  it('confirms neither while the sum is uncovered, both once it is', async () => {
    const five = MoneyUtil.of('5000000', ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6);
    const escrowBalance = { value: 8_000_000n };
    const coverage = new DepositCoverageService(
      {
        read: jest.fn(async () => ({
          balance: MoneyUtil.of(escrowBalance.value, ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6),
        })),
      } as never,
      {
        // Both credits pending, nothing spendable yet.
        getBalance: jest.fn(async () => ({
          available: MoneyUtil.of(0n, ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6),
          held: MoneyUtil.of(0n, ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6),
          pending: MoneyUtil.of(10_000_000n, ASSET_IDS.USDG_ROBINHOOD_TESTNET, 6),
        })),
      } as never,
      { sumHeldOnChainByAccounts: jest.fn(async () => new Map()) } as never,
    );
    const deposits = {
      findSettledAwaitingFinality: jest.fn().mockResolvedValue([
        { id: 'dep-a', organizationId: 'org-1', chainId: CHAIN, chainTxRef: TX },
        {
          id: 'dep-b',
          organizationId: 'org-1',
          chainId: CHAIN,
          chainTxRef: `0x${'cd'.repeat(32)}`,
        },
      ]),
      markFinalityResolved: jest.fn().mockResolvedValue(undefined),
      markFinalityUncovered: jest.fn().mockResolvedValue(1),
    };
    const ledger = {
      readJournal: jest.fn(async () => [
        { entryType: LedgerEntryType.DEPOSIT_PENDING, accountId: ACCOUNT, money: five },
      ]),
      appendNow: jest.fn().mockResolvedValue(undefined),
    };
    const service = new DepositFinalityService(
      deposits as unknown as DepositIntentRepository,
      { resolve: () => ({ observeTransfer: jest.fn(async () => LANDED) }) } as never,
      { escrowAddresses: async () => ({ escrowPda: ACCOUNT }) } as never,
      ledger as unknown as LedgerService,
      coverage,
    );

    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({
      confirmed: 0,
      rejected: 0,
      skipped: 2,
    });
    expect(ledger.appendNow).not.toHaveBeenCalled();

    escrowBalance.value = 10_000_000n;
    await expect(service.promotePendingDeposits(10)).resolves.toMatchObject({ confirmed: 2 });
  });
});

/**
 * H-1, round 3: an uncovered row must not hold the head of the queue. The
 * queue query skips a row until its `finality_next_check_at` and sorts it
 * after never-uncovered rows (covered over the real SQL in
 * `deposit-intent-queries.integration.spec.ts`); the sweep's part is stamping
 * that back-off, persisting when it was first uncovered, and keeping the log
 * and the alert to one per step / one per day.
 */
describe('DepositFinalityService uncovered back-off (H-1, round 3)', () => {
  const uncovered = () =>
    jest.fn().mockResolvedValue({ chain: 0n, claim: 25_000_000n, covered: false });
  afterEach(() => jest.useRealTimers());

  it('stamps an exponential back-off from the first uncovered pass, capped at 10 minutes', async () => {
    const t0 = new Date('2026-11-03T00:00:00Z').getTime();
    jest.useFakeTimers({ now: t0 });
    const { service, deposits } = build(() => LANDED, { coverage: uncovered() });

    await service.promotePendingDeposits(10);
    expect(deposits.markFinalityUncovered).toHaveBeenLastCalledWith(
      'org-1',
      'dep-1',
      new Date(t0),
      new Date(t0 + DEPOSIT_UNCOVERED_BACKOFF_MIN_MS),
    );

    // Each next check is as far away as the row has been uncovered so far.
    jest.setSystemTime(t0 + 30_000);
    await service.promotePendingDeposits(10);
    expect(deposits.markFinalityUncovered).toHaveBeenLastCalledWith(
      'org-1',
      'dep-1',
      new Date(t0),
      new Date(t0 + 60_000),
    );
    jest.setSystemTime(t0 + 60_000);
    await service.promotePendingDeposits(10);
    expect(deposits.markFinalityUncovered).toHaveBeenLastCalledWith(
      'org-1',
      'dep-1',
      new Date(t0),
      new Date(t0 + 120_000),
    );

    jest.setSystemTime(t0 + 60 * 60 * 1000);
    await service.promotePendingDeposits(10);
    expect(deposits.markFinalityUncovered).toHaveBeenLastCalledWith(
      'org-1',
      'dep-1',
      new Date(t0),
      new Date(t0 + 60 * 60 * 1000 + DEPOSIT_UNCOVERED_BACKOFF_MAX_MS),
    );
  });

  it('never stamps a back-off on a covered row, or one only waiting for finality', async () => {
    const covered = build(() => LANDED);
    await covered.service.promotePendingDeposits(10);
    expect(covered.deposits.markFinalityUncovered).not.toHaveBeenCalled();

    const notFinal = build((c) => (c === 'finalized' ? null : LANDED), {
      coverage: uncovered(),
    });
    await notFinal.service.promotePendingDeposits(10);
    expect(notFinal.deposits.markFinalityUncovered).not.toHaveBeenCalled();
  });

  it('runs the alert delay from the persisted first-uncovered time (survives a restart)', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-03T00:00:00Z') });
    const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
    // A fresh process (nothing in memory) meets a row uncovered 20 minutes ago.
    const { service } = build(() => LANDED, {
      coverage: uncovered(),
      alerts,
      uncoveredSince: new Date(Date.now() - 20 * 60 * 1000),
    });

    await service.promotePendingDeposits(10);
    expect(alerts.emit).toHaveBeenCalledTimes(1);
    expect(alerts.emit.mock.calls[0][0].details.uncoveredForSeconds).toBe(20 * 60);
  });

  it('alerts once per deposit per day, however many back-off steps pass', async () => {
    const t0 = new Date('2026-11-03T00:00:00Z').getTime();
    jest.useFakeTimers({ now: t0 });
    const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
    const { service } = build(() => LANDED, {
      coverage: uncovered(),
      alerts,
      uncoveredSince: new Date(t0 - DEPOSIT_UNCOVERED_ALERT_AFTER_MS),
    });

    for (let step = 0; step < 20; step += 1) {
      jest.setSystemTime(t0 + step * DEPOSIT_UNCOVERED_BACKOFF_MAX_MS);
      await service.promotePendingDeposits(10);
    }
    expect(alerts.emit).toHaveBeenCalledTimes(1);

    jest.setSystemTime(t0 + DEPOSIT_UNCOVERED_ALERT_WINDOW_SECONDS * 1000);
    await service.promotePendingDeposits(10);
    expect(alerts.emit).toHaveBeenCalledTimes(2);
  });

  it('keeps the back-off when the alert sink fails', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-03T00:00:00Z') });
    const alerts = { emit: jest.fn().mockRejectedValue(new Error('redis down')) };
    const { service, deposits } = build(() => LANDED, {
      coverage: uncovered(),
      alerts,
      uncoveredSince: new Date(Date.now() - 60 * 60 * 1000),
    });

    await service.promotePendingDeposits(10);
    expect(deposits.markFinalityUncovered).toHaveBeenCalledTimes(1);
  });
});
