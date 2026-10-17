import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Publishing toolsets (design spec §7.2, §7.7–§7.9, phase T2).
 *
 * ## `toolsets`
 *
 * - `first_shared_at`: the first UNLISTED or PUBLIC share. From then on the
 *   slug is held for good, even after a delete: a recreated toolset with the
 *   same slug would otherwise answer `/@handle/slug@1` with different tools.
 *   The live-slug index becomes "live, or ever shared".
 * - `delisted_at`: an operator's delist stands until relisted or reverted, so
 *   an owner cannot relist by stopping and sharing again.
 * - A platform (Official) slug is unique among platform toolsets: `NULL`
 *   owners are distinct to the owner/slug index.
 * - The state machine's shape as CHECKs: PUBLIC ⇔ a listing status; grace
 *   visibility ⇔ grace end; a token in the form `/u/` accepts.
 *
 * ## `toolset_versions`
 *
 * Immutable snapshots (a trigger refuses UPDATE and DELETE): entries with
 * their rules, discovery mode, search threshold, pinned tools, name,
 * description, icon. `tool_ids` repeats the entries' tool ids so access
 * resolution reads one array. Kept for as long as the toolset row exists,
 * which is forever (toolsets are soft-deleted), so a pinned access entry never
 * loses what it allowed.
 *
 * ## Reports, notices, stats, moderation
 *
 * `toolset_reports` (one open report per item per reporting org),
 * `toolset_notice_log` (FR-17 dedupe), `toolset_stats_daily` (internal, raw,
 * one rolling 30-day window per day), `toolset_stats_published` (weekly,
 * already rounded and k-checked: the only table pages read), and
 * `moderation_cutoffs` — an operator's delist or takedown that takes effect
 * at once and is reverted unless a second operator confirms it by
 * `confirm_by` (FR-18).
 */
export class ToolsetPublishing1761400000001 implements MigrationInterface {
  name = 'ToolsetPublishing1761400000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "toolsets"
        ADD COLUMN "first_shared_at" timestamptz NULL,
        ADD COLUMN "delisted_at"     timestamptz NULL,
        ADD CONSTRAINT "chk_toolsets_listing"
          CHECK (("visibility" = 'PUBLIC') = ("listing_status" IS NOT NULL)),
        ADD CONSTRAINT "chk_toolsets_grace"
          CHECK (("grace_visibility" IS NULL) = ("grace_until" IS NULL)),
        ADD CONSTRAINT "chk_toolsets_unlisted_token"
          CHECK ("unlisted_token" IS NULL OR "unlisted_token" ~ '^[a-z0-9_-]{22,32}$'),
        ADD CONSTRAINT "chk_toolsets_latest_version"
          CHECK ("latest_version" IS NULL OR "latest_version" >= 1)
    `);
    await queryRunner.query(`DROP INDEX "uq_toolsets_owner_slug_live"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_toolsets_owner_slug_held"
        ON "toolsets" ("owner_org_id", "slug")
        WHERE "deleted_at" IS NULL OR "first_shared_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_toolsets_platform_slug_held"
        ON "toolsets" ("slug")
        WHERE "owner_org_id" IS NULL AND ("deleted_at" IS NULL OR "first_shared_at" IS NOT NULL)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_toolsets_catalogue"
        ON "toolsets" ("publisher_kind", "created_at")
        WHERE "visibility" = 'PUBLIC' AND "listing_status" = 'LISTED'
          AND "removed_at" IS NULL AND "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_toolsets_grace" ON "toolsets" ("grace_until") WHERE "grace_until" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "toolset_versions" (
        "toolset_id"       uuid          NOT NULL,
        "version"          integer       NOT NULL,
        "entries"          jsonb         NOT NULL,
        "tool_ids"         uuid[]        NOT NULL,
        "discovery"        varchar(16)   NOT NULL,
        "search_threshold" integer       NOT NULL,
        "pinned_tools"     text[]        NOT NULL,
        "name"             varchar(80)   NOT NULL,
        "description"      varchar(280)  NULL,
        "icon"             varchar(32)   NULL,
        "changelog"        varchar(500)  NULL,
        "published_at"     timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "pk_toolset_versions" PRIMARY KEY ("toolset_id", "version"),
        CONSTRAINT "fk_toolset_versions_toolset"
          FOREIGN KEY ("toolset_id") REFERENCES "toolsets" ("id") ON DELETE RESTRICT,
        CONSTRAINT "chk_toolset_versions_version" CHECK ("version" >= 1),
        CONSTRAINT "chk_toolset_versions_discovery"
          CHECK ("discovery" IN ('AUTO', 'FULL', 'SEARCH')),
        CONSTRAINT "chk_toolset_versions_pinned" CHECK (cardinality("pinned_tools") <= 5),
        CONSTRAINT "chk_toolset_versions_entries" CHECK (jsonb_typeof("entries") = 'array')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_toolset_versions_published" ON "toolset_versions" ("toolset_id", "published_at")`,
    );
    await queryRunner.query(`
      CREATE FUNCTION "toolset_versions_immutable"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'toolset_versions rows are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_toolset_versions_immutable"
        BEFORE UPDATE OR DELETE ON "toolset_versions"
        FOR EACH ROW EXECUTE FUNCTION "toolset_versions_immutable"()
    `);

