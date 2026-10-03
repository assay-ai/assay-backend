import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The reconciler learns to check escrows and the earnings vault.
 *
 * The pooled Squads vault is not the only place the platform's money sits any
 * more. With per-buyer escrows each buyer has their own `["escrow", buyer]` PDA
 * and every provider's unpaid earnings sit in one `["earnings_vault"]` token
 * account, so the one-inequality run this table was built for becomes three.
 * These columns are where the two new ones are recorded.
 *
 * **Every column is nullable, and that is load-bearing.** A failed run writes a
 * row with nothing in it — that is how "the reconciler ran and could not read
 * the chain" is told apart from "the reconciler stopped running" — and every
 * row written before this migration has none of these figures at all. A NOT
 * NULL here would either refuse those rows or force a backfill of numbers
 * nobody measured.
 *
 * No CHECK constraints, deliberately. `chk_reconciliation_runs_difference`
 * exists because `difference` is a stored subtraction of two columns in the
 * same row; none of these five is a function of the others — `escrow_total` is
 * a sum over accounts the row does not name, and `earnings_payable` is folded
 * from the journal — so there is no identity for Postgres to hold.
 */
export class EscrowReconciliationColumns1759100000001 implements MigrationInterface {
  name = 'EscrowReconciliationColumns1759100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reconciliation_runs"
        ADD COLUMN "escrow_total"              numeric(78,0) NULL,
        ADD COLUMN "escrow_accounts"           integer       NULL,
        ADD COLUMN "escrow_shortfall_accounts" integer       NULL,
        ADD COLUMN "earnings_vault_balance"    numeric(78,0) NULL,
        ADD COLUMN "earnings_payable"          numeric(78,0) NULL
    `);

    await queryRunner.query(
      `COMMENT ON COLUMN "reconciliation_runs"."escrow_total" IS ` +
        `'Sum of every buyer escrow ATA balance read this run.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "reconciliation_runs"."escrow_accounts" IS ` +
        `'How many escrows were read. Distinguishes a zero total from an empty read.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "reconciliation_runs"."escrow_shortfall_accounts" IS ` +
        `'Escrows holding less than the open holds against them. Non-zero is a breach.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "reconciliation_runs"."earnings_vault_balance" IS ` +
        `'What the chain says the single ["earnings_vault"] token account holds.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "reconciliation_runs"."earnings_payable" IS ` +
        `'Sum PROVIDER_CREDIT minus sum PAYOUT — what that vault must cover.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reconciliation_runs"
        DROP COLUMN IF EXISTS "escrow_total",
        DROP COLUMN IF EXISTS "escrow_accounts",
        DROP COLUMN IF EXISTS "escrow_shortfall_accounts",
        DROP COLUMN IF EXISTS "earnings_vault_balance",
        DROP COLUMN IF EXISTS "earnings_payable"
    `);
  }
}
