import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `operator_approvals.result`: what an approved action did, kept with the
 * approval (review 2026-10-30 I-3).
 *
 * The approve response is the only place a bulk buyer-debt void reported which
 * debts it voided and which it skipped, and why; a console that lost the
 * response (a closed tab, a dropped connection) could not get it back. The
 * action writes it here once its loop ends, partial or not. Nullable: every
 * existing row, and every action that records nothing, stays `NULL`.
 */
export class OperatorApprovalResult1793318400010 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "operator_approvals" ADD COLUMN IF NOT EXISTS "result" jsonb NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "operator_approvals" DROP COLUMN IF EXISTS "result"`);
  }
}