    await queryRunner.query(`
      CREATE TABLE "toolset_reports" (
        "id"              uuid          NOT NULL DEFAULT gen_random_uuid(),
        "toolset_id"      uuid          NULL,
        "tool_id"         uuid          NULL,
        "handle"          varchar(24)   NULL,
        "reporter_org_id" uuid          NOT NULL,
        "reason"          varchar(500)  NOT NULL,
        "created_at"      timestamptz   NOT NULL DEFAULT now(),
        "resolved_at"     timestamptz   NULL,
        "resolution"      varchar(32)   NULL,
        "resolved_by"     uuid          NULL,
        CONSTRAINT "pk_toolset_reports" PRIMARY KEY ("id"),
        CONSTRAINT "chk_toolset_reports_target"
          CHECK (num_nonnulls("toolset_id", "tool_id", "handle") = 1),
        CONSTRAINT "chk_toolset_reports_resolution"
          CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL)
                 AND ("resolution" IS NULL
                      OR "resolution" IN ('DISMISSED', 'DELISTED', 'TAKEN_DOWN', 'ACTIONED')))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_toolset_reports_open"
        ON "toolset_reports"
          ("reporter_org_id", (COALESCE("toolset_id"::text, "tool_id"::text, "handle")))
        WHERE "resolved_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_toolset_reports_reporter" ON "toolset_reports" ("reporter_org_id", "created_at")`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_toolset_reports_queue"
        ON "toolset_reports" ("created_at", "id") WHERE "resolved_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "toolset_notice_log" (
        "org_id"     uuid         NOT NULL,
        "toolset_id" uuid         NOT NULL,
        "to_version" integer      NOT NULL,
        "sent_at"    timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_toolset_notice_log" PRIMARY KEY ("org_id", "toolset_id", "to_version")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_toolset_notice_log_recent" ON "toolset_notice_log" ("org_id", "toolset_id", "sent_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "toolset_stats_daily" (
        "toolset_id"          uuid         NOT NULL,
        "day"                 date         NOT NULL,
        "active_orgs"         integer      NOT NULL,
        "active_agents"       integer      NOT NULL,
        "calls"               integer      NOT NULL,
        "copies"              integer      NOT NULL,
        "copy_orgs"           integer      NOT NULL,
        "latest_version_orgs" integer      NOT NULL,
        "retained_orgs"       integer      NOT NULL DEFAULT 0,
        "computed_at"         timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_toolset_stats_daily" PRIMARY KEY ("toolset_id", "day")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "toolset_stats_published" (
        "toolset_id"     uuid              NOT NULL,
        "week_start"     date              NOT NULL,
        "figures"        jsonb             NOT NULL,
        "dashboard"      jsonb             NOT NULL DEFAULT '{}'::jsonb,
        "popular_score"  double precision  NOT NULL DEFAULT 0,
        "trending_score" double precision  NOT NULL DEFAULT 0,
        "published_at"   timestamptz       NOT NULL DEFAULT now(),
        CONSTRAINT "pk_toolset_stats_published" PRIMARY KEY ("toolset_id", "week_start")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "moderation_cutoffs" (
        "id"            uuid           NOT NULL DEFAULT gen_random_uuid(),
        "target_type"   varchar(16)    NOT NULL,
        "target_id"     varchar(64)    NOT NULL,
        "action"        varchar(16)    NOT NULL,
        "acted_by"      uuid           NOT NULL,
        "acted_at"      timestamptz    NOT NULL DEFAULT now(),
        "confirm_by"    timestamptz    NOT NULL,
        "confirmed_by"  uuid           NULL,
        "confirmed_at"  timestamptz    NULL,
        "reverted_by"   uuid           NULL,
        "reverted_at"   timestamptz    NULL,
        "revert_reason" varchar(16)    NULL,
        "report_id"     uuid           NULL,
        "note"          varchar(1000)  NOT NULL,
        CONSTRAINT "pk_moderation_cutoffs" PRIMARY KEY ("id"),
        CONSTRAINT "chk_moderation_cutoffs_target" CHECK ("target_type" IN ('TOOLSET', 'HANDLE')),
        CONSTRAINT "chk_moderation_cutoffs_action" CHECK ("action" IN ('DELIST', 'TAKEDOWN')),
        CONSTRAINT "chk_moderation_cutoffs_confirmed"
          CHECK (("confirmed_by" IS NULL) = ("confirmed_at" IS NULL)
                 AND ("confirmed_by" IS NULL OR "confirmed_by" <> "acted_by")),
        CONSTRAINT "chk_moderation_cutoffs_reverted"
          CHECK (("reverted_at" IS NULL) = ("revert_reason" IS NULL)
                 AND ("revert_reason" IS NULL
                      OR "revert_reason" IN ('EXPIRED', 'REJECTED', 'LIFTED')))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_moderation_cutoffs_standing"
        ON "moderation_cutoffs" ("target_type", "target_id", "action") WHERE "reverted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_moderation_cutoffs_due"
        ON "moderation_cutoffs" ("confirm_by")
        WHERE "confirmed_at" IS NULL AND "reverted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "moderation_cutoffs"`);
    await queryRunner.query(`DROP TABLE "toolset_stats_published"`);
    await queryRunner.query(`DROP TABLE "toolset_stats_daily"`);
    await queryRunner.query(`DROP TABLE "toolset_notice_log"`);
    await queryRunner.query(`DROP TABLE "toolset_reports"`);
    await queryRunner.query(`DROP TABLE "toolset_versions"`);
    await queryRunner.query(`DROP FUNCTION "toolset_versions_immutable"()`);
    await queryRunner.query(`DROP INDEX "idx_toolsets_grace"`);
    await queryRunner.query(`DROP INDEX "idx_toolsets_catalogue"`);
    await queryRunner.query(`DROP INDEX "uq_toolsets_platform_slug_held"`);
    await queryRunner.query(`DROP INDEX "uq_toolsets_owner_slug_held"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_toolsets_owner_slug_live"
        ON "toolsets" ("owner_org_id", "slug") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "toolsets"
        DROP CONSTRAINT "chk_toolsets_latest_version",
        DROP CONSTRAINT "chk_toolsets_unlisted_token",
        DROP CONSTRAINT "chk_toolsets_grace",
        DROP CONSTRAINT "chk_toolsets_listing",
        DROP COLUMN "delisted_at",
        DROP COLUMN "first_shared_at"
    `);
  }
}
