import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The five tables the REST surface needs and the schema did not have.
 *
 * The buyer and provider screens the API is being built for read ten and nine
 * data groups respectively. Most were already backed by real tables — balances,
 * holds, withheld, calls, receipts, verdicts, reconciliation — or derivable
 * from them (provider traffic, quality, earnings, SLA position all fold out of
 * `payment_intents` joined to `verification_records`). Five had **nothing**:
 * spend limits, notifications, the audit log, agent credentials, and disputes.
 *
 * They are added here rather than stubbed at the endpoint, because an endpoint
 * that returns a plausible empty list for a screen with no storage behind it is
 * indistinguishable, to the frontend team building against it, from one that
 * works — and the divergence surfaces as a bug in their code, months later.
 *
 * Written by hand, like every migration here. Three constraints below carry
 * behaviour a generated migration would have dropped:
 *
 * 1. **`uq_spend_policies_live`** — a partial unique index on
 *    `(organization_id, agent_id)` where `superseded_at IS NULL`. "Exactly one
 *    live policy per scope" is the invariant the whole append-only versioning
 *    scheme rests on; enforced in a service instead, two concurrent limit
 *    changes both insert and the account quietly has two live caps, with the
 *    one that applies decided by row order.
 * 2. **`uq_agent_credentials_token`** — a token hash is unique platform-wide,
 *    *not* per organization. Scoping it per tenant would permit the same secret
 *    to authenticate in two organizations, which is the one collision that
 *    matters.
 * 3. **`chk_disputes_deadline_needs_ack`** — a deadline may only exist once the
 *    dispute was acknowledged. A clock the respondent never learned about is
 *    not due process; this makes that unrepresentable rather than merely
 *    discouraged.
 *
 * Timestamps are `timestamptz` throughout — see
 * `1755900000000-timestamptz-timestamps`, which converted the rest of the
 * schema in the same milestone precisely so these tables would not add a ninth
 * table to the old convention.
 */
export class CreateApiSurfaceTables1756000000000 implements MigrationInterface {
  name = 'CreateApiSurfaceTables1756000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ── spend_policies ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "spend_policies" (
        "id"                      uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"              timestamptz   NOT NULL DEFAULT now(),
        "updated_at"              timestamptz   NOT NULL DEFAULT now(),
        "version"                 integer       NOT NULL DEFAULT 1,
        "organization_id"         uuid          NOT NULL,

        "agent_id"                uuid          NULL,
        "policy_version"          integer       NOT NULL,
        "asset_id"                character varying(256) NOT NULL,
        "decimals"                integer       NOT NULL,

        "per_call_max"            numeric(78,0) NULL,
        "daily_cap"               numeric(78,0) NULL,
        "monthly_cap"             numeric(78,0) NULL,
        "max_calls_per_hour"      integer       NULL,
        "require_approval_above"  numeric(78,0) NULL,
        "paused"                  boolean       NOT NULL DEFAULT false,

        "changed_by"              character varying(128) NOT NULL,
        "change_reason"           character varying(512) NULL,
        "superseded_at"           timestamptz   NULL,

