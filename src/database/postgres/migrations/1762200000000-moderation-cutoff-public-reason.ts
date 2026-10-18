import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a provider tool's own takedown tells its provider: a reason code from
 * a short closed list, and an optional note written for the provider. Kept
 * apart from `note`, which is the operator's and is never shown to them.
 * Null on every cutoff that is not a tool's takedown, and on older ones.
 */
export class ModerationCutoffPublicReason1762200000000 implements MigrationInterface {
  name = 'ModerationCutoffPublicReason1762200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "moderation_cutoffs"
        ADD COLUMN "public_reason_code" varchar(32),
        ADD COLUMN "public_note" varchar(500),
        ADD CONSTRAINT "chk_moderation_cutoffs_public_reason_code"
          CHECK ("public_reason_code" IS NULL OR "public_reason_code" IN (
            'IMPERSONATION', 'MODEL_INSTRUCTIONS', 'SECRET_COLLECTION', 'HARMFUL_OUTPUT',
            'LEGAL_REQUEST', 'POLICY_VIOLATION'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "moderation_cutoffs"
        DROP CONSTRAINT "chk_moderation_cutoffs_public_reason_code",
        DROP COLUMN "public_note",
        DROP COLUMN "public_reason_code"
    `);
  }
}
