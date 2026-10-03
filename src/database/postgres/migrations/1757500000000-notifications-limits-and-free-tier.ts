import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema behind limits, notifications and the free tier.
 *
 * One migration for all three features, written before their work fanned out,
 * because three parallel changes each raising their own migration would
 * collide on run order.
 *
 * ## 1. `spend_policies` gains the three fields enforcement actually needs
 *
 * The table was first built as a *display* surface: the limits screen had to
 * render something. It shipped `per_call_max`, `daily_cap`, `monthly_cap` and
 * `max_calls_per_hour`, and velocity limits need two fields this schema does
 * not have — `maxCallsPerMinute` and `maxSpendPerHour` — plus a tool allowlist,
 * `allowedTools`.
 *
 * The per-*minute* column is not a nicety: a retry loop burns the whole daily
 * budget in four minutes while `per_call_max` and `daily_cap` behave exactly as
 * specified on every single call. An hour is the wrong resolution for the one
 * failure this layer exists to catch; a minute is the right one. Both columns
 * stay — an hourly call ceiling is a real, separate control — but the minute is
 * the one that stops the loop.
 *
 * `allowed_tools` is `jsonb` holding an array of tool ids, and `NULL` means
 * *all tools*, matching `SpendPolicy.allowedTools: readonly string[] | null`.
 * An empty array is therefore a meaningful and very different thing — *no* tool
 * is allowed — which is why the CHECK below accepts it rather than folding it
 * into `NULL`.
 *
 * ## 2. `payment_intents.spend_policy_version`
 *
 * A receipt links to the exact policy version in force when its intent was
 * created. The policy table has been append-only since it was created precisely
 * so this question is answerable, and until now nothing wrote the pointer, so
 * it was not. Nullable, because every intent already in the table was created
 * before any policy was consulted and back-filling a version those calls were
 * never governed by would be a fabricated audit trail.
 *
 * ## 3. Three notification tables, and why the fourth is not here
 *
 * `notifications` already exists and its own class comment reserves
 * the seam: *"Delivery attempts belong in a delivery log keyed by
 * `(notification_id, channel)`."* That is `notification_deliveries`.
 *
 * `notification_channels` is the registry — where an organization's email goes,
 * whether Slack is configured at all. `notification_preferences` is the per
 * `(event, channel)` opt-out on top of it. They are two tables rather than one
 * because they answer different questions and change at different rates: a
 * destination is configured once and verified, a preference is toggled per
 * event forever. Collapsing them would mean re-verifying an email address every
 * time somebody mutes one event.
 *
 * The **event catalogue itself is code**, not a table
 * (`src/modules/notification/constants/notification-catalogue.ts`). Its
 * aggregation rules are part of the event definition, not a setting — a row a
 * operator could edit would make "once per band per period" a runtime claim
 * instead of a compile-time one, and the suppression rules for withdrawal
 * events exist specifically to be un-editable.
 *
 * Aggregation *state* — has this band already fired this period — is Redis,
 * keyed with the period in the key like `BindingCeilingService`'s daily
 * counter, and not a table. It is a duplicate-suppression cache, not a record:
 * losing it sends one notification twice, which is the failure direction to
 * prefer over sending none.
 *
 * ## 4. `tool_call_records` — what a free call leaves behind
 *
 * The relay path for free calls creates **no payment intent, no hold, no ledger
 * write**; free calls produce a `ToolCallRecord` instead. Until this table
 * there was nowhere for one to go, so `McpToolCallService` ran the full paid
 * machinery over a zero price — and `LedgerHoldService.createHold` refuses a
 * zero amount, so the first genuinely `FREE` binding `409`s. That is a live
 * defect, not a hypothetical; no demo binding is `FREE`, which is the only
 * reason nobody hit it.
 *
 * `WithoutSoftDelete` because retention here is real deletion: these rows get
 * 30 days and then aggregation, and a `deleted_at` on a row the retention job
 * is supposed to remove is the row still being there. `expires_at` is stored
 * rather than derived so the sweep is an index range scan and so changing the
 * retention window does not retroactively resurrect or destroy rows already
 * written under the old one.
 *
 * `pricing_mode` is constrained to `FREE`/`FREEMIUM`: a `PAID` call has a
 * payment intent and belongs in that table. Two rows for one call would make
 * every count in the product ambiguous.
 */
