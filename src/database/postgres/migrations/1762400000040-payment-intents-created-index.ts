import { MigrationInterface, QueryRunner } from 'typeorm';

const INDEX = 'idx_payment_intents_created_at';

/**
 * `payment_intents (created_at)`, for the operator health tile.
 *
 * `PlatformMetricsRepository.intentRateCounts` counts intents created in the
 * last ~61 minutes across every tenant. Every other index on the table leads
 * with a tenant, a provider or a status, and the Explorer's
 * `idx_payment_intents_paid_held_created` is partial (paid calls that reserved
 * funds only), so it cannot answer a count of all intents. Without this the
 * count is a sequential scan of the whole table on each poll.
 *
 * Built `CONCURRENTLY` outside a transaction, like
 * `PublicExplorerIndex1760400000000`: a plain `CREATE INDEX` would block every
 * paid call while it builds. A half-built (INVALID) index from an earlier
 * attempt is dropped first, since `IF NOT EXISTS` would skip it.
 */
export class PaymentIntentsCreatedIndex1762400000040 implements MigrationInterface {
  name = 'PaymentIntentsCreatedIndex1762400000040';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const invalid = (await queryRunner.query(
      `SELECT 1 FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = current_schema() AND NOT i.indisvalid`,
      [INDEX],
    )) as unknown[];
    if (invalid.length > 0) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "payment_intents" ("created_at")`,
    );
  }

  /**
   * A plain `DROP INDEX`: TypeORM's `undoLastMigration` runs `down` inside a
   * transaction even with `transaction = false`, where `CONCURRENTLY` is
   * refused, and a revert is a maintenance step, not live traffic.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX}"`);
  }
}
