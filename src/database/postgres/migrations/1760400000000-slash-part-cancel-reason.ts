import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `slash_proposal_parts.cancel_reason` (review N-4): the chain's
 * `SlashCancelled.reason` for a cancelled part (`WITHDRAWN`, `EXPIRED`,
 * `VERIFIER_UNAVAILABLE`, `DISPUTE_UNRESOLVED`). The provider's case screen
 * tells an arbiter's cancel from an undisputed record that lapsed by it,
 * instead of inferring it from timings. Null for older rows and for a part
 * not cancelled.
 */
export class SlashPartCancelReason1760400000000 implements MigrationInterface {
  name = 'SlashPartCancelReason1760400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "slash_proposal_parts" ADD COLUMN "cancel_reason" varchar(32)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "slash_proposal_parts" DROP COLUMN "cancel_reason"`);
  }
}