        CONSTRAINT "pk_spend_policies" PRIMARY KEY ("id"),
        CONSTRAINT "chk_spend_policies_amounts_non_negative" CHECK (
          COALESCE("per_call_max", 0) >= 0 AND
          COALESCE("daily_cap", 0) >= 0 AND
          COALESCE("monthly_cap", 0) >= 0 AND
          COALESCE("require_approval_above", 0) >= 0
        ),
        CONSTRAINT "chk_spend_policies_velocity_positive" CHECK (
          "max_calls_per_hour" IS NULL OR "max_calls_per_hour" > 0
        )
      )
    `);

    // Exactly one live policy per scope. `agent_id IS NULL` (the organization
    // default) and a per-agent override need separate indexes: NULL is not
    // equal to NULL, so one index cannot constrain both halves.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_spend_policies_live_agent" ON "spend_policies" ` +
        `("organization_id", "agent_id") WHERE "superseded_at" IS NULL AND "agent_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_spend_policies_live_org" ON "spend_policies" ` +
        `("organization_id") WHERE "superseded_at" IS NULL AND "agent_id" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_spend_policies_current" ON "spend_policies" ` +
        `("organization_id", "agent_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_spend_policies_organization" ON "spend_policies" ("organization_id")`,
    );

    // ── notifications ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id"                   uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"           timestamptz   NOT NULL DEFAULT now(),
        "updated_at"           timestamptz   NOT NULL DEFAULT now(),
        "deleted_at"           timestamptz   NULL,
        "version"              integer       NOT NULL DEFAULT 1,
        "organization_id"      uuid          NOT NULL,

        "event"                character varying(64)   NOT NULL,
        "severity"             character varying(16)   NOT NULL,
        "title"                character varying(256)  NOT NULL,
        "body"                 character varying(2048) NOT NULL,
        "subject_type"         character varying(32)   NULL,
        "subject_id"           character varying(128)  NULL,
        "payload"              jsonb         NOT NULL DEFAULT '{}'::jsonb,
        "read_at"              timestamptz   NULL,
        "first_delivered_at"   timestamptz   NULL,

        CONSTRAINT "pk_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "chk_notifications_severity" CHECK (
          "severity" IN ('INFO', 'WARNING', 'CRITICAL')
        )
      )
    `);

    // "Unread, newest first" is the query behind the badge on every page.
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_unread" ON "notifications" ` +
        `("organization_id", "created_at" DESC) WHERE "read_at" IS NULL AND "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_event" ON "notifications" ` +
        `("organization_id", "event", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_feed" ON "notifications" ` +
        `("organization_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_organization" ON "notifications" ("organization_id")`,
    );

    // ── audit_log_entries ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "audit_log_entries" (
        "id"                uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"        timestamptz   NOT NULL DEFAULT now(),
        "updated_at"        timestamptz   NOT NULL DEFAULT now(),
        "version"           integer       NOT NULL DEFAULT 1,
        "organization_id"   uuid          NOT NULL,

        "actor_type"        character varying(16)   NOT NULL,
        "actor_id"          character varying(128)  NOT NULL,
        "action"            character varying(64)   NOT NULL,
        "resource_type"     character varying(32)   NOT NULL,
        "resource_id"       character varying(128)  NULL,
        "before"            jsonb         NULL,
        "after"             jsonb         NULL,
        "ip_address"        character varying(64)   NULL,
        "user_agent"        character varying(512)  NULL,
        "request_id"        character varying(128)  NULL,

        CONSTRAINT "pk_audit_log_entries" PRIMARY KEY ("id"),
        CONSTRAINT "chk_audit_log_entries_actor_type" CHECK (
          "actor_type" IN ('user', 'agent', 'system', 'provider')
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_audit_log_entries_resource" ON "audit_log_entries" ` +
        `("organization_id", "resource_type", "resource_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_log_entries_actor" ON "audit_log_entries" ` +
        `("organization_id", "actor_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_log_entries_feed" ON "audit_log_entries" ` +
        `("organization_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_log_entries_organization" ON "audit_log_entries" ("organization_id")`,
    );

    // ── agent_credentials ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "agent_credentials" (
        "id"                uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"        timestamptz   NOT NULL DEFAULT now(),
        "updated_at"        timestamptz   NOT NULL DEFAULT now(),
        "deleted_at"        timestamptz   NULL,
        "version"           integer       NOT NULL DEFAULT 1,
        "organization_id"   uuid          NOT NULL,

        "agent_id"          uuid          NOT NULL,
        "name"              character varying(128)  NOT NULL,
        "prefix"            character varying(24)   NOT NULL,
        "token_hash"        character varying(128)  NOT NULL,
        "scopes"            text[]        NOT NULL DEFAULT '{}'::text[],
        "last_used_at"      timestamptz   NULL,
        "expires_at"        timestamptz   NULL,
        "revoked_at"        timestamptz   NULL,
        "revoked_by"        character varying(128)  NULL,
        "rotated_from_id"   uuid          NULL,

        CONSTRAINT "pk_agent_credentials" PRIMARY KEY ("id"),
        CONSTRAINT "chk_agent_credentials_revocation_is_whole" CHECK (
          ("revoked_at" IS NULL AND "revoked_by" IS NULL) OR
          ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
        )
      )
    `);

    // Platform-wide, deliberately not per organization — see the class comment.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_agent_credentials_token" ON "agent_credentials" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_agent" ON "agent_credentials" ` +
        `("organization_id", "agent_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_prefix" ON "agent_credentials" ` +
        `("organization_id", "prefix")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_organization" ON "agent_credentials" ("organization_id")`,
    );

    // ── disputes ─────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "disputes" (
        "id"                uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"        timestamptz   NOT NULL DEFAULT now(),
        "updated_at"        timestamptz   NOT NULL DEFAULT now(),
        "version"           integer       NOT NULL DEFAULT 1,
        "organization_id"   uuid          NOT NULL,

        "subject_type"      character varying(24)   NOT NULL,
        "subject_id"        character varying(128)  NOT NULL,
        "provider_id"       uuid          NULL,
        "state"             character varying(24)   NOT NULL,
        "claim_type"        character varying(32)   NOT NULL,
        "reason"            character varying(2048) NOT NULL,
        "evidence"          jsonb         NOT NULL DEFAULT '[]'::jsonb,
        "opened_by"         character varying(128)  NOT NULL,
        "acknowledged_at"   timestamptz   NULL,
        "deadline_at"       timestamptz   NULL,
        "resolved_at"       timestamptz   NULL,
        "resolved_by"       character varying(128)  NULL,
        "resolution_note"   character varying(2048) NULL,
        "restored_amount"   numeric(78,0) NULL,
        "asset_id"          character varying(256)  NULL,
        "decimals"          integer       NULL,

        CONSTRAINT "pk_disputes" PRIMARY KEY ("id"),
        CONSTRAINT "chk_disputes_subject_type" CHECK (
          "subject_type" IN ('SLA_WINDOW', 'VERDICT', 'PAYMENT_INTENT')
        ),
        CONSTRAINT "chk_disputes_state" CHECK (
          "state" IN ('OPEN', 'UNDER_REVIEW', 'UPHELD', 'PARTIALLY_UPHELD', 'REJECTED', 'WITHDRAWN')
        ),
        -- A clock the respondent never learned about is not due process (A2).
        CONSTRAINT "chk_disputes_deadline_needs_ack" CHECK (
          "deadline_at" IS NULL OR "acknowledged_at" IS NOT NULL
        ),
        -- A resolved dispute names who resolved it, or it is not a resolution.
        CONSTRAINT "chk_disputes_resolution_is_whole" CHECK (
          ("resolved_at" IS NULL AND "resolved_by" IS NULL) OR
          ("resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL)
        ),
        -- A restored amount is meaningless without the asset that scales it.
        CONSTRAINT "chk_disputes_restored_amount_has_asset" CHECK (
          "restored_amount" IS NULL OR
          ("asset_id" IS NOT NULL AND "decimals" IS NOT NULL)
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_disputes_subject" ON "disputes" ` +
        `("organization_id", "subject_type", "subject_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_state" ON "disputes" ("organization_id", "state", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_feed" ON "disputes" ("organization_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_provider" ON "disputes" ("organization_id", "provider_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_disputes_organization" ON "disputes" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "disputes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_credentials"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log_entries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "spend_policies"`);
  }
}
