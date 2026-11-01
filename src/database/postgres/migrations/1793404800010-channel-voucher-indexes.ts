import { MigrationInterface, QueryRunner } from 'typeorm';

import { nonTransactionalStep } from '../non-transactional-migration';

/**
 * The VALIDATE of the channel door's two CHECKs, and the two `payment_intents` indexes of the channel door
 * (`ChannelVouchers1793404800000`), built `CONCURRENTLY` outside a
 * transaction, like `PaymentIntentsCreatedIndex1762400000040`: a plain
 * `CREATE INDEX` on `payment_intents` blocks every paid call while it builds
 * (review 2026-10-31 M4).
 *
 * - `uq_payment_intents_channel_cumulative`: one call per channel position.
 * - `idx_payment_intents_channel_held`: the channel calls in a bucket, by
 *   maturity (collect, refund, the reconciler's mirror).
 *
 * A half-built (INVALID) index from an earlier attempt is dropped first, since
 * `IF NOT EXISTS` would skip it. A harness without `voucher_format` (one that
 * builds only the provider half of the schema) gets nothing.
 */
const INDEXES: readonly { name: string; sql: string }[] = [
  {
    name: 'uq_payment_intents_channel_cumulative',
    sql:
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_payment_intents_channel_cumulative" ` +
      `ON "payment_intents" ("channel_row_id", "channel_cumulative") ` +
      `WHERE "channel_row_id" IS NOT NULL`,
  },
  {
    name: 'idx_payment_intents_channel_held',
    sql:
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payment_intents_channel_held" ` +
      `ON "payment_intents" ("channel_row_id", "collectable_at") ` +
      `WHERE "voucher_format" = 'CHANNEL' AND "held_status" = 'HELD'`,
  },
];

/** The NOT VALID checks of `ChannelVouchers1793404800000`, validated here. */
const VALIDATE: readonly (readonly [string, string])[] = [
  ['payment_intents', 'chk_payment_intents_voucher_format'],
  ['providers', 'chk_providers_payout_cadence'],
];

export class ChannelVoucherIndexes1793404800010 implements MigrationInterface {
  name = 'ChannelVoucherIndexes1793404800010';

  transaction = false;

  /** With session timeouts and a run lock (final review ops F6). */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await nonTransactionalStep(queryRunner, this.name, () => this.upStep(queryRunner));
  }

  private async upStep(queryRunner: QueryRunner): Promise<void> {
    // The NOT VALID checks of 1793404800000, validated here, outside any
    // transaction: the scan runs under SHARE UPDATE EXCLUSIVE and paid calls
    // keep reading and writing (re-review F3).
    for (const [table, constraint] of VALIDATE) {
      const [found] = (await queryRunner.query(
        `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
        [constraint],
      )) as { convalidated: boolean }[];
      if (found && !found.convalidated) {
        await queryRunner.query(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${constraint}"`);
      }
    }
    if (
      !(await queryRunner.hasTable('payment_intents')) ||
      !(await queryRunner.hasColumn('payment_intents', 'voucher_format'))
    ) {
      return;
    }
    for (const index of INDEXES) {
      const invalid = (await queryRunner.query(
        `SELECT 1 FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = current_schema() AND NOT i.indisvalid`,
        [index.name],
      )) as unknown[];
      if (invalid.length > 0) {
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
      }
      await queryRunner.query(index.sql);
    }
  }

  /**
   * A plain `DROP INDEX`: TypeORM's `undoLastMigration` runs `down` inside a
   * transaction even with `transaction = false`, where `CONCURRENTLY` is
   * refused, and a revert is a maintenance step, not live traffic.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of [...INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${index.name}"`);
    }
  }
}
