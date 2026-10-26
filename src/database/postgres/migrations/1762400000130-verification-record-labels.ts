import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A human label on a trial (SHADOW) verdict: was the policy right or wrong
 * about this call? The promotion gate counts these (labelled samples, false
 * positives) from the table, so the numbers are measured, never typed in.
 *
 * - `label` is `POLICY_RIGHT` or `POLICY_WRONG`;
 * - `label`, `labelled_by` and `labelled_at` are set together or not at all,
 *   and a note only rides with a label;
 * - only a trial verdict carries one: a live verdict's label would count
 *   towards nothing and read as if it had;
 * - the evidence counts read trial records of one policy version, so they get
 *   a partial index of their own.
 */
export class VerificationRecordLabels1762400000130 implements MigrationInterface {
  name = 'VerificationRecordLabels1762400000130';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "verification_records"
        ADD COLUMN IF NOT EXISTS "label" character varying(16) NULL,
        ADD COLUMN IF NOT EXISTS "labelled_by" character varying(128) NULL,
        ADD COLUMN IF NOT EXISTS "labelled_at" TIMESTAMP WITH TIME ZONE NULL,
        ADD COLUMN IF NOT EXISTS "label_note" character varying(500) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "verification_records"
        ADD CONSTRAINT "chk_verification_records_label" CHECK (
          "label" IS NULL OR "label" IN ('POLICY_RIGHT', 'POLICY_WRONG')
        ),
        ADD CONSTRAINT "chk_verification_records_label_is_whole" CHECK (
          ("label" IS NULL AND "labelled_by" IS NULL AND "labelled_at" IS NULL
             AND "label_note" IS NULL)
          OR ("label" IS NOT NULL AND "labelled_by" IS NOT NULL AND "labelled_at" IS NOT NULL)
        ),
        ADD CONSTRAINT "chk_verification_records_label_shadow_only" CHECK (
          "label" IS NULL OR "lifecycle" = 'SHADOW'
        )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_verification_records_shadow_policy" ` +
        `ON "verification_records" ("decision_policy_id", "decision_policy_version") ` +
        `WHERE "lifecycle" = 'SHADOW'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_verification_records_shadow_policy"`);
    await queryRunner.query(`
      ALTER TABLE "verification_records"
        DROP CONSTRAINT IF EXISTS "chk_verification_records_label_shadow_only",
        DROP CONSTRAINT IF EXISTS "chk_verification_records_label_is_whole",
        DROP CONSTRAINT IF EXISTS "chk_verification_records_label",
        DROP COLUMN IF EXISTS "label_note",
        DROP COLUMN IF EXISTS "labelled_at",
        DROP COLUMN IF EXISTS "labelled_by",
        DROP COLUMN IF EXISTS "label"
    `);
  }
}
