import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { PaymentIntent as ChainPaymentIntent, TxRef } from '@modules/chains/ports/x402.types';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { AppendEntryInput } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { AuditLogWriter } from '@shared/audit';
import { MoneyUtil } from '@shared/utils/money.util';

import { depositResource } from '../constants/deposit-intent.constants';

export interface DepositFinalitySummary {
  readonly checked: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly skipped: number;
}

/**
 * Promotes a settled deposit's ledger entry from `DEPOSIT_PENDING` to
 * `DEPOSIT_CONFIRM` once its transaction is finalized, or to
 * `DEPOSIT_REJECT` if a reorg dropped it — a deposit ledger entry follows
 * observed on-chain confirmation, with the two-phase pending/confirm split the
 * ledger domain already models via `LEDGER_ENTRY_EFFECTS`.
 *
 * `DepositService.settleDeposit` writes `DEPOSIT_PENDING` against a
 * `confirmed`-commitment read, because waiting for `finalized` inline would
 * hold the deposit request open for the several seconds finality actually
 * takes. This class is the second half: re-reading the same transaction at
 * `finalized` commitment, moments to minutes later, is what turns that
 * provisional credit durable.
 *
 * Not itself a `@Cron` job — see the file header of
 * `payment-scheduler.module.ts` for why the periodic trigger is wired there
 * rather than here, and for what is and is not wired into a running
 * scheduler process today.
 */
@Injectable()
export class DepositFinalityService {
  private readonly logger = new Logger(DepositFinalityService.name);

  /** Tail of the sweep chain — see `promotePendingDeposits`. */
  private sweeping: Promise<void> = Promise.resolve();

  constructor(
    private readonly deposits: DepositIntentRepository,
    private readonly registry: ChainAdapterRegistry,
    @Inject(ESCROW_BALANCE_READER) private readonly escrowReader: EscrowBalanceReaderPort,
    private readonly ledger: LedgerService,
    // Optional for the same reason `LedgerJournalService`'s is:
    // `test/integration/helpers/deposit-test-context.ts` constructs this class
    // with `new DepositFinalityService(a, b, c, d)` directly, outside DI.
    // `PaymentModule` always imports `NotificationModule` in the running app.
    @Optional()
    @Inject(NOTIFICATION_PORT)
    private readonly notifications?: NotificationPort,
    // Optional for the same reason. Bookkeeping only: the entry is written
    // after the resolving ledger entry is durable and never decides anything.
    @Optional() private readonly audit?: AuditLogWriter,
  ) {}

