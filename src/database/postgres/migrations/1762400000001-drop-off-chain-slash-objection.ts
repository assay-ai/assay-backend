import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the schema of the off-chain slash objection.
 *
 * A case is disputed on chain (`disputeSlash`) and ruled by the arbiter, and
 * Solana opens no slash case at all, so nothing writes these any more:
 *
 * - `slash_proposals.respond_by_at`: the provider's in-app window to object,
 *   started on delivery. The on-chain record's `executableAt` is the only
 *   deadline now.
 * - `slash_proposals.platform_decision_due_at`: the platform's own deadline to
 *   decide an objection, and the adjudication queue's order.
 * - `UNDER_REVIEW` and `AWAITING_SECOND`: an operator's claim and a decision
 *   waiting for its second signature. A row left in either (local and testnet
 *   databases only) goes back to `DISPUTED`, which the on-chain mirror then
 *   follows.
 *
 * The propose sweep's partial index was keyed on `respond_by_at`; it is
 * rebuilt on `proposed_at`, the column that sweep orders by.
 *
 * `down` puts the columns back empty, with the indexes and the status list
 * `1757700000000` and `1759000000000` created.
 */
export class DropOffChainSlashObjection1762400000001 implements MigrationInterface {
  name = 'DropOffChainSlashObjection1762400000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "status" = 'DISPUTED' ` +
        `WHERE "status" IN ('UNDER_REVIEW', 'AWAITING_SECOND')`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_status" CHECK ("status" IN (
        'PROPOSED', 'DISPUTED', 'UPHELD', 'OVERTURNED', 'EXECUTING', 'EXECUTED',
        'REVERSED', 'WAIVED', 'CANCELLED'
      ))
    `);

    await queryRunner.query(`DROP INDEX "idx_slash_proposals_queue"`);
    await queryRunner.query(`DROP INDEX "idx_slash_proposals_respond_by"`);
    await queryRunner.query(`DROP INDEX "idx_slash_proposals_awaiting_chain_proposal"`);
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP COLUMN "respond_by_at", ` +
        `DROP COLUMN "platform_decision_due_at"`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_awaiting_chain_proposal"
        ON "slash_proposals" ("proposed_at")
        WHERE "chain_status" IN ('NONE', 'PROPOSING')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_slash_proposals_awaiting_chain_proposal"`);
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD COLUMN "respond_by_at" timestamptz, ` +
        `ADD COLUMN "platform_decision_due_at" timestamptz`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_awaiting_chain_proposal"
        ON "slash_proposals" ("respond_by_at")
        WHERE "chain_status" IN ('NONE', 'PROPOSING')
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_respond_by" ON "slash_proposals" ("respond_by_at") ` +
        `WHERE "status" = 'PROPOSED'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_queue" ON "slash_proposals" ` +
        `("platform_decision_due_at" ASC, "penalty_amount" DESC) ` +
        `WHERE "status" IN ('DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND')`,
    );

    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_status" CHECK ("status" IN (
        'PROPOSED', 'DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND', 'UPHELD', 'OVERTURNED',
        'EXECUTING', 'EXECUTED', 'REVERSED', 'WAIVED', 'CANCELLED'
      ))
    `);
  }
}
