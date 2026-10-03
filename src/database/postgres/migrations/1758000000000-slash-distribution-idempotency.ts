import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The idempotency guarantee for compensation, as a **constraint rather
 * than a convention**.
 *
 * A slash execution that is retried — the pass runs every minute, and a failed
 * attempt returns the case to `UPHELD` for the next tick — must not credit the
 * harmed agents twice. The natural key is the chain signature plus the account:
 * one `SLASH_DISTRIBUTION` per agent per executed slash.
 *
 * The existing `uq_ledger_entries_intent_credit_type` cannot serve. It is
 * partial on `(organization_id, intent_id, entry_type)` and a slash
 * distribution carries **no `intent_id`** — a window-level penalty is not owed
 * to one call. Under Postgres nulls are distinct in a unique index, so that
 * index would admit unlimited duplicates here.
 *
 * A read-before-write would not close it either: two ticks can interleave
 * between the read and the insert, and the whole point of the retry path is
 * that it runs concurrently with itself after a crash.
 *
 * `chain_tx_ref IS NOT NULL` is in the predicate because a distribution with no
 * signature has nothing to be idempotent against, and writing one is a bug this
 * index should not silently permit.
 *
 * Deliberately **separate from the `slash_proposals` column migration**: this
 * one touches only `ledger_entries`, so the settlement integration harness —
 * which builds its database from an explicit list of ledger migrations and has
 * no slash tables at all — can run it and actually exercise the constraint.
 * A migration that spanned both tables could not be tested anywhere.
 */
export class SlashDistributionIdempotency1758000000000 implements MigrationInterface {
  name = 'SlashDistributionIdempotency1758000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_ledger_entries_slash_distribution"
      ON "ledger_entries" ("organization_id", "account_id", "chain_tx_ref")
      WHERE "entry_type" = 'SLASH_DISTRIBUTION' AND "chain_tx_ref" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_ledger_entries_slash_distribution"`);
  }
}