  /**
   * Runs a sweep, never concurrently with another.
   *
   * There are two triggers on this path now — the five-minute cron and the
   * Helius vault watcher — and they are deliberately unsynchronised: the whole
   * point of the watcher is to fire the moment a transfer finalizes, which is
   * exactly when the cron is most likely to be running too. Two overlapping
   * sweeps read the same candidate, both see no resolving entry, and both
   * write the credit.
   *
   * This lock closes that for one process. It is **not** the guarantee —
   * `uq_ledger_entries_deposit_resolution` is, and `resolve()` below is written
   * to lose gracefully against it. A lock cannot span processes, and nothing
   * says the API will never gain a third trigger.
   *
   * Queued rather than coalesced: a caller that arrives mid-sweep may be
   * reporting a deposit the running pass has already scanned past, so handing
   * it that pass's result would drop the very event it was woken for.
   */
  async promotePendingDeposits(limit: number): Promise<DepositFinalitySummary> {
    const run = this.sweeping.then(
      () => this.sweep(limit),
      () => this.sweep(limit),
    );

    // Keep the chain alive whatever this pass does — a rejection here must not
    // wedge every later sweep.
    this.sweeping = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private async sweep(limit: number): Promise<DepositFinalitySummary> {
    const candidates = await this.deposits.findSettledAwaitingFinality(limit);

    let confirmed = 0;
    let rejected = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const entries = await this.ledger.readJournal(candidate.organizationId, {
        intentId: candidate.id,
      });

      const pending = entries.find((entry) => entry.entryType === LedgerEntryType.DEPOSIT_PENDING);
      const alreadyResolved = entries.some(
        (entry) =>
          entry.entryType === LedgerEntryType.DEPOSIT_CONFIRM ||
          entry.entryType === LedgerEntryType.DEPOSIT_REJECT,
      );

      // Nothing to resolve yet. Deliberately NOT marked resolved: this is a
      // transient state, not a terminal one — a row can read `SETTLED` for the
      // moment before `DepositService.settleDeposit` writes its
      // `DEPOSIT_PENDING`. Stamping here
      // would drop the deposit out of the queue forever, which is the very
      // failure this column exists to fix.
      if (!pending) {
        skipped += 1;
        continue;
      }

      // Already promoted. The journal — not the column — is what makes this
      // safe, and it stays the guard: re-visiting a confirmed deposit must
      // never write a second `DEPOSIT_CONFIRM`, and nothing in the database
      // would stop it if this check went away (`uq_ledger_entries_intent_credit_type`
      // is partial on `PROVIDER_CREDIT` / `PLATFORM_FEE` and does not cover
      // deposits).
      //
      // Stamping on this branch is the self-heal: a pass that crashed between
      // `appendNow` and `markFinalityResolved`, or a row that predates the
      // migration's backfill, is otherwise re-read on every sweep forever and
      // starts rebuilding the permanent prefix.
      if (alreadyResolved) {
        await this.deposits.markFinalityResolved(
          candidate.organizationId,
          candidate.id,
          new Date(),
        );
        skipped += 1;
        continue;
      }

      const chainId = candidate.chainId as ChainId;
      const adapter = this.registry.resolve(chainId);
      // The destination is this buyer's own escrow, not the pooled
      // vault. `escrowAddresses` is a pure PDA derivation (no RPC); `escrowPda`
      // is the OWNER `observeTransfer` matches against the observed transfer's
      // token-account owner, exactly as `vaultOwner` was before it.
      const { escrowPda } = await this.escrowReader.escrowAddresses(
        pending.accountId as AccountId,
        pending.money.asset,
      );
      const chainIntent: ChainPaymentIntent = {
        id: candidate.id,
        resource: depositResource(candidate.id),
        amount: pending.money,
        payTo: escrowPda,
        // The account credited — what the EVM adapter matches the `Deposited`
        // event's `buyer` against. `escrowPda` is the pooled contract there,
        // and matching it found nothing, so every EVM deposit would have been
        // read as "dropped by a reorg" and rejected.
        payer: pending.accountId as AccountId,
        chainId,
        // Not used by `observeTransfer` — only `assertPayloadBoundToIntent`
        // reads `expiresAt`, and that is not what is being called here.
        expiresAt: new Date(),
      };

      const stillThere = await adapter.observeTransfer(chainIntent, candidate.chainTxRef as TxRef, {
        commitment: 'finalized',
      });

      // `null` at `finalized` means "not final YET" as often as "dropped".
      // On eip155:46630 the finalized head trails latest by ~17 minutes and
      // this sweep runs every 5, so reading every `null` as a drop rejected a
      // deposit whose 25 USDG was sitting in the escrow on chain (measured on
      // the real testnet, 2026-09-22). Ask again at the default commitment: a
      // transfer still there is waiting for finality — leave it queued, the
      // next sweep looks again. Only one gone at BOTH is a reorg.
      if (!stillThere) {
        const landed = await adapter.observeTransfer(chainIntent, candidate.chainTxRef as TxRef);
        if (landed) {
          skipped += 1;
          continue;
        }
      }

      if (stillThere) {
        const won = await this.appendResolution(candidate, {
          organizationId: candidate.organizationId,
          accountId: pending.accountId as AccountId,
          entryType: LedgerEntryType.DEPOSIT_CONFIRM,
          money: pending.money,
          intentId: candidate.id,
          chainTxRef: candidate.chainTxRef,
        });

        // Another trigger got there between this pass's journal read and its
        // write. The deposit is credited — once — so there is nothing to do
        // but leave the queue, and nothing to tell the buyer that the winning
        // pass has not already told them.
        if (!won) {
          await this.deposits.markFinalityResolved(
            candidate.organizationId,
            candidate.id,
            new Date(),
          );
          skipped += 1;
          continue;
        }
        confirmed += 1;
        await this.recordAudit(candidate, 'deposit.confirmed', pending.money, pending.accountId);

        // The notification shows "amount credited (observed), new balance" —
        // the observed amount is what `pending.money`
        // already is; the finality pass has no cheap read of the resulting
        // balance without a second query this notification does not justify.
        void this.notifications
          ?.notify({
            organizationId: candidate.organizationId,
            event: NotificationEvent.DEPOSIT_CREDITED,
            title: 'Deposit credited',
            body: `Your deposit of ${MoneyUtil.format(pending.money)} has been credited and is now spendable.`,
            subjectType: 'deposit_intent',
            subjectId: candidate.id,
            payload: {
              intentId: candidate.id,
              amount: pending.money.amount,
              asset: pending.money.asset,
            },
          })
          .catch((error) =>
            this.logger.warn(`deposit.credited notification failed: ${describe(error)}`),
          );
      } else {
        this.logger.warn(
          `Deposit ${candidate.id}: transaction ${candidate.chainTxRef} no longer observable at ` +
            `finalized commitment — writing DEPOSIT_REJECT`,
        );
        const won = await this.appendResolution(candidate, {
          organizationId: candidate.organizationId,
          accountId: pending.accountId as AccountId,
          entryType: LedgerEntryType.DEPOSIT_REJECT,
          money: pending.money,
          intentId: candidate.id,
          chainTxRef: candidate.chainTxRef,
        });

        if (!won) {
          await this.deposits.markFinalityResolved(
            candidate.organizationId,
            candidate.id,
            new Date(),
          );
          skipped += 1;
          continue;
        }
        rejected += 1;
        await this.recordAudit(candidate, 'deposit.rejected', pending.money, pending.accountId);

        void this.notifications
          ?.notify({
            organizationId: candidate.organizationId,
            event: NotificationEvent.DEPOSIT_FAILED,
            title: 'Deposit failed',
            body: `Your deposit of ${MoneyUtil.format(pending.money)} could not be finalized on chain. No balance was affected.`,
            subjectType: 'deposit_intent',
            subjectId: candidate.id,
            payload: {
              intentId: candidate.id,
              amount: pending.money.amount,
              asset: pending.money.asset,
            },
          })
          .catch((error) =>
            this.logger.warn(`deposit.failed notification failed: ${describe(error)}`),
          );
      }

      // After the resolving entry is durable, never before — see
      // `markFinalityResolved`. One call site for both branches so a new
      // resolution path cannot be added without leaving the queue.
      await this.deposits.markFinalityResolved(candidate.organizationId, candidate.id, new Date());
    }

    return { checked: candidates.length, confirmed, rejected, skipped };
  }

