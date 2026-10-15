import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `slash_proposals.agent_amount` (review R3-2): the harmed agents' share of a
 * part-based EVM case already accounted by a late-part refold
 * (`SlashExecutionService.refoldLatePart`), so the next refold reports only
 * what it adds. Null until a refold writes it; the first refold derives it
 * from the parts executed by the time the case closed.
 */
export class SlashProposalAgentAmount1760500000000 implements MigrationInterface {
  name = 'SlashProposalAgentAmount1760500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD COLUMN "agent_amount" numeric(78,0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "slash_proposals" DROP COLUMN "agent_amount"`);
  }
}
