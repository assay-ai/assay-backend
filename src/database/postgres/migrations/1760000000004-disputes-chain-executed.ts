import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `disputes.resolution_kind` may be `AUTO_CHAIN_EXECUTED`: the case's record
 * was executed on chain (by anybody: `executeSlash` is permissionless) while
 * the in-app objection was still open, and the objection closes as an upheld
 * decision would close it (BUG-R13-D-03).
 */
export class DisputesChainExecuted1760000000004 implements MigrationInterface {
  name = 'DisputesChainExecuted1760000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "chk_disputes_resolution_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'ADJUDICATOR', 'AUTO_PLATFORM_MISS', 'AUTO_CHAIN_EXECUTED'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "disputes" SET "resolution_kind" = NULL, "resolved_at" = NULL ` +
        `WHERE "resolution_kind" = 'AUTO_CHAIN_EXECUTED'`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "chk_disputes_resolution_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN ('ADJUDICATOR', 'AUTO_PLATFORM_MISS'))`,
    );
  }
}