  /**
   * The audit row for a deposit this pass resolved (B7): the activity log
   * shows deposits beside the buyer's own changes. Written only by the pass
   * that won the resolving ledger entry, so a deposit is logged once; after
   * the fact, because the credit is already durable, and never throwing
   * (`recordAfterCommit`). It moves no money and nothing reads it to decide.
   */
  private async recordAudit(
    candidate: { organizationId: string; id: string; chainId: string; chainTxRef: string | null },
    action: 'deposit.confirmed' | 'deposit.rejected',
    money: { amount: string; asset: string; decimals: number },
    account: string,
  ): Promise<void> {
    await this.audit?.recordAfterCommit({
      organizationId: candidate.organizationId,
      actor: { type: 'system', id: 'deposit-finality' },
      action,
      resourceType: 'deposit',
      resourceId: candidate.id,
      before: null,
      after: {
        amount: money.amount,
        asset: money.asset,
        decimals: money.decimals,
        account,
        chainId: candidate.chainId,
        transactionHash: candidate.chainTxRef,
      },
    });
  }

  /**
   * Writes the resolving entry, or loses the race quietly.
   *
   * Returns `false` when the write failed *and the deposit turns out to be
   * resolved anyway* — another trigger got there between this pass's journal
   * read and its write. With two triggers on the path that is an ordinary
   * outcome, and the correct response is to stop: the money is credited
   * exactly once and this pass simply was not the one that did it.
   *
   * ## Why the journal is re-read instead of the error being classified
   *
   * A losing writer does not fail in one predictable way, and the first draft
   * of this method got that wrong by matching `23505` on
   * `uq_ledger_entries_deposit_resolution`. Measured, the loser usually fails
   * *earlier*: `LedgerJournalService.applyEntries` locks the balance rows and
   * checks the resulting buckets before it inserts, so the winner having
   * already consumed `pending` surfaces as "Balance folded negative" — a
   * different error, from a different guard, several frames sooner.
   *
   * Both mean the same thing here, and neither is safe to absorb on its own:
   * "balance folded negative" is a genuine invariant alarm in every other
   * context. So the question asked is the one that actually matters — *is this
   * deposit resolved now?* — and anything else is re-raised untouched.
   *
   * The unique index remains the guarantee rather than the detector. The
   * balance check is per-account arithmetic that happens to catch the common
   * shape; the index is what refuses a second credit for one signature even
   * where the arithmetic would allow it.
   */
  private async appendResolution(
    candidate: { organizationId: string; id: string },
    input: AppendEntryInput,
  ): Promise<boolean> {
    try {
      await this.ledger.appendNow(input);
      return true;
    } catch (error) {
      const entries = await this.ledger.readJournal(candidate.organizationId, {
        intentId: candidate.id,
      });
      const resolved = entries.some(
        (entry) =>
          entry.entryType === LedgerEntryType.DEPOSIT_CONFIRM ||
          entry.entryType === LedgerEntryType.DEPOSIT_REJECT,
      );

      if (!resolved) {
        throw error;
      }

      this.logger.log(
        `Deposit ${candidate.id}: ${input.chainTxRef} was resolved by another trigger first ` +
          `(${describe(error)}) — leaving the credit to it`,
      );
      return false;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
