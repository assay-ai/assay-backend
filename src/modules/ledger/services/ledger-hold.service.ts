import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { HoldResolutionKind, decideHoldTransition } from '../domain/hold-transition';
import { LedgerErrors } from '../errors/ledger.errors';
import {
  CreateHoldInput,
  HoldResolution,
  INTERNAL_ACCOUNTS,
  LedgerAccountId,
  LedgerEntryType,
  LedgerHold,
  LedgerHoldStatus,
  SettlementCredit,
} from '../ports/ledger.types';
import { LedgerJournalService } from './ledger-journal.service';
import { runInLedgerTransaction } from './ledger-transaction.util';

/**
 * Holds — the mechanism that makes settlement conditional without a refund.
 *
 * Every method here is write-through: a hold is durable before the caller is
 * answered, because a lost `HOLD_CREATE` would let an agent spend money it has
 * already committed.
 */
@Injectable()
export class LedgerHoldService {
  private readonly logger = new Logger(LedgerHoldService.name);

  constructor(
    private readonly holds: LedgerHoldRepository,
    private readonly journal: LedgerJournalService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {}

  /**
   * Reserves `money` out of `available`.
   *
   * The check and the write happen under one row lock on the account's balance
   * (`applyEntries` takes it), so two callers racing for a balance that funds
   * one of them serialise: the first commits, the second re-reads the *new*
   * available and is refused. Neither ever observes the stale value it checked
   * against, which is the only way "no hold beyond available" can be a
   * guarantee rather than a probability.
   */
  async createHold(input: CreateHoldInput): Promise<LedgerHold> {
    if (MoneyUtil.isZero(input.money)) {
      throw LedgerErrors.insufficientAvailableBalance({
        accountId: input.accountId,
        required: '0',
        available: 'a hold must reserve a non-zero amount',
      });
    }

    const holdId = randomUUID();

    try {
      return await runInLedgerTransaction(
        this.dataSource,
        async (queryRunner) => {
          const entry = this.journal.prepare({
            organizationId: input.organizationId,
            accountId: input.accountId,
            entryType: LedgerEntryType.HOLD_CREATE,
            money: input.money,
            intentId: input.intentId,
            holdId,
          });

          // The journal entry goes first: it takes the balance lock and does
          // the affordability check, so an unaffordable hold never gets as far
          // as inserting a hold row.
          await this.journal.applyEntries(queryRunner, input.organizationId, [entry]);

          await this.holds.insertOne(
            {
              id: holdId,
              organizationId: input.organizationId,
              accountId: input.accountId,
              amount: input.money.amount,
              assetId: input.money.asset,
              decimals: input.money.decimals,
              status: LedgerHoldStatus.OPEN,
              intentId: input.intentId,
              createEntryId: entry.id,
              resolveEntryId: null,
              expiresAt: input.expiresAt ?? null,
            },
            queryRunner,
          );

          return this.readHold(input.organizationId, holdId, queryRunner);
        },
        this.logger,
      );
    } catch (error) {
      // The partial unique index on `(organization_id, intent_id) WHERE OPEN`
      // is what a retried createHold collides with. Saying so beats surfacing
      // a constraint name from three layers down.
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw LedgerErrors.holdAlreadyOpen({ intentId: input.intentId });
      }
      throw error;
    }
  }

  /** Returns the reservation to `available`. Idempotent. */
  async releaseHold(organizationId: string, holdId: string): Promise<HoldResolution> {
    return this.resolve(organizationId, holdId, LedgerHoldStatus.RELEASED);
  }

