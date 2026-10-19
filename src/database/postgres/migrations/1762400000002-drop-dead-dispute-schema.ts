import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the schema the off-chain slash objection left behind.
 *
 * A case is disputed on chain and the arbiter is a person ruling on chain, so
 * nothing writes these any more:
 *
 * - `slash_proposals.status = 'OVERTURNED'` and the four `OVERTURNED_*`
 *   outcomes (on `slash_proposals` and `disputes`): the operator's overturn.
 *   A row left with either (local and testnet databases only) keeps its
 *   closure without the removed vocabulary: `OVERTURNED` becomes `CANCELLED`,
 *   and an `OVERTURNED_*` outcome is cleared — on a case together with the
 *   `ADJUDICATOR` resolution that requires one.
 * - `slash_proposals.seconded_by_operator_id`, `seconded_at`, `second_kind`:
 *   the second signature on an operator's decision. The ones on `disputes`
 *   stay; call disputes still write them.
 * - `fleet_sweeps` and `slash_proposals.sweep_id`: the overturn applied to
 *   every binding a platform defect touched.
 * - `slash_proposals.verdict_id` and `source = 'DATA_FAIL'`: a case opened
 *   from one failed call. Nothing ever opened one; every case comes from an
 *   SLA strike.
 *
 * `down` puts the columns and the table back empty, with the constraints,
 * indexes and lists the earlier migrations created. Rows rewritten by `up`
 * stay as they are.
 */
