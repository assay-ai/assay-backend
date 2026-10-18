import { MigrationInterface, QueryRunner } from 'typeorm';

/** The decision on a buyer's dispute over this verdict's call (G3.B1). */
export class VerificationRecordDisputeOutcome1761800000001 implements MigrationInterface {
  name = 'VerificationRecordDisputeOutcome1761800000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "verification_records"
        ADD COLUMN "dispute_outcome" character varying(16) NULL,
        ADD CONSTRAINT "chk_verification_records_dispute_outcome" CHECK (
          "dispute_outcome" IS NULL OR "dispute_outcome" IN ('OPEN', 'UPHELD', 'REJECTED')
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "verification_records"
        DROP CONSTRAINT "chk_verification_records_dispute_outcome",
        DROP COLUMN "dispute_outcome"
    `);
  }
}
