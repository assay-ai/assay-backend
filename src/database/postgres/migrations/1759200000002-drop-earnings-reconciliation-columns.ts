import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lean v3 — the earnings vault is gone, and so are the two columns that
 * measured it.
 *
 * `redeem_voucher` now pays the provider's own associated token account and the
 * treasury's directly, so there is no pooled `["earnings_vault"]` account to
 * hold anybody's money and no `ProviderEarnings` balance to owe against it.
 * Reconciliation Check 6 (`earnings_vault_shortfall`) went with it.
 *
 * The columns are **dropped rather than left nullable and unwritten.** A column
 * that stops being written looks exactly like a column whose writer is broken:
 * every new row would carry `NULL` in a figure that used to be a number, and
 * the next person reading an incident's `reconciliation_runs` row would spend
 * their first hour deciding whether the reconciler had lost the ability to read
 * the chain. Historical rows lose two figures about an account that no longer
 * exists, which is the smaller loss by a wide margin.
 *
 * `down()` restores them as nullable columns with their original comments. It
 * cannot restore the values — the rows that had them are gone by then — which
 * is honest: this migration is not reversible in the sense of getting the data
 * back, only in the sense of getting the shape back.
 */
export class DropEarningsReconciliationColumns1759200000002 implements MigrationInterface {
  name = 'DropEarningsReconciliationColumns1759200000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reconciliation_runs"
        DROP COLUMN IF EXISTS "earnings_vault_balance",
        DROP COLUMN IF EXISTS "earnings_payable"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reconciliation_runs"
        ADD COLUMN IF NOT EXISTS "earnings_vault_balance" numeric(78,0) NULL,
        ADD COLUMN IF NOT EXISTS "earnings_payable"       numeric(78,0) NULL
    `);
    await queryRunner.query(
      `COMMENT ON COLUMN "reconciliation_runs"."earnings_vault_balance" IS ` +
        `'What the chain says the single ["earnings_vault"] token account holds.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "reconciliation_runs"."earnings_payable" IS ` +
        `'Sum PROVIDER_CREDIT minus sum PAYOUT — what that vault must cover.'`,
    );
  }
}