  /**
   * Releases the hold only if `guard` — run FIRST, in the same transaction —
   * says so, and returns `null` (nothing written, nothing released) when it
   * does not. The guard is the caller's own write that decides the release,
   * e.g. marking a buyer debt written off only while it is still one
   * (review-buyer-debt M1): the mark and the release then commit together or
   * not at all, and a row that changed underneath is left alone. An already
   * released hold is the usual no-op (`applied: false`), after the guard ran.
   */
  async releaseHoldIf(
    organizationId: string,
    holdId: string,
    guard: (queryRunner: QueryRunner) => Promise<boolean>,
  ): Promise<HoldResolution | null> {
    return runInLedgerTransaction(
      this.dataSource,
      async (queryRunner) => {
        if (!(await guard(queryRunner))) return null;
        return this.resolveWithin(queryRunner, organizationId, holdId, LedgerHoldStatus.RELEASED);
      },
      this.logger,
    );
  }

  /** Consumes the reservation; the value leaves the account. Idempotent. */
  async commitHold(organizationId: string, holdId: string): Promise<HoldResolution> {
    return this.resolve(organizationId, holdId, LedgerHoldStatus.COMMITTED);
  }

  /**
   * Commits a hold **and** pays out the two entries that replace it
   * — `HOLD_COMMIT` on the agent's own book, `PROVIDER_CREDIT` under
   * the provider's own organization and `PLATFORM_FEE` under
   * `INTERNAL_ACCOUNTS.PLATFORM_FEES` — as one transaction under one lock on
   * the hold row.
   *
   * ## Why one transaction rather than `commitHold` then two `append`s
   *
   * `foldLiabilities`'s conservation property — a `HOLD_COMMIT` takes value
   * out of the agent's book and the matching `PROVIDER_CREDIT` /
   * `PLATFORM_FEE` put it back under their owners — is only ever true between
   * commits of the whole platform's journal. A caller that committed the hold
   * and then crashed before writing the two credits would leave the vault
   * short by exactly `providerAmount + platformFee`: a reserves breach the
   * 5-minute reconciler pages on, not a bookkeeping nicety it can wait out.
   * Doing all three writes under one Postgres transaction makes that gap
   * impossible rather than merely narrow — the worker either wrote nothing or
   * wrote all three, because a crash mid-transaction rolls the whole thing
   * back and a retry finds the hold still `OPEN`.
   *
   * ## Two `applyEntries` calls, not one
   *
   * `LedgerJournalService.applyEntries` locks and updates every row it is
   * given under **one** `organizationId` — that is how it groups the balance
   * keys it needs to lock. The `HOLD_COMMIT` and `PLATFORM_FEE` entries share
   * the caller's own `organizationId` (see the class comment on
   * `SettlementCredit` for why the platform's cut is booked alongside the
   * commit rather than under a separate "platform organization" this codebase
   * has no concept of), so they go in one call. `PROVIDER_CREDIT` belongs to a
   * *different* organization — the provider's — so it needs its own call.
   * Both calls run against the same `queryRunner`, so they are still one
   * transaction; `applyEntries` itself does not know or care that it was
   * invoked twice.
   *
   * ## The durable guard behind the transaction
   *
   * A transaction closes the crash window for *this* call, but not for a
   * second, independent writer reaching the same intent through some other
   * path — a manual repair script, a future caller that forgets this method
   * exists and calls `append` directly. The migration's partial unique index
   * on `ledger_entries (organization_id, intent_id, entry_type)` for
   * `PROVIDER_CREDIT` and `PLATFORM_FEE` is what refuses that second writer at
   * the database, independently of anything this method decides.
   *
   * ## Conservation, checked before anything is written
   *
   * `providerAmount + platformFee` is what the buyer is charged, and it may
   * not exceed the hold. It may be **less**: a rail-A hold is the quote (the
   * dearest eligible binding) and the intent is re-priced to the binding that
   * served, so the `HOLD_COMMIT` takes exactly the charge and a `HOLD_RELEASE`
   * on the same hold returns the remainder, in the same transaction.
   * `payment_intents` carries the matching CHECK
   * (`provider_amount + platform_fee = price_amount`), so the credit always
   * equals the intent's price. A credit above the hold, or in another asset,
   * fails loudly with `LEDGER_SETTLEMENT_CREDIT_MISMATCH` rather than quietly
   * writing a journal `foldLiabilities` would silently over-report from.
   */
  async commitHoldAndCredit(
    organizationId: string,
    holdId: string,
    credit: SettlementCredit,
  ): Promise<HoldResolution> {
    if (typeof credit.chainTxRef !== 'string' || credit.chainTxRef.trim() === '') {
      // The chain ref is required. Checked before the transaction opens, so a refused commit costs
      // nothing and leaves the hold exactly as it was.
      throw LedgerErrors.settlementCreditMissingChainRef({ holdId, intentId: credit.intentId });
    }
    const chainTxRef = credit.chainTxRef;

    return runInLedgerTransaction(
      this.dataSource,
      async (queryRunner) => {
        const row = await this.holds.lockById(organizationId, holdId, queryRunner);
        if (!row) {
          throw LedgerErrors.holdNotFound({ holdId });
        }

        const decision = decideHoldTransition(
          row.status as LedgerHoldStatus,
          LedgerHoldStatus.COMMITTED,
          { holdId, intentId: row.intentId },
        );

        if (decision.kind === 'NOOP') {
          // Already committed — by this call or an earlier one. The two
          // credits went out exactly once, on whichever call actually applied
          // the commit; writing them again here would double-pay the provider
          // and the platform for one call.
          return { hold: toLedgerHold(row), applied: false };
        }

        const heldAmount = MoneyUtil.of(row.amount, row.assetId as AssetId, row.decimals);
        const creditedAmount = MoneyUtil.add(credit.providerAmount, credit.platformFee);
        if (
          heldAmount.asset !== creditedAmount.asset ||
          MoneyUtil.toAtomic(creditedAmount) > MoneyUtil.toAtomic(heldAmount)
        ) {
          throw LedgerErrors.settlementCreditMismatch({
            holdId,
            committed: MoneyUtil.format(heldAmount),
            credited: MoneyUtil.format(creditedAmount),
          });
        }

        // What the buyer is charged is the credit, never more than was held.
        // The rest of the hold — the quote less the serving binding's price —
        // goes back to `available` as a HOLD_RELEASE on the same hold.
        const commitEntry = this.journal.prepare({
          organizationId,
          accountId: row.accountId as LedgerAccountId,
          entryType: decision.entryType,
          money: creditedAmount,
          intentId: row.intentId,
          holdId,
          chainTxRef,
        });
        const remainder = MoneyUtil.subtract(heldAmount, creditedAmount);
        const releaseEntries = MoneyUtil.isZero(remainder)
          ? []
          : [
              this.journal.prepare({
                organizationId,
                accountId: row.accountId as LedgerAccountId,
                entryType: LedgerEntryType.HOLD_RELEASE,
                money: remainder,
                intentId: row.intentId,
                holdId,
              }),
            ];
        const platformFeeEntry = this.journal.prepare({
          organizationId,
          accountId: INTERNAL_ACCOUNTS.PLATFORM_FEES,
          entryType: LedgerEntryType.PLATFORM_FEE,
          money: credit.platformFee,
          intentId: credit.intentId,
          chainTxRef,
        });

        await this.journal.applyEntries(queryRunner, organizationId, [
          commitEntry,
          ...releaseEntries,
          platformFeeEntry,
        ]);

        const providerCreditEntry = this.journal.prepare({
          organizationId: credit.providerOrganizationId,
          accountId: credit.providerAccountId,
          entryType: LedgerEntryType.PROVIDER_CREDIT,
          money: credit.providerAmount,
          intentId: credit.intentId,
          chainTxRef,
        });

        await this.journal.applyEntries(queryRunner, credit.providerOrganizationId, [
          providerCreditEntry,
        ]);

        const affected = await this.holds.resolveIfOpen(
          organizationId,
          holdId,
          decision.to,
          commitEntry.id,
          queryRunner,
        );
        if (affected !== 1) {
          throw LedgerErrors.holdAlreadyResolved({
            holdId,
            intentId: row.intentId,
            resolution: 'resolved by a concurrent writer',
            requested: decision.to.toLowerCase(),
          });
        }

        return {
          hold: await this.readHold(organizationId, holdId, queryRunner),
          applied: true,
        };
      },
      this.logger,
    );
  }

