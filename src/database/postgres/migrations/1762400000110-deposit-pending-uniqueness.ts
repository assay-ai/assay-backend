import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One pending credit per on-chain signature, enforced by the database.
 *
 * ## The gap this closes
 *
 * `uq_ledger_entries_deposit_resolution` (migration 1758200000000) makes the
 * *resolving* entry single-use per signature, but it is partial on
 * `DEPOSIT_CONFIRM` / `DEPOSIT_REJECT` only — deliberately, because the
 * `DEPOSIT_PENDING` row carries the same `chain_tx_ref` and an index over the
 * bare column would refuse the confirm that must follow the pending.
 *
 * Nothing therefore kept `DEPOSIT_PENDING` itself single-use. The buyer-broadcast
 * path (`DepositService.settleDepositByBroadcast`) guards a re-used transaction
 * with a read-then-write `findByChainTxRef`, and `chain_tx_ref` stays NULL on an
 * intent until it reaches SETTLED — so two intents in one organization can both
 * read "unclaimed", both observe one real transfer, and both write
 * `DEPOSIT_PENDING` for the same signature. The phantom pending inflates
 * liabilities (→ reconciliation `RESERVES_BREACH` → withdrawals frozen) and let
 * two SETTLED intents enter finality for one transfer.
 *
 * A read can never close a read-then-write race; the invariant belongs here, as
 * its sibling index already decided. This one keys on the same signature but
 * over the pending type, so a transfer is credited-as-pending once and resolved
 * once, and the two indexes never see each other's rows. Rail-A book credits use
 * `RAIL_A_BOOK_CREDIT_TX_REF` on `PROVIDER_CREDIT`/`PLATFORM_FEE` entries, not
 * `DEPOSIT_PENDING`, so they fall outside this predicate.
 *
 * `CREATE UNIQUE INDEX` (not `CONCURRENTLY`) because TypeORM runs each migration
 * inside a transaction; the table is small and the write lock is milliseconds.
 */
export class DepositPendingUniqueness1762400000110 implements MigrationInterface {
  name = 'DepositPendingUniqueness1762400000110';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fail loud before building, as the sibling resolution migration does. The
    // very incident this closes could have committed two DEPOSIT_PENDING rows
    // for one signature; if any such pair survives here, a bare CREATE UNIQUE
    // INDEX would throw mid-migration, roll back, and block the deploy — and
    // `ledger_entries`' append-only trigger makes the duplicate painful to
    // remove. Surface the offending signatures instead of a raw 23505 so the
    // operator can run a reviewed repair first.
    const dups: Array<{ chain_tx_ref: string }> = await queryRunner.query(`
      SELECT "chain_tx_ref" FROM "ledger_entries"
      WHERE "entry_type" = 'DEPOSIT_PENDING' AND "chain_tx_ref" IS NOT NULL
      GROUP BY "chain_tx_ref" HAVING count(*) > 1
    `);
    if (dups.length > 0) {
      const refs = dups.map((d) => d.chain_tx_ref).join(', ');
      throw new Error(
        `Cannot build uq_ledger_entries_deposit_pending: ${dups.length} signature(s) ` +
          `already have more than one DEPOSIT_PENDING row (${refs}). Resolve the duplicate ` +
          `pending credits before applying this migration.`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_ledger_entries_deposit_pending"
        ON "ledger_entries" ("chain_tx_ref")
        WHERE "entry_type" = 'DEPOSIT_PENDING'
          AND "chain_tx_ref" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_ledger_entries_deposit_pending"`);
  }
}
