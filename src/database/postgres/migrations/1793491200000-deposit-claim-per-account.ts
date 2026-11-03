import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One deposit claim per (transaction, buyer account), not per transaction.
 *
 * A batch transaction can carry escrow `Deposited` events for two different
 * buyers. Keyed on the hash alone, the first buyer to claim it burned the
 * hash for the second, whose real deposit could then never be credited. The
 * claim unit is now the pair: each buyer claims only its own events in the
 * transaction (summed), once. A second claim for the same buyer is still
 * refused by the database.
 *
 * Safe to build on existing rows: the old indexes were unique on
 * `chain_tx_ref` alone, which implies unique on `(chain_tx_ref, account_id)`.
 * The new indexes are built first and the old ones dropped after, so the
 * guarantee never lapses. Concurrent builds, outside a transaction, so
 * ledger writes are not blocked while they run.
 */
const INDEXES = [
  {
    name: 'uq_ledger_entries_deposit_pending_account',
    old: 'uq_ledger_entries_deposit_pending',
    predicate: `"entry_type" = 'DEPOSIT_PENDING' AND "chain_tx_ref" IS NOT NULL`,
  },
  {
    name: 'uq_ledger_entries_deposit_resolution_account',
    old: 'uq_ledger_entries_deposit_resolution',
    predicate: `"entry_type" IN ('DEPOSIT_CONFIRM', 'DEPOSIT_REJECT') AND "chain_tx_ref" IS NOT NULL`,
  },
] as const;

export class DepositClaimPerAccount1793491200000 implements MigrationInterface {
  name = 'DepositClaimPerAccount1793491200000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of INDEXES) {
      // A cancelled concurrent build leaves an invalid index that IF NOT EXISTS
      // would keep; drop it and build again.
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
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}"
           ON "ledger_entries" ("chain_tx_ref", "account_id")
           WHERE ${index.predicate}`,
      );
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.old}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rebuilding the hash-only indexes fails if a batch transaction has since
    // been claimed by two buyers; that is the state this migration allows, and
    // undoing it needs a reviewed repair first, not a silent drop.
    for (const index of INDEXES) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${index.old}"
           ON "ledger_entries" ("chain_tx_ref")
           WHERE ${index.predicate}`,
      );
      await queryRunner.query(`DROP INDEX IF EXISTS "${index.name}"`);
    }
  }
}
