import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The dispute upgrade (assay-evm D-19): a slash record can be `Disputed` on
 * chain.
 *
 * The provider's `disputeSlash` freezes a `Pending` record — `executeSlash`
 * refuses it — until the arbiter's `upholdSlash` returns it to `Pending`
 * (executable from that moment) or a `cancelSlash` / `expireSlash` ends it. So
 * `DISPUTED` is a distinct `chain_status`, on the case and on each per-agent
 * part, for the same reason `CANCEL_REQUESTED` is: `findChainExecutable`
 * selects `chain_status = 'PENDING'`, and a disputed record falls out of the
 * execute sweep by construction.
 *
 * `chain_disputed_at` is the chain's `disputedAt`. It is what the expiry rule
 * reads: a `Disputed` record becomes `expireSlash`-able at
 * `disputedAt + 30 d` (`DisputeUnresolved`), not on the seven-day grace after
 * `executable_at`. Kept after an uphold, as the record of the dispute.
 *
 * `chk_*_pending_is_whole` / `landed_is_whole` are not extended: a disputed
 * record was `PENDING` a moment earlier and carries both chain clocks already.
 */
export class SlashChainDisputes1759900000000 implements MigrationInterface {
  name = 'SlashChainDisputes1759900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT IF EXISTS "chk_slash_proposals_chain_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_chain_status" CHECK ("chain_status" IN (
          'NONE', 'PROPOSING', 'PENDING', 'CANCEL_REQUESTED', 'DISPUTED', 'EXECUTED', 'CANCELLED',
          'REFUSED'
        ))
    `);
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD COLUMN "chain_disputed_at" timestamptz`,
    );

    await queryRunner.query(`
      ALTER TABLE "slash_proposal_parts"
        DROP CONSTRAINT IF EXISTS "chk_slash_proposal_parts_chain_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposal_parts"
        ADD CONSTRAINT "chk_slash_proposal_parts_chain_status" CHECK (
          "chain_status" IN ('NONE', 'PENDING', 'DISPUTED', 'EXECUTED', 'CANCELLED', 'REFUSED')
        )
    `);
    await queryRunner.query(
      `ALTER TABLE "slash_proposal_parts" ADD COLUMN "chain_disputed_at" timestamptz`,
    );

    // The dispute sweep reads exactly these rows every minute (the 30-day
    // expiry and the arbiter's queue); without the partial index it scans
    // every case ever written.
    await queryRunner.query(`
      CREATE INDEX "idx_slash_proposals_chain_disputed"
        ON "slash_proposals" ("chain_disputed_at")
        WHERE "chain_status" = 'DISPUTED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_slash_proposals_chain_disputed"`);
    // A disputed record is still a standing reservation; `PENDING` is the
    // honest pre-upgrade mirror of it (the execute sweep then hears
    // `SlashNotPending` and reads the record, which is what it did before).
    await queryRunner.query(
      `UPDATE "slash_proposal_parts" SET "chain_status" = 'PENDING' WHERE "chain_status" = 'DISPUTED'`,
    );
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "chain_status" = 'PENDING' WHERE "chain_status" = 'DISPUTED'`,
    );
    await queryRunner.query(`ALTER TABLE "slash_proposal_parts" DROP COLUMN "chain_disputed_at"`);
    await queryRunner.query(`
      ALTER TABLE "slash_proposal_parts"
        DROP CONSTRAINT IF EXISTS "chk_slash_proposal_parts_chain_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposal_parts"
        ADD CONSTRAINT "chk_slash_proposal_parts_chain_status" CHECK (
          "chain_status" IN ('NONE', 'PENDING', 'EXECUTED', 'CANCELLED', 'REFUSED')
        )
    `);
    await queryRunner.query(`ALTER TABLE "slash_proposals" DROP COLUMN "chain_disputed_at"`);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        DROP CONSTRAINT IF EXISTS "chk_slash_proposals_chain_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "slash_proposals"
        ADD CONSTRAINT "chk_slash_proposals_chain_status" CHECK ("chain_status" IN (
          'NONE', 'PROPOSING', 'PENDING', 'CANCEL_REQUESTED', 'EXECUTED', 'CANCELLED', 'REFUSED'
        ))
    `);
  }
}
