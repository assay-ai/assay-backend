import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the `slash_proposals` columns and resolution kinds nothing writes.
 *
 * A case is disputed on chain and ruled by the arbiter on chain, so no
 * operator decides one any more:
 *
 * - `outcome`: the adjudicator's judgement on the case. The dispute row keeps
 *   its own `disputes.outcome` (`recordPartialChainWin` writes
 *   `UPHELD_RECALCULATED` there).
 * - `decided_by_operator_id`: the adjudicator who decided it.
 * - `root_cause_key`: the key cases were grouped by to be decided once.
 * - `resolution_kind` `ADJUDICATOR` and `AUTO_PLATFORM_MISS`: an operator's
 *   decision, and the platform missing its own deadline to make one. The
 *   kinds stay on `disputes`, where call disputes write them. A case left
 *   with either (local and testnet databases only) keeps its closure under
 *   the nearest kind that remains: `ADJUDICATOR` becomes `CHAIN_ARBITER` (a
 *   person ruled) and `AUTO_PLATFORM_MISS` becomes `AUTO_CHAIN_VOIDED`
 *   (closed automatically, nobody ruled).
 *
 * `down` puts the columns back empty, with the constraints, the foreign key,
 * the index and the kind list the earlier migrations created. Rows rewritten
 * by `up` stay as they are.
 */
export class DropUnwrittenSlashColumns1762400000003 implements MigrationInterface {
  name = 'DropUnwrittenSlashColumns1762400000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `DROP CONSTRAINT "chk_slash_proposals_outcome_needs_adjudicator", ` +
        `DROP CONSTRAINT "chk_slash_proposals_adjudicator_is_named", ` +
        `DROP CONSTRAINT "chk_slash_proposals_outcome", ` +
        `DROP CONSTRAINT "chk_slash_proposals_resolution_kind", ` +
        `DROP CONSTRAINT "fk_slash_proposals_decided_by"`,
    );
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "resolution_kind" = 'CHAIN_ARBITER' ` +
        `WHERE "resolution_kind" = 'ADJUDICATOR'`,
    );
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "resolution_kind" = 'AUTO_CHAIN_VOIDED' ` +
        `WHERE "resolution_kind" = 'AUTO_PLATFORM_MISS'`,
    );
    await queryRunner.query(`DROP INDEX "idx_slash_proposals_root_cause"`);
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `DROP COLUMN "outcome", ` +
        `DROP COLUMN "decided_by_operator_id", ` +
        `DROP COLUMN "root_cause_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'AUTO_UNDISPUTED', 'AUTO_DE_MINIMIS', 'AUTO_CHAIN_VOIDED', 'CHAIN_ARBITER'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_resolution_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `ADD COLUMN "outcome" varchar(40), ` +
        `ADD COLUMN "decided_by_operator_id" uuid, ` +
        `ADD COLUMN "root_cause_key" varchar(128)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_slash_proposals_root_cause" ON "slash_proposals" ("root_cause_key") ` +
        `WHERE "root_cause_key" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `ADD CONSTRAINT "chk_slash_proposals_resolution_kind" CHECK (` +
        `"resolution_kind" IS NULL OR "resolution_kind" IN (` +
        `'ADJUDICATOR', 'AUTO_UNDISPUTED', 'AUTO_PLATFORM_MISS', 'AUTO_DE_MINIMIS', ` +
        `'AUTO_CHAIN_VOIDED', 'CHAIN_ARBITER')), ` +
        `ADD CONSTRAINT "chk_slash_proposals_outcome" CHECK (` +
        `"outcome" IS NULL OR "outcome" IN ('UPHELD', 'UPHELD_RECALCULATED')), ` +
        `ADD CONSTRAINT "chk_slash_proposals_outcome_needs_adjudicator" CHECK (` +
        `("outcome" IS NULL AND "resolution_kind" IS DISTINCT FROM 'ADJUDICATOR') ` +
        `OR ("outcome" IS NOT NULL AND "resolution_kind" IS NOT DISTINCT FROM 'ADJUDICATOR') ` +
        `OR ("outcome" IN ('UPHELD', 'UPHELD_RECALCULATED') ` +
        `AND "resolution_kind" IS NOT DISTINCT FROM 'AUTO_CHAIN_VOIDED')), ` +
        `ADD CONSTRAINT "chk_slash_proposals_adjudicator_is_named" CHECK (` +
        `"resolution_kind" <> 'ADJUDICATOR' OR "decided_by_operator_id" IS NOT NULL), ` +
        `ADD CONSTRAINT "fk_slash_proposals_decided_by" ` +
        `FOREIGN KEY ("decided_by_operator_id") REFERENCES "operators" ("id") ` +
        `ON DELETE RESTRICT`,
    );
  }
}
