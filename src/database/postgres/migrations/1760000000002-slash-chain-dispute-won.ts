import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `slash_proposals.chain_dispute_won_at` (follow-up B7): when the provider
 * WON an on-chain dispute of the case — a record cancelled while it stood
 * `DISPUTED` (the arbiter's `cancelSlash`) or expired as `DisputeUnresolved`.
 * A case with it set is never proposed again under a new request id, and no
 * new case may be opened over the same window's calls.
 */
export class SlashChainDisputeWon1760000000002 implements MigrationInterface {
  name = 'SlashChainDisputeWon1760000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD COLUMN "chain_dispute_won_at" timestamptz`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_dispute_won_window"
        ON "slash_proposals" ("window_id")
        WHERE "chain_dispute_won_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposals_dispute_won_window"`);
    await queryRunner.query(`ALTER TABLE "slash_proposals" DROP COLUMN "chain_dispute_won_at"`);
  }
}
