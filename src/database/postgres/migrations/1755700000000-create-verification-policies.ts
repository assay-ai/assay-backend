import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Versioned verification policies, and the promote gate in the schema.
 *
 * Hand-written, like every migration in this directory, because the three
 * things that make this table safe cannot be expressed as entity decorators and
 * a generated migration would omit all three silently:
 *
 * 1. **`chk_verification_policies_active_is_promoted`.** A row may not be
 *    `ACTIVE` without a promotion record. Shadow mode is *"mandatory, not
 *    advisory"*; a rule enforced only in a service is advisory by construction,
 *    because the next service — the console, a backfill script, a psql session
 *    during an incident — is a different piece of code that has to remember it.
 *    This one is remembered by Postgres.
 * 2. **`uq_verification_policies_one_active_per_tool`.** A partial unique index
 *    over `tool_id WHERE lifecycle = 'ACTIVE'`. "One policy per tool, versioned"
 *    is a claim about which policy decides a call, and two active versions make
 *    that claim ambiguous — the resolver would pick one by `ORDER BY`, which is
 *    a coin flip deciding who gets slashed.
 * 3. **`chk_verification_policies_withdrawal_is_whole`.** A withdrawal with no
 *    reason and no actor is an incident record that explains nothing.
 *
 * The kill switch itself is deliberately *not* in this table. It lives in Redis
 * — see `services/redis-policy-kill-switch.service.ts` — because its whole
 * requirement is to take effect in seconds across every process without a
 * deploy, and a Postgres row read once per call is a different latency and
 * availability profile than the one that requirement implies. The lifecycle
 * column here is the durable record of a withdrawal; Redis is the live one.
 */
export class CreateVerificationPolicies1755700000000 implements MigrationInterface {
  name = 'CreateVerificationPolicies1755700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "verification_policies" (
        "id"                     uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"             TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at"             TIMESTAMP     NOT NULL DEFAULT now(),
        "version"                integer       NOT NULL DEFAULT 1,
        "policy_id"              character varying(128) NOT NULL,
        "policy_version"         integer       NOT NULL,
        "tool_id"                uuid          NOT NULL,
        "lifecycle"              character varying(16)  NOT NULL,
        "decision_document"      jsonb         NOT NULL,
        "verification_document"  jsonb         NULL,
        "created_by"             character varying(128) NOT NULL,
        "promoted_at"            TIMESTAMP WITH TIME ZONE NULL,
        "promoted_by"            character varying(128) NULL,
        "promotion_evidence"     jsonb         NULL,
        "withdrawn_at"           TIMESTAMP WITH TIME ZONE NULL,
        "withdrawn_by"           character varying(128) NULL,
        "withdrawn_reason"       character varying(512) NULL,
        CONSTRAINT "pk_verification_policies" PRIMARY KEY ("id"),
        CONSTRAINT "chk_verification_policies_lifecycle" CHECK ("lifecycle" IN (
          'DRAFT', 'SHADOW', 'ACTIVE', 'WITHDRAWN', 'ARCHIVED'
        )),
        CONSTRAINT "chk_verification_policies_version_positive" CHECK ("policy_version" >= 1),
        -- The promote gate, in the one layer no application code can route
        -- around. A policy that has not been promoted cannot be enforcing, no
        -- matter which service or which psql session writes the row.
        CONSTRAINT "chk_verification_policies_active_is_promoted" CHECK (
          "lifecycle" <> 'ACTIVE'
          OR ("promoted_at" IS NOT NULL
              AND "promoted_by" IS NOT NULL
              AND "promotion_evidence" IS NOT NULL)
        ),
        -- Half a withdrawal record is not a withdrawal record.
        CONSTRAINT "chk_verification_policies_withdrawal_is_whole" CHECK (
          ("withdrawn_at" IS NULL) = ("withdrawn_by" IS NULL)
          AND ("withdrawn_at" IS NULL) = ("withdrawn_reason" IS NULL)
        ),
        -- WITHDRAWN is reached only through the withdrawal path.
        CONSTRAINT "chk_verification_policies_withdrawn_has_record" CHECK (
          "lifecycle" <> 'WITHDRAWN' OR "withdrawn_at" IS NOT NULL
        )
      )
    `);

    // A version is immutable and identified by (policy, version). Two rows
    // claiming to be `search_web.default v3` make every verdict that names v3
    // unreplayable, which is the one property the whole table exists for.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_verification_policies_id_version" ON "verification_policies" ` +
        `("policy_id", "policy_version")`,
    );

    // At most one enforcing policy per tool. See the class doc.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_verification_policies_one_active_per_tool" ON "verification_policies" ` +
        `("tool_id") WHERE "lifecycle" = 'ACTIVE'`,
    );

    // Likewise for shadow: two shadowing versions of the same tool would both
    // produce verdicts for the same call, and the false-positive rate the
    // promote gate reads would then belong to neither of them.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_verification_policies_one_shadow_per_tool" ON "verification_policies" ` +
        `("tool_id") WHERE "lifecycle" = 'SHADOW'`,
    );

    // The resolver's read on every verified call: "the serving policy for this
    // tool", which is one `ACTIVE` or one `SHADOW` row.
    await queryRunner.query(
      `CREATE INDEX "idx_verification_policies_tool_lifecycle" ON "verification_policies" ` +
        `("tool_id", "lifecycle")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "verification_policies"`);
  }
}