  async getHold(organizationId: string, holdId: string): Promise<LedgerHold> {
    const row = await this.holds.findOneBy({ organizationId, id: holdId });
    if (!row) {
      throw LedgerErrors.holdNotFound({ holdId });
    }
    return toLedgerHold(row);
  }

  /**
   * Applies a resolution exactly once.
   *
   * Three things have to be true together, which is why they are one
   * transaction under one lock on the hold row:
   *
   * 1. the decision is taken against the hold's *current* status, not a status
   *    read before someone else's commit;
   * 2. the journal entry is written only if the decision was `APPLY`;
   * 3. the status moves only if it was still `OPEN` — the `UPDATE … WHERE
   *    status = 'OPEN'` is a compare-and-set, and a zero row count aborts the
   *    whole transaction rather than leaving an entry with no state change
   *    behind it.
   *
   * Under the lock (3) cannot fail; it is kept because the cost of the check is
   * nothing and the cost of being wrong is a double refund.
   */
  private async resolve(
    organizationId: string,
    holdId: string,
    to: HoldResolutionKind,
  ): Promise<HoldResolution> {
    return runInLedgerTransaction(
      this.dataSource,
      (queryRunner) => this.resolveWithin(queryRunner, organizationId, holdId, to),
      this.logger,
    );
  }

