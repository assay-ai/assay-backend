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
 * Also, for the deposit hardening that ships with it:
 * - `deposit_intents.submitted_tx_ref`: the transaction an intent is settling
 *   on, so the finality job can resume a `SETTLING` intent whose request died;
 * - `idx_deposit_intents_account_created`: the broadcast time bound reads the
 *   earliest unsettled intent of a buyer account;
 * - `idx_ledger_entries_deposit_legacy_account`: the "already claimed" lookup
 *   over legacy `DEPOSIT` rows (the `DEPOSIT_PENDING` arm uses the new unique
 *   index).
 *
 * **Run this before deploying the code that needs it.** The new code writes
 * `submitted_tx_ref`, and until the per-account indexes exist the second buyer
 * of a batch transaction still hits the old hash-only index.
 *
 * Safe to build on existing rows: the old indexes were unique on
 * `chain_tx_ref` alone, which implies unique on `(chain_tx_ref, account_id)`.
 * Every new index is built before either old one is dropped, so the guarantee
 * never lapses and a failure part way leaves the old pair in force (rerun to
 * finish). Concurrent builds, outside a transaction, so ledger writes are not
 * blocked while they run. The column is nullable with no default: a catalog
 * change only.
 */
const UNIQUE_INDEXES = [
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

const PLAIN_INDEXES = [
  {
    name: 'idx_ledger_entries_deposit_legacy_account',
    definition: `ON "ledger_entries" ("chain_tx_ref", "account_id")
           WHERE "entry_type" = 'DEPOSIT' AND "chain_tx_ref" IS NOT NULL`,
  },
  {
    name: 'idx_deposit_intents_account_created',
    definition: `ON "deposit_intents" ("agent_account", "created_at")`,
  },
] as const;

export class DepositClaimPerAccount1793491200000 implements MigrationInterface {
  name = 'DepositClaimPerAccount1793491200000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "deposit_intents" ADD COLUMN IF NOT EXISTS "submitted_tx_ref" varchar(256)`,
    );
    for (const index of PLAIN_INDEXES) {
      await dropIfInvalid(queryRunner, index.name);
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ${index.definition}`,
      );
    }
    // Both new unique indexes first, then both old ones dropped.
    for (const index of UNIQUE_INDEXES) {
      await dropIfInvalid(queryRunner, index.name);
      await queryRunner.query(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}"
           ON "ledger_entries" ("chain_tx_ref", "account_id")
           WHERE ${index.predicate}`,
      );
    }
    for (const index of UNIQUE_INDEXES) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.old}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rebuilding the hash-only indexes fails if a batch transaction has since
    // been claimed by two buyers; that is the state this migration allows, and
    // undoing it needs a reviewed repair first, not a silent drop. Concurrent,
    // like `up`, so paid calls keep writing the ledger meanwhile.
    for (const index of UNIQUE_INDEXES) {
      await dropIfInvalid(queryRunner, index.old);
      await queryRunner.query(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${index.old}"
           ON "ledger_entries" ("chain_tx_ref")
           WHERE ${index.predicate}`,
      );
    }
    for (const index of UNIQUE_INDEXES) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    }
    for (const index of PLAIN_INDEXES) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    }
    await queryRunner.query(
      `ALTER TABLE "deposit_intents" DROP COLUMN IF EXISTS "submitted_tx_ref"`,
    );
  }
}

/** A cancelled concurrent build leaves an invalid index that IF NOT EXISTS would keep. */
async function dropIfInvalid(queryRunner: QueryRunner, name: string): Promise<void> {
  const invalid: unknown[] = await queryRunner.query(
    `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = current_schema() AND NOT i.indisvalid`,
    [name],
  );
  if (invalid.length) {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
  }
}