export class DropDeadDisputeSchema1762400000002 implements MigrationInterface {
  name = 'DropDeadDisputeSchema1762400000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── overturns ──────────────────────────────────────────────────────────
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "outcome" = NULL, "resolution_kind" = NULL, ` +
        `"resolved_at" = NULL WHERE "outcome" LIKE 'OVERTURNED\\_%'`,
    );
    await queryRunner.query(
      `UPDATE "slash_proposals" SET "status" = 'CANCELLED' WHERE "status" = 'OVERTURNED'`,
    );
    await queryRunner.query(
      `UPDATE "disputes" SET "outcome" = NULL WHERE "outcome" LIKE 'OVERTURNED\\_%'`,
    );

    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_status" CHECK ("status" IN (
        'PROPOSED', 'DISPUTED', 'UPHELD', 'EXECUTING', 'EXECUTED', 'REVERSED', 'WAIVED',
        'CANCELLED'
      ))
    `);
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_outcome"`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_outcome" CHECK (` +
        `"outcome" IS NULL OR "outcome" IN ('UPHELD', 'UPHELD_RECALCULATED'))`,
    );
    await queryRunner.query(`ALTER TABLE "disputes" DROP CONSTRAINT "chk_disputes_outcome"`);
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_outcome" CHECK (` +
        `"outcome" IS NULL OR "outcome" IN ('UPHELD', 'UPHELD_RECALCULATED'))`,
    );

    // ── the second signature ───────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `DROP CONSTRAINT "chk_slash_proposals_second_kind", ` +
        `DROP CONSTRAINT "chk_slash_proposals_second_is_a_different_person", ` +
        `DROP CONSTRAINT "chk_slash_proposals_second_is_whole", ` +
        `DROP CONSTRAINT "fk_slash_proposals_seconded_by", ` +
        `DROP COLUMN "seconded_by_operator_id", ` +
        `DROP COLUMN "seconded_at", ` +
        `DROP COLUMN "second_kind"`,
    );

    // ── fleet sweeps ───────────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT "fk_slash_proposals_sweep", ` +
        `DROP COLUMN "sweep_id"`,
    );
    await queryRunner.query(`DROP TABLE "fleet_sweeps"`);

    // ── DATA_FAIL cases ────────────────────────────────────────────────────
    await queryRunner.query(`DROP INDEX "uq_slash_proposals_verdict"`);
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `DROP CONSTRAINT "chk_slash_proposals_origin_matches_source", ` +
        `DROP CONSTRAINT "chk_slash_proposals_source", ` +
        `DROP CONSTRAINT "fk_slash_proposals_verdict", ` +
        `DROP COLUMN "verdict_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_source" ` +
        `CHECK ("source" = 'SLA_STRIKE')`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_origin_matches_source" ` +
        `CHECK ("strike_id" IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── DATA_FAIL cases ────────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `DROP CONSTRAINT "chk_slash_proposals_origin_matches_source", ` +
        `DROP CONSTRAINT "chk_slash_proposals_source", ` +
        `ADD COLUMN "verdict_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `ADD CONSTRAINT "chk_slash_proposals_source" ` +
        `CHECK ("source" IN ('SLA_STRIKE', 'DATA_FAIL')), ` +
        `ADD CONSTRAINT "chk_slash_proposals_origin_matches_source" CHECK (` +
        `("source" = 'SLA_STRIKE' AND "strike_id" IS NOT NULL AND "verdict_id" IS NULL) OR ` +
        `("source" = 'DATA_FAIL' AND "verdict_id" IS NOT NULL AND "strike_id" IS NULL)), ` +
        `ADD CONSTRAINT "fk_slash_proposals_verdict" FOREIGN KEY ("verdict_id") ` +
        `REFERENCES "verification_records" ("id") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_slash_proposals_verdict" ON "slash_proposals" ("verdict_id") ` +
        `WHERE "verdict_id" IS NOT NULL`,
    );

    // ── fleet sweeps ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "fleet_sweeps" (
        "id"                    uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"            timestamptz   NOT NULL DEFAULT now(),
        "updated_at"            timestamptz   NOT NULL DEFAULT now(),
        "version"               integer       NOT NULL DEFAULT 1,
        "opened_by_operator_id" uuid          NOT NULL,
        "source_proposal_id"    uuid          NOT NULL,
        "outcome"               varchar(40)   NOT NULL,
        "defect_key"            varchar(128)  NOT NULL,
        "window_from"           timestamptz   NOT NULL,
        "window_to"             timestamptz   NOT NULL,
        "status"                varchar(16)   NOT NULL DEFAULT 'OPEN',
        "matched_count"         integer       NOT NULL DEFAULT 0,
        "applied_count"         integer       NOT NULL DEFAULT 0,
        "completed_at"          timestamptz,
        CONSTRAINT "pk_fleet_sweeps" PRIMARY KEY ("id"),
        CONSTRAINT "chk_fleet_sweeps_status" CHECK ("status" IN ('OPEN', 'COMPLETED', 'FAILED')),
        CONSTRAINT "chk_fleet_sweeps_outcome" CHECK (
          "outcome" IN ('OVERTURNED_PLATFORM_DEFECT', 'OVERTURNED_POLICY_DEFECT')
        ),
        CONSTRAINT "chk_fleet_sweeps_window_ordered" CHECK ("window_from" < "window_to"),
        CONSTRAINT "chk_fleet_sweeps_counts" CHECK (
          "matched_count" >= 0 AND "applied_count" >= 0 AND "applied_count" <= "matched_count"
        ),
        CONSTRAINT "chk_fleet_sweeps_completion_is_whole"
          CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)),
        CONSTRAINT "fk_fleet_sweeps_opened_by"
          FOREIGN KEY ("opened_by_operator_id") REFERENCES "operators" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_fleet_sweeps_source_proposal"
          FOREIGN KEY ("source_proposal_id") REFERENCES "slash_proposals" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_fleet_sweeps_status" ON "fleet_sweeps" ("status", "created_at" DESC)`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD COLUMN "sweep_id" uuid, ` +
        `ADD CONSTRAINT "fk_slash_proposals_sweep" ` +
        `FOREIGN KEY ("sweep_id") REFERENCES "fleet_sweeps" ("id") ON DELETE SET NULL`,
    );

    // ── the second signature ───────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `ADD COLUMN "seconded_by_operator_id" uuid, ` +
        `ADD COLUMN "seconded_at" timestamptz, ` +
        `ADD COLUMN "second_kind" varchar(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ` +
        `ADD CONSTRAINT "chk_slash_proposals_second_kind" CHECK (` +
        `"second_kind" IS NULL OR "second_kind" IN ('SIGNED', 'OBJECTED')), ` +
        `ADD CONSTRAINT "chk_slash_proposals_second_is_a_different_person" CHECK (` +
        `"seconded_by_operator_id" IS NULL ` +
        `OR "seconded_by_operator_id" <> "decided_by_operator_id"), ` +
        `ADD CONSTRAINT "chk_slash_proposals_second_is_whole" CHECK (` +
        `("seconded_at" IS NULL) = ("seconded_by_operator_id" IS NULL) ` +
        `AND ("seconded_at" IS NULL) = ("second_kind" IS NULL)), ` +
        `ADD CONSTRAINT "fk_slash_proposals_seconded_by" ` +
        `FOREIGN KEY ("seconded_by_operator_id") REFERENCES "operators" ("id") ` +
        `ON DELETE RESTRICT`,
    );

    // ── overturns ──────────────────────────────────────────────────────────
    const outcomes =
      `'UPHELD', 'UPHELD_RECALCULATED', 'OVERTURNED_PLATFORM_DEFECT', ` +
      `'OVERTURNED_POLICY_DEFECT', 'OVERTURNED_GRIEFING', 'OVERTURNED_INSUFFICIENT_EVIDENCE'`;
    await queryRunner.query(`ALTER TABLE "disputes" DROP CONSTRAINT "chk_disputes_outcome"`);
    await queryRunner.query(
      `ALTER TABLE "disputes" ADD CONSTRAINT "chk_disputes_outcome" CHECK (` +
        `"outcome" IS NULL OR "outcome" IN (${outcomes}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" DROP CONSTRAINT "chk_slash_proposals_outcome"`,
    );
    await queryRunner.query(
      `ALTER TABLE "slash_proposals" ADD CONSTRAINT "chk_slash_proposals_outcome" CHECK (` +
        `"outcome" IS NULL OR "outcome" IN (${outcomes}))`,
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
  }
}