  private async resolveWithin(
    queryRunner: QueryRunner,
    organizationId: string,
    holdId: string,
    to: HoldResolutionKind,
  ): Promise<HoldResolution> {
    const row = await this.holds.lockById(organizationId, holdId, queryRunner);
    if (!row) {
      throw LedgerErrors.holdNotFound({ holdId });
    }

    const decision = decideHoldTransition(row.status as LedgerHoldStatus, to, {
      holdId,
      intentId: row.intentId,
    });

    if (decision.kind === 'NOOP') {
      // Already in the requested state. No entry, no delta, no second
      // refund — and `applied: false` so the caller can tell.
      return { hold: toLedgerHold(row), applied: false };
    }

    const entry = this.journal.prepare({
      organizationId,
      accountId: row.accountId as LedgerAccountId,
      entryType: decision.entryType,
      money: MoneyUtil.of(row.amount, row.assetId as AssetId, row.decimals),
      intentId: row.intentId,
      holdId,
    });

    await this.journal.applyEntries(queryRunner, organizationId, [entry]);

    const affected = await this.holds.resolveIfOpen(
      organizationId,
      holdId,
      decision.to,
      entry.id,
      queryRunner,
    );
    if (affected !== 1) {
      throw LedgerErrors.holdAlreadyResolved({
        holdId,
        intentId: row.intentId,
        resolution: 'resolved by a concurrent writer',
        requested: decision.to.toLowerCase(),
      });
    }

    return {
      hold: await this.readHold(organizationId, holdId, queryRunner),
      applied: true,
    };
  }

  private async readHold(
    organizationId: string,
    holdId: string,
    queryRunner: QueryRunner,
  ): Promise<LedgerHold> {
    const row = await this.holds.lockById(organizationId, holdId, queryRunner);
    if (!row) {
      throw LedgerErrors.holdNotFound({ holdId });
    }
    return toLedgerHold(row);
  }
}

export function toLedgerHold(row: LedgerHoldEntity): LedgerHold {
  return {
    id: row.id,
    organizationId: row.organizationId,
    accountId: row.accountId as LedgerAccountId,
    money: MoneyUtil.of(row.amount, row.assetId as AssetId, row.decimals),
    status: row.status as LedgerHoldStatus,
    intentId: row.intentId,
    createEntryId: row.createEntryId,
    resolveEntryId: row.resolveEntryId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
