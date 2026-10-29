import { MigrationInterface, QueryRunner } from 'typeorm';

const INDEXES = [
  {
    name: 'idx_protocol_analytics_funded',
    table: 'payment_intents',
    columns: 'asset_id, created_at',
    predicate: "call_class = 'PAID' AND hold_id IS NOT NULL AND price_amount > 0",
  },
  {
    name: 'idx_protocol_analytics_entries',
    table: 'ledger_entries',
    columns: 'asset_id, intent_id',
    predicate: "entry_type IN ('PLATFORM_FEE', 'PROVIDER_CREDIT')",
  },
] as const;

/** Concurrent builds keep payment writes available while these read indexes are added. */
export class ProtocolAnalyticsReadIndexes1793232000000 implements MigrationInterface {
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of INDEXES) {
      // A cancelled concurrent build can leave an invalid index. IF NOT EXISTS
      // alone would silently keep it, so retry the build after removing it.
      const invalid: unknown[] = await queryRunner.query(
        `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = $1 AND n.nspname = current_schema() AND NOT i.indisvalid`,
        [index.name],
      );
      if (invalid.length) {
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
      }
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}"
         ON "${index.table}" (${index.columns}) WHERE ${index.predicate}`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // TypeORM can wrap undoLastMigration in a transaction even though up is
    // non-transactional; a plain DROP works in that maintenance path.
    for (const index of [...INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${index.name}"`);
    }
  }
}
