import { MigrationInterface, QueryRunner } from 'typeorm';

import { nonTransactionalStep } from '../non-transactional-migration';

const INDEX = 'idx_payment_intents_open_debt';
const NEXT = 'idx_payment_intents_open_debt_next';

/** `DEBT_REFUSING_SQL` before this migration (1760800000000). */
const OLD_PREDICATE =
  `"redemption_lapsed_at" IS NOT NULL ` +
  `AND ("hold_released_at" IS NULL OR "redemption_last_error" LIKE 'uncollected:%')`;
/** …and after it: a replacement HELD on chain no longer refuses (owner decision 2026-10-31). */
const NEW_PREDICATE = `${OLD_PREDICATE} AND ("redemption_replaced_at" IS NULL OR "held_status" IS NULL)`;

/**
 * Rebuilds `idx_payment_intents_open_debt` on the relaxed H-1 debt guard
 * (`DEBT_REFUSING_SQL`): a debt whose replacement payment is held on chain
 * stops refusing the payer's paid calls. The index keeps exactly the guard's
 * predicate, so every debt read stays an index scan.
 *
 * Built `CONCURRENTLY` outside a transaction under a temporary name, then the
 * old index is dropped and the new one renamed: paid calls are never blocked,
 * and there is never a moment with no index (prod is live). A half-built
 * leftover of an earlier attempt is dropped first. A harness without the debt
 * columns gets nothing.
 *
 * Old pods (final review 2026-11-01 ops F5): `migrate` runs while the
 * previous image still serves. That image's debt guard filters on the OLD
 * predicate only, which Postgres cannot prove from the new partial index, so
 * once this migration has run the old image's `findOutstandingDebts` (every
 * paid call), the spike monitor and the debt list fall back to the
 * org/account indexes (correct, slower) until the new image is live. If the
 * new image then fails its health check and the old one keeps serving, either
 * finish the deploy promptly or roll this migration back (`down` restores the
 * old predicate). No money effect: the guard's answer is the same, only its
 * plan differs.
 */
export class DebtGuardHeldReplacement1793404800020 implements MigrationInterface {
  name = 'DebtGuardHeldReplacement1793404800020';

  transaction = false;

  /** With session timeouts and a run lock (final review ops F6). */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await nonTransactionalStep(queryRunner, this.name, () => this.upStep(queryRunner));
  }

  private async upStep(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.applies(queryRunner))) return;
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${NEXT}"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "${NEXT}" ON "payment_intents" ("agent_account", "organization_id")
         WHERE ${NEW_PREDICATE}`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    await queryRunner.query(`ALTER INDEX "${NEXT}" RENAME TO "${INDEX}"`);
  }

  /**
   * Back to the strict predicate. A plain `CREATE`/`DROP`: TypeORM's
   * `undoLastMigration` runs `down` inside a transaction, where
   * `CONCURRENTLY` is refused; a revert is a maintenance step.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.applies(queryRunner))) return;
    await queryRunner.query(`DROP INDEX IF EXISTS "${NEXT}"`);
    await queryRunner.query(
      `CREATE INDEX "${NEXT}" ON "payment_intents" ("agent_account", "organization_id")
         WHERE ${OLD_PREDICATE}`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX}"`);
    await queryRunner.query(`ALTER INDEX "${NEXT}" RENAME TO "${INDEX}"`);
  }

  private async applies(queryRunner: QueryRunner): Promise<boolean> {
    return (
      (await queryRunner.hasTable('payment_intents')) &&
      (await queryRunner.hasColumn('payment_intents', 'redemption_replaced_at')) &&
      (await queryRunner.hasColumn('payment_intents', 'held_status'))
    );
  }
}
