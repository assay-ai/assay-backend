import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The deposit finality sweep needs a **queue predicate**, not just a batch.
 *
 * ## What was wrong
 *
 * `DepositIntentRepository.findSettledAwaitingFinality` selected every
 * `SETTLED` deposit that carries a `chain_tx_ref`, ordered by `updated_at ASC`,
 * `LIMIT 200`. Nothing ever left that set: `DepositFinalityService`
 * `promotePendingDeposits` writes `DEPOSIT_CONFIRM` / `DEPOSIT_REJECT` into the
 * ledger and never touches the `deposit_intents` row, and `updated_at` is an
 * `@UpdateDateColumn` — it moves only on a real `UPDATE`, the last of which is
 * the `SETTLING -> SETTLED` transition.
 *
 * So the 200 oldest settled deposits are a **permanent prefix**. Once a
 * deployment accumulates 200 of them, a newly settled deposit sorts *last* by
 * `updated_at`, never enters the window, and is never promoted — its money
 * stays in `pending` and never becomes spendable.
 *
 * It is silent in every direction. `DepositFinalityJob` logs only when
 * `confirmed || rejected`, so a permanently stuck sweep prints nothing while
 * burning 200 journal reads every five minutes. And proof-of-reserves cannot
 * see it either: `DEPOSIT_PENDING` and `DEPOSIT_CONFIRM` sit in the same book
 * and their effects move value between `pending` and `available` without
 * changing the total, so agent liability is identical whether the promotion
 * happened or not.
 *
 * ## The fix
 *
 * A nullable resolution timestamp plus a partial index on the sweep's ordering
 * column, so a resolved deposit leaves the candidate set instead of being
 * re-read forever.
 *
 * This is the same shape as `payment_intents.hold_released_at` on the sibling
 * table for the sibling sweep — read as a queue predicate by
 * `findExpiredWithUnreleasedHold` and `sumOpenHoldsByProvider` — and as
 * `provider_stake_grace.resolved_at` and `tool_requests.first_responded_at`,
 * both of which back a partial index built for exactly that predicate.
 *
 * **The column is the queue, not the record.** The ledger journal stays
 * authoritative for *what happened*: `DepositFinalityService` still reads it
 * per candidate and still refuses to write a second resolution entry. That
 * ordering matters — the ledger entry is appended first and the column stamped
 * after, so a crash in between costs one extra journal read on the next pass
 * rather than stranding a deposit. The original comment on
 * `findSettledAwaitingFinality` argued against "a second place that tracks
 * whether a deposit was promoted, which could drift from the journal"; that
 * reasoning is preserved by keeping the journal as the guard and demoting the
 * column to a cheap predicate that can only ever cost a redundant read.
 *
 * For the same reason there is deliberately **no `finality_resolution` value**
 * beside the timestamp. `DEPOSIT_CONFIRM` versus `DEPOSIT_REJECT` is already
 * recorded in the journal, and a second copy of the verdict is precisely the
 * drift the comment above warns about. A timestamp cannot disagree with the
 * journal about anything except "was this looked at", which is all the sweep
 * asks.
 *
 * ## The backfill
 *
 * Shipped in the same migration so the first post-deploy sweep is already
 * correct, rather than re-visiting every historical deposit once before the
 * predicate starts helping. It reads `ledger_entries.intent_id`, which for a
 * deposit carries the **deposit intent's** id — written by
 * `DepositService.settleDeposit` and by `DepositFinalityService` itself. The
 * comment on `LedgerEntryEntity.intentId` claimed the opposite ("`null` for
 * deposits") and was wrong; it is corrected in the same change. Code is
 * authoritative.
 *
 * `MIN(created_at)` per intent rather than a bare join, so a duplicate
 * resolution entry (nothing constrains that today —
 * `uq_ledger_entries_intent_credit_type` is partial on `PROVIDER_CREDIT` /
 * `PLATFORM_FEE` only) cannot make the stamped value depend on scan order.
 *
 * The index is created **after** the backfill: it is partial on
 * `finality_resolved_at IS NULL`, so building it last means building it over
 * the rows that will actually be in it.
 *
 * ## Locking
 *
 * `CREATE INDEX` here is **not** `CONCURRENTLY` — no migration in this
 * repository is (zero of thirty-two), and `migrationsTransactionMode: 'each'`
 * means one could not be. So this takes a write lock on `deposit_intents` for
 * the duration of the build plus the duration of the backfill's `UPDATE`.
 * `deposit_intents` is small and short-lived by construction (a deposit intent
 * lives 90 seconds unfunded), so the window is negligible today. If that table
 * ever grows, this migration is the precedent to break, not to copy.
 *
 * Touches `deposit_intents` and reads `ledger_entries` — both are in the
 * migration list of `test/integration/helpers/deposit-test-context.ts`, so the
 * backfill is exercisable there rather than only in production.
 */
export class DepositFinalityResolution1758100000001 implements MigrationInterface {
  name = 'DepositFinalityResolution1758100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "deposit_intents" ADD COLUMN "finality_resolved_at" timestamptz`,
    );

    await queryRunner.query(`
      UPDATE "deposit_intents" di
         SET "finality_resolved_at" = resolved."resolved_at"
        FROM (
          SELECT "intent_id", MIN("created_at") AS "resolved_at"
            FROM "ledger_entries"
           WHERE "entry_type" IN ('DEPOSIT_CONFIRM', 'DEPOSIT_REJECT')
             AND "intent_id" IS NOT NULL
           GROUP BY "intent_id"
        ) AS resolved
       WHERE resolved."intent_id" = di."id"
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_deposit_intents_awaiting_finality"
        ON "deposit_intents" ("updated_at")
        WHERE "finality_resolved_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_deposit_intents_awaiting_finality"`);
    await queryRunner.query(
      `ALTER TABLE "deposit_intents" DROP COLUMN IF EXISTS "finality_resolved_at"`,
    );
  }
}
