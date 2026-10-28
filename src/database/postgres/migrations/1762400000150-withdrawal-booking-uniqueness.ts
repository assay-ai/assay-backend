import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One `WITHDRAWAL` debit per claimed `EscrowWithdrawn` log, enforced by the
 * database.
 *
 * `ClaimedWithdrawalBooker` books each indexed claim as a `WITHDRAWAL` entry
 * whose `chain_tx_ref` is `<transaction hash>:<log index>`. It finds the claims
 * still to book by that ref, so a retried pass, or two passes racing, could
 * otherwise debit one claim twice. Same shape as
 * `uq_ledger_entries_deposit_pending`: partial on the one entry type, so no
 * other entry's ref is affected. Nothing wrote a `WITHDRAWAL` entry before
 * this, so there is no duplicate to fail on.
 */
export class WithdrawalBookingUniqueness1762400000150 implements MigrationInterface {
  name = 'WithdrawalBookingUniqueness1762400000150';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_ledger_entries_withdrawal"
        ON "ledger_entries" ("chain_tx_ref")
        WHERE "entry_type" = 'WITHDRAWAL'
          AND "chain_tx_ref" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_ledger_entries_withdrawal"`);
  }
}
