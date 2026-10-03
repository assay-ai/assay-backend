import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where the platform's share of a penalty is recorded.
 *
 * `slash` splits a penalty three ways in one instruction. Two of the three
 * already had a home — `penalty_amount` is what was asked for and
 * `applied_amount` is what the chain took — and the platform's own share had
 * nowhere to go.
 *
 * It deliberately does **not** become a ledger entry. It is paid to
 * `economics.treasury`, which is not the vault, and `ReconciliationService`
 * compares the vault balance against total ledger liabilities: a booked
 * platform share would add a liability no vault balance covers and trip proof
 * of reserves on the very next run. So it is recorded on the case it belongs
 * to, where an operator reconciling a penalty by hand can find it.
 *
 * Nullable, because every row written before this executed without recording
 * it and backfilling would mean inventing a number from a rate that is
 * per-provider and may have moved since.
 */
export class SlashPlatformAmount1758000000001 implements MigrationInterface {
  name = 'SlashPlatformAmount1758000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
      ADD COLUMN "platform_amount" numeric(78,0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "slash_proposals" DROP COLUMN "platform_amount"`);
  }
}
