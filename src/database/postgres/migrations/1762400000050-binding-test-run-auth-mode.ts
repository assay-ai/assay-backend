import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `binding_test_runs.auth_mode`: the binding's auth mode when the tester ran.
 *
 * The auth mode changes the call (which credential headers, which signature
 * the endpoint receives), so a passing run vouches only for the mode it ran
 * with (BUG-PRV-CATALOG-02 review). Nullable: a run recorded before this
 * column counts, as before, only at its own revision.
 */
export class BindingTestRunAuthMode1762400000050 implements MigrationInterface {
  name = 'BindingTestRunAuthMode1762400000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "binding_test_runs" ADD COLUMN IF NOT EXISTS "auth_mode" varchar(16)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "binding_test_runs" DROP COLUMN IF EXISTS "auth_mode"`);
  }
}
