import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `toolsets` and `toolset_entries` (design spec §7.2, §7.7).
 *
 * A toolset is a named list of tools with optional provider rules per entry,
 * served as its own MCP server. `toolset_entries` is the **Draft**:
 * `/my/{slug}` serves it live. Publishing, versions and sharing are T2
 * (`toolset_versions`, the `unlisted_token` and the grace columns are created
 * now so the row shape does not move under the web app).
 *
 * ## One deliberate deviation
 *
 * The slug is unique per owner among **live** toolsets (`deleted_at IS NULL`),
 * not across every row: a deleted toolset keeps its row (calls and access
 * policies name it) and must not hold its slug forever.
 */
export class CreateToolsets1761200000002 implements MigrationInterface {
  name = 'CreateToolsets1761200000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "toolsets" (
        "id"                  uuid          NOT NULL DEFAULT gen_random_uuid(),
        "owner_org_id"        uuid          NULL,
        "publisher_kind"      varchar(16)   NOT NULL,
        "slug"                varchar(64)   NOT NULL,
        "name"                varchar(80)   NOT NULL,
        "description"         varchar(280)  NULL,
        "category"            varchar(64)   NULL,
        "tags"                text[]        NOT NULL DEFAULT '{}',
        "icon"                varchar(32)   NULL,
        "visibility"          varchar(16)   NOT NULL DEFAULT 'PRIVATE',
        "unlisted_token"      varchar(32)   NULL,
        "listing_status"      varchar(16)   NULL,
        "grace_visibility"    varchar(16)   NULL,
        "grace_until"         timestamptz   NULL,
        "removed_at"          timestamptz   NULL,
        "deleted_at"          timestamptz   NULL,
        "latest_version"      integer       NULL,
        "discovery"           varchar(16)   NOT NULL DEFAULT 'AUTO',
        "search_threshold"    integer       NOT NULL DEFAULT 25,
        "pinned_tools"        text[]        NOT NULL DEFAULT '{}',
        "forked_from_id"      uuid          NULL,
        "forked_from_version" integer       NULL,
        "created_at"          timestamptz   NOT NULL DEFAULT now(),
        "updated_at"          timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "pk_toolsets" PRIMARY KEY ("id"),
        CONSTRAINT "uq_toolsets_unlisted_token" UNIQUE ("unlisted_token"),
        CONSTRAINT "chk_toolsets_publisher_kind"
          CHECK ("publisher_kind" IN ('USER', 'PLATFORM', 'PROVIDER')),
        CONSTRAINT "chk_toolsets_owner"
          CHECK (("publisher_kind" = 'PLATFORM') = ("owner_org_id" IS NULL)),
        CONSTRAINT "chk_toolsets_slug" CHECK ("slug" ~ '^[a-z0-9-]{2,64}$'),
        CONSTRAINT "chk_toolsets_visibility"
          CHECK ("visibility" IN ('PRIVATE', 'UNLISTED', 'PUBLIC')),
        CONSTRAINT "chk_toolsets_listing_status"
          CHECK ("listing_status" IS NULL OR "listing_status" IN ('LISTED', 'DELISTED')),
        CONSTRAINT "chk_toolsets_grace_visibility"
          CHECK ("grace_visibility" IS NULL OR "grace_visibility" IN ('UNLISTED', 'PUBLIC')),
        CONSTRAINT "chk_toolsets_discovery" CHECK ("discovery" IN ('AUTO', 'FULL', 'SEARCH')),
        CONSTRAINT "chk_toolsets_search_threshold"
          CHECK ("search_threshold" BETWEEN 1 AND 500),
        CONSTRAINT "chk_toolsets_pinned_tools" CHECK (cardinality("pinned_tools") <= 5)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_toolsets_owner_slug_live"
        ON "toolsets" ("owner_org_id", "slug")
        WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_toolsets_owner" ON "toolsets" ("owner_org_id", "created_at", "id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "toolset_entries" (
        "toolset_id"            uuid          NOT NULL,
        "position"              integer       NOT NULL,
        "tool_id"               uuid          NOT NULL,
        "tool_version_range"    varchar(32)   NULL,
        "provider_mode"         varchar(8)    NOT NULL DEFAULT 'BEST',
        "provider_ids"          uuid[]        NOT NULL DEFAULT '{}',
        "min_tier"              varchar(16)   NULL,
        "max_price_amount"      numeric(78,0) NULL,
        "max_price_asset_id"    varchar(256)  NULL,
        "max_price_decimals"    integer       NULL,
        "min_quality"           numeric(4,3)  NULL,
        "require_output_fields" text[]        NOT NULL DEFAULT '{}',
        "on_empty"              varchar(16)   NOT NULL DEFAULT 'FAIL',
        CONSTRAINT "pk_toolset_entries" PRIMARY KEY ("toolset_id", "position"),
        CONSTRAINT "uq_toolset_entries_tool" UNIQUE ("toolset_id", "tool_id"),
        CONSTRAINT "fk_toolset_entries_toolset"
          FOREIGN KEY ("toolset_id") REFERENCES "toolsets" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_toolset_entries_tool" FOREIGN KEY ("tool_id") REFERENCES "tools" ("id"),
        CONSTRAINT "chk_toolset_entries_position" CHECK ("position" >= 0 AND "position" < 200),
        CONSTRAINT "chk_toolset_entries_provider_mode"
          CHECK ("provider_mode" IN ('BEST', 'ONLY', 'EXCLUDE')),
        CONSTRAINT "chk_toolset_entries_provider_ids"
          CHECK (("provider_mode" = 'BEST') = (cardinality("provider_ids") = 0)),
        CONSTRAINT "chk_toolset_entries_min_tier"
          CHECK ("min_tier" IS NULL OR "min_tier" IN ('NEW', 'ESTABLISHED', 'TRUSTED')),
        CONSTRAINT "chk_toolset_entries_max_price"
          CHECK (("max_price_amount" IS NULL) = ("max_price_asset_id" IS NULL)
                 AND ("max_price_amount" IS NULL) = ("max_price_decimals" IS NULL)
                 AND ("max_price_amount" IS NULL OR "max_price_amount" >= 0)),
        CONSTRAINT "chk_toolset_entries_min_quality"
          CHECK ("min_quality" IS NULL OR ("min_quality" >= 0 AND "min_quality" <= 1)),
        CONSTRAINT "chk_toolset_entries_on_empty" CHECK ("on_empty" IN ('FAIL', 'FALLBACK_BEST'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "toolset_entries"`);
    await queryRunner.query(`DROP TABLE "toolsets"`);
  }
}
