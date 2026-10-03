import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The verdict store, and the worker's durable inbox.
 *
 * Hand-written like every migration here, and for three reasons a generated one
 * would have dropped without saying so:
 *
 * 1. **`uq_verification_records_intent`.** One verdict per intent, enforced by
 *    the database. This is the outermost of the three guards that stop a
 *    crashed-and-restarted worker from committing a hold twice; the other two
 *    are the intent's compare-and-swap and the ledger's idempotent hold
 *    resolution. Any one of them is sufficient, which is the point — the money
 *    path does not rest on a single mechanism being remembered.
 * 2. **`chk_verification_records_judged_is_whole`.** A record that claims to be
 *    judged must carry the verdict *and* the policy version that produced it. A
 *    verdict with no policy version is not evidence: arbitration resolves a
 *    dispute by replaying the stored verifier results under the stored policy,
 *    and one without the other cannot be replayed at all.
 * 3. **`idx_verification_records_unsettled`.** A partial index over the records
 *    a restarted worker must find — `PENDING`, and `JUDGED` with no
 *    `settled_at`. It is partial because the interesting set is tiny and
 *    permanently so: a healthy platform has single-digit rows here and millions
 *    of settled ones, and a full index would be almost entirely dead weight on
 *    every insert.
 *
 * `state` is the worker's own progress, deliberately not the intent's status.
 * See the entity's class comment for the window where the two differ and why the
 * crash-resume path needs to tell them apart.
 */
export class CreateVerificationRecords1755800000000 implements MigrationInterface {
  name = 'CreateVerificationRecords1755800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "verification_records" (
        "id"                       uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"               TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at"               TIMESTAMP     NOT NULL DEFAULT now(),
        "version"                  integer       NOT NULL DEFAULT 1,
        "organization_id"          uuid          NOT NULL,

        "intent_id"                uuid          NOT NULL,
        "tool_id"                  uuid          NOT NULL,
        "provider_id"              uuid          NULL,
        "state"                    character varying(16)  NOT NULL,

        "request"                  jsonb         NULL,
        "response"                 jsonb         NULL,
        "output_schema"            jsonb         NULL,

        "verdict_status"           character varying(32)  NULL,
        "reason_code"              character varying(64)  NULL,
        "reason"                   character varying(512) NULL,
        "score"                    double precision       NULL,
        "cost_usd"                 double precision       NULL,
        "policy_id"                character varying(128) NULL,
        "policy_version"           integer       NULL,
        "decision_policy_id"       character varying(128) NULL,
        "decision_policy_version"  integer       NULL,
        "lifecycle"                character varying(16)  NULL,

        "sample_rate"              double precision       NULL,
        "sampled"                  boolean       NULL,
        "sample_selector"          double precision       NULL,
        "sample_display"           character varying(128) NULL,

        "stages"                   jsonb         NULL,
        "verifiers"                jsonb         NULL,
        "tally"                    jsonb         NULL,
        "decided_by"               jsonb         NULL,
        "evaluated_at"             TIMESTAMP WITH TIME ZONE NULL,

        "settlement_outcome"       character varying(16)  NULL,
        "settled_at"               TIMESTAMP WITH TIME ZONE NULL,
        "attempts"                 integer       NOT NULL DEFAULT 0,
        "last_error"               character varying(512) NULL,

        CONSTRAINT "pk_verification_records" PRIMARY KEY ("id"),
        CONSTRAINT "chk_verification_records_state" CHECK ("state" IN (
          'PENDING', 'JUDGED', 'SETTLED'
        )),
        CONSTRAINT "chk_verification_records_settlement_outcome" CHECK (
          "settlement_outcome" IS NULL
          OR "settlement_outcome" IN ('SETTLE', 'REFUND', 'VOID')
        ),
        -- A judged record carries its verdict and the policy version that
        -- produced it. Half of an evidence record is not evidence.
        CONSTRAINT "chk_verification_records_judged_is_whole" CHECK (
          "state" = 'PENDING'
          OR ("verdict_status" IS NOT NULL
              AND "decision_policy_id" IS NOT NULL
              AND "decision_policy_version" IS NOT NULL
              AND "evaluated_at" IS NOT NULL
              AND "stages" IS NOT NULL)
        ),
        -- SETTLED means the hold was resolved, and names when and to what.
        CONSTRAINT "chk_verification_records_settled_is_whole" CHECK (
          "state" <> 'SETTLED'
          OR ("settled_at" IS NOT NULL AND "settlement_outcome" IS NOT NULL)
        ),
        -- A sample rate is a probability. A stored 1.7 would silently mean
        -- "every call" and hide a unit bug in the deriving code.
        CONSTRAINT "chk_verification_records_sample_rate_range" CHECK (
          "sample_rate" IS NULL OR ("sample_rate" >= 0 AND "sample_rate" <= 1)
        ),
        CONSTRAINT "chk_verification_records_score_range" CHECK (
          "score" IS NULL OR ("score" >= 0 AND "score" <= 1)
        )
      )
    `);

    // One verdict per intent, forever. The outermost double-settlement guard.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_verification_records_intent" ON "verification_records" ` +
        `("intent_id")`,
    );

    // What a restarted worker sweeps for. Partial: the unfinished set is tiny
    // and stays tiny, while the finished set grows without bound.
    await queryRunner.query(
      `CREATE INDEX "idx_verification_records_unsettled" ON "verification_records" ` +
        `("created_at") WHERE "state" <> 'SETTLED'`,
    );

    // The receipt summary's grouping read: by tool, over a window.
    await queryRunner.query(
      `CREATE INDEX "idx_verification_records_tool" ON "verification_records" ` +
        `("organization_id", "tool_id", "created_at")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_verification_records_state" ON "verification_records" ` +
        `("state", "created_at")`,
    );

    // The tenant boundary, indexed like every other business table.
    await queryRunner.query(
      `CREATE INDEX "idx_verification_records_organization" ON "verification_records" ` +
        `("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "verification_records"`);
  }
}
