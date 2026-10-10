import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One open SLA window per (binding, settlement asset), not per binding.
 *
 * ## What was wrong
 *
 * `uq_sla_windows_open` allowed one OPEN window per binding, and the posting
 * path reused it by binding alone. A binding that moved from one settlement
 * asset to another (Solana USDC to USDG on an EVM chain) kept pouring calls
 * into the window opened in the old asset: `total_call_amount` summed two
 * currencies, and a breach would have computed and denominated its penalty in
 * the window's `asset_id`, the wrong one.
 *
 * ## Why per asset rather than closing the window on a switch
 *
 * Closing the open window when the asset changes would judge it early, almost
 * always as INSUFFICIENT_SAMPLE, which lets a provider reset a failing sample by
 * flipping assets. Keeping one window per asset leaves the old window to the age
 * sweep, and switching back resumes it.
 *
 * Existing rows are not touched: a window that already mixed assets before this
 * migration keeps its counters.
 */
export class SlaWindowsOpenPerAsset1759400000003 implements MigrationInterface {
  name = 'SlaWindowsOpenPerAsset1759400000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_sla_windows_open"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sla_windows_open" ` +
        `ON "sla_windows" ("binding_id", "asset_id") WHERE "status" = 'OPEN'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fails while a binding has open windows in two assets; close one first.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_sla_windows_open"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sla_windows_open" ` +
        `ON "sla_windows" ("binding_id") WHERE "status" = 'OPEN'`,
    );
  }
}