export class NotificationsLimitsAndFreeTier1757500000000 implements MigrationInterface {
  name = 'NotificationsLimitsAndFreeTier1757500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Spend policy: the fields enforcement needs ──────────────────────

    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        ADD COLUMN "max_calls_per_minute" integer,
        ADD COLUMN "max_spend_per_hour"   numeric(78,0),
        ADD COLUMN "allowed_tools"        jsonb
    `);

    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        ADD CONSTRAINT "chk_spend_policies_calls_per_minute_positive"
          CHECK ("max_calls_per_minute" IS NULL OR "max_calls_per_minute" > 0)
    `);

    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        ADD CONSTRAINT "chk_spend_policies_spend_per_hour_non_negative"
          CHECK ("max_spend_per_hour" IS NULL OR "max_spend_per_hour" >= 0)
    `);

    // An array, or absent. `[]` is legal and means "no tool is allowed" — a
    // policy that stops everything without zeroing the caps that would say why.
    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        ADD CONSTRAINT "chk_spend_policies_allowed_tools_array"
          CHECK ("allowed_tools" IS NULL OR jsonb_typeof("allowed_tools") = 'array')
    `);

    // ── 2. The receipt's link to the policy that governed it ───────────────

    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD COLUMN "spend_policy_version" integer
    `);

    await queryRunner.query(`
      ALTER TABLE "payment_intents"
        ADD CONSTRAINT "chk_payment_intents_spend_policy_version_positive"
          CHECK ("spend_policy_version" IS NULL OR "spend_policy_version" >= 1)
    `);

    // ── 3. Notification channels, preferences and the delivery log ─────────

    await queryRunner.query(`
      CREATE TABLE "notification_channels" (
        "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz  NOT NULL DEFAULT now(),
        "updated_at"      timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"      timestamptz,
        "version"         integer      NOT NULL DEFAULT 1,
        "organization_id" uuid         NOT NULL,
        "channel"         varchar(16)  NOT NULL,
        "destination"     varchar(512),
        "enabled"         boolean      NOT NULL DEFAULT true,
        "verified_at"     timestamptz,
        CONSTRAINT "pk_notification_channels" PRIMARY KEY ("id"),
        CONSTRAINT "uq_notification_channels_org_channel"
          UNIQUE ("organization_id", "channel"),
        CONSTRAINT "chk_notification_channels_channel"
          CHECK ("channel" IN ('IN_APP', 'EMAIL', 'PUSH', 'SLACK', 'WEBHOOK')),
        -- IN_APP is the dashboard's own inbox and has nowhere to send to. Every
        -- other channel without a destination is a channel that will fail at
        -- delivery time instead of at configuration time, which is the wrong
        -- moment to find out.
        CONSTRAINT "chk_notification_channels_destination"
          CHECK ("channel" = 'IN_APP' OR "destination" IS NOT NULL)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_notification_channels_organization_id" ` +
        `ON "notification_channels" ("organization_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "notification_preferences" (
        "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz  NOT NULL DEFAULT now(),
        "updated_at"      timestamptz  NOT NULL DEFAULT now(),
        "deleted_at"      timestamptz,
        "version"         integer      NOT NULL DEFAULT 1,
        "organization_id" uuid         NOT NULL,
        "event"           varchar(64)  NOT NULL,
        "channel"         varchar(16)  NOT NULL,
        "enabled"         boolean      NOT NULL,
        CONSTRAINT "pk_notification_preferences" PRIMARY KEY ("id"),
        CONSTRAINT "uq_notification_preferences_org_event_channel"
          UNIQUE ("organization_id", "event", "channel"),
        CONSTRAINT "chk_notification_preferences_channel"
          CHECK ("channel" IN ('IN_APP', 'EMAIL', 'PUSH', 'SLACK', 'WEBHOOK'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_notification_preferences_organization_id" ` +
        `ON "notification_preferences" ("organization_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "notification_deliveries" (
        "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz  NOT NULL DEFAULT now(),
        "updated_at"      timestamptz  NOT NULL DEFAULT now(),
        "version"         integer      NOT NULL DEFAULT 1,
        "organization_id" uuid         NOT NULL,
        "notification_id" uuid         NOT NULL,
        "channel"         varchar(16)  NOT NULL,
        "status"          varchar(16)  NOT NULL,
        "attempts"        integer      NOT NULL DEFAULT 0,
        "last_error"      varchar(512),
        "delivered_at"    timestamptz,
        CONSTRAINT "pk_notification_deliveries" PRIMARY KEY ("id"),
        -- One row per channel per notification, so a retry updates rather than
        -- appends. "I never got an alert" (FA-45) is answered by reading one
        -- row, not by folding a history of attempts.
        CONSTRAINT "uq_notification_deliveries_notification_channel"
          UNIQUE ("notification_id", "channel"),
        CONSTRAINT "chk_notification_deliveries_channel"
          CHECK ("channel" IN ('IN_APP', 'EMAIL', 'PUSH', 'SLACK', 'WEBHOOK')),
        CONSTRAINT "chk_notification_deliveries_status"
          CHECK ("status" IN ('PENDING', 'DELIVERED', 'FAILED', 'SUPPRESSED')),
        CONSTRAINT "chk_notification_deliveries_delivered_at"
          CHECK (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL)),
        CONSTRAINT "fk_notification_deliveries_notification"
          FOREIGN KEY ("notification_id") REFERENCES "notifications" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_notification_deliveries_organization_id" ` +
        `ON "notification_deliveries" ("organization_id")`,
    );

    // The operator question is always "what has not landed" — a partial index
    // so the answer does not scan every delivery ever made.
    await queryRunner.query(
      `CREATE INDEX "idx_notification_deliveries_undelivered" ` +
        `ON "notification_deliveries" ("organization_id", "created_at") ` +
        `WHERE "status" IN ('PENDING', 'FAILED')`,
    );

    // ── 4. What a free call leaves behind ──────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "tool_call_records" (
        "id"              uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz   NOT NULL DEFAULT now(),
        "updated_at"      timestamptz   NOT NULL DEFAULT now(),
        "version"         integer       NOT NULL DEFAULT 1,
        "organization_id" uuid          NOT NULL,
        "agent_id"        uuid          NOT NULL,
        "call_id"         uuid          NOT NULL,
        "tool_id"         varchar(128)  NOT NULL,
        "binding_id"      uuid,
        "provider_id"     uuid,
        "pricing_mode"    varchar(16)   NOT NULL,
        "classification"  varchar(32)   NOT NULL,
        "latency_ms"      integer       NOT NULL,
        "request_hash"    varchar(128),
        "verdict"         varchar(32),
        "expires_at"      timestamptz   NOT NULL,
        CONSTRAINT "pk_tool_call_records" PRIMARY KEY ("id"),
        -- The same id the provider saw as X-X402-Call-Id. Unique so
        -- a retried write cannot double-count a free call against its quota.
        CONSTRAINT "uq_tool_call_records_call_id" UNIQUE ("call_id"),
        CONSTRAINT "chk_tool_call_records_pricing_mode"
          CHECK ("pricing_mode" IN ('FREE', 'FREEMIUM')),
        CONSTRAINT "chk_tool_call_records_latency_non_negative"
          CHECK ("latency_ms" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_tool_call_records_organization_id" ` +
        `ON "tool_call_records" ("organization_id")`,
    );

    // The agent's own feed, keyset-ordered like every other list in the
    // dashboard API.
    await queryRunner.query(
      `CREATE INDEX "idx_tool_call_records_feed" ` +
        `ON "tool_call_records" ("organization_id", "created_at", "id")`,
    );

    // The provider's view of who is spending their free budget (providers see
    // their own free-tier usage broken down by agent).
    await queryRunner.query(
      `CREATE INDEX "idx_tool_call_records_binding_feed" ` +
        `ON "tool_call_records" ("binding_id", "created_at" DESC) ` +
        `WHERE "binding_id" IS NOT NULL`,
    );

    // The retention sweep's only query shape.
    await queryRunner.query(
      `CREATE INDEX "idx_tool_call_records_expiry" ON "tool_call_records" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_call_records"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_deliveries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_preferences"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_channels"`);

    await queryRunner.query(
      `ALTER TABLE "payment_intents" ` +
        `DROP CONSTRAINT IF EXISTS "chk_payment_intents_spend_policy_version_positive"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN IF EXISTS "spend_policy_version"`,
    );

    await queryRunner.query(
      `ALTER TABLE "spend_policies" ` +
        `DROP CONSTRAINT IF EXISTS "chk_spend_policies_allowed_tools_array"`,
    );
    await queryRunner.query(
      `ALTER TABLE "spend_policies" ` +
        `DROP CONSTRAINT IF EXISTS "chk_spend_policies_spend_per_hour_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "spend_policies" ` +
        `DROP CONSTRAINT IF EXISTS "chk_spend_policies_calls_per_minute_positive"`,
    );
    await queryRunner.query(`
      ALTER TABLE "spend_policies"
        DROP COLUMN IF EXISTS "allowed_tools",
        DROP COLUMN IF EXISTS "max_spend_per_hour",
        DROP COLUMN IF EXISTS "max_calls_per_minute"
    `);
  }
}
