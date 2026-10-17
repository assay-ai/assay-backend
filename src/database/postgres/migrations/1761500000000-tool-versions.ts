import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contracts move into the database (design spec §7.2, §7.5, phase T3).
 *
 * - `tool_versions`: one row per version of a tool's contract — semver, the
 *   200-character `summary` sent in `tools/list`, the full description, both
 *   schemas, the optional input and output fields, examples, verification
 *   policy, tier and the version state machine (DRAFT → ACTIVE → DEPRECATED →
 *   RETIRED). At most one DRAFT per tool.
 * - `tools.current_version`: the version unpinned URLs default to, and
 *   `tools.replacement_tool_id`, named by deprecation and retirement notices.
 *   `tools.status` gains `DRAFT`: a tool with no published version yet (an
 *   accepted tool request, a contract being drafted).
 * - `tool_bindings` (and their `binding_versions` snapshots): the contract
 *   majors a binding serves and the optional fields it declares.
 * - `binding_test_runs.tool_version`: which contract version a tester run
 *   checked, so the publish gate can ask for a green run per major.
 * - `tool_requests.tool_id`: the DRAFT tool an accepted request created.
 *
 * Nothing runs in production (§11.2), so nothing is converted: bindings take
 * the column defaults (`^1`, no declared fields) and the seed writes version
 * 1.0.0 of each seeded tool at boot (local and tests only, §13 D4).
 */
export class ToolVersions1761500000000 implements MigrationInterface {
  name = 'ToolVersions1761500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tools" DROP CONSTRAINT "chk_tools_status"`);
    await queryRunner.query(`
      ALTER TABLE "tools"
        ADD CONSTRAINT "chk_tools_status"
          CHECK ("status" IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED', 'REMOVED')),
        ADD COLUMN "current_version" integer NULL,
        ADD COLUMN "replacement_tool_id" uuid NULL,
        ADD CONSTRAINT "fk_tools_replacement_tool"
          FOREIGN KEY ("replacement_tool_id") REFERENCES "tools" ("id"),
        ADD CONSTRAINT "chk_tools_replacement_not_self"
          CHECK ("replacement_tool_id" IS NULL OR "replacement_tool_id" <> "id")
    `);

    await queryRunner.query(`
      CREATE TABLE "tool_versions" (
        "tool_id"                uuid           NOT NULL,
        "version"                integer        NOT NULL,
        "semver"                 varchar(16)    NOT NULL,
        "major"                  integer        NOT NULL,
        "summary"                varchar(200)   NOT NULL,
        "description"            text           NOT NULL,
        "input_schema"           jsonb          NOT NULL,
        "output_schema"          jsonb          NOT NULL,
        "optional_input_fields"  text[]         NOT NULL DEFAULT '{}',
        "optional_output_fields" text[]         NOT NULL DEFAULT '{}',
        "examples"               jsonb          NOT NULL DEFAULT '[]',
        "verification_policy_id" varchar(64)    NULL,
        "tier"                   varchar(16)    NULL,
        "status"                 varchar(16)    NOT NULL,
        "sunset_at"              timestamptz    NULL,
        "changelog"              varchar(1000)  NULL,
        "published_at"           timestamptz    NULL,
        "created_by"             uuid           NULL,
        "published_by"           uuid           NULL,
        "created_at"             timestamptz    NOT NULL DEFAULT now(),
        "updated_at"             timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tool_versions" PRIMARY KEY ("tool_id", "version"),
        CONSTRAINT "uq_tool_versions_semver" UNIQUE ("tool_id", "semver"),
        CONSTRAINT "fk_tool_versions_tool"
          FOREIGN KEY ("tool_id") REFERENCES "tools" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_tool_versions_version" CHECK ("version" >= 1),
        CONSTRAINT "chk_tool_versions_semver"
          CHECK ("semver" ~ '^(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})$'),
        CONSTRAINT "chk_tool_versions_major"
          CHECK ("major" = split_part("semver", '.', 1)::integer),
        CONSTRAINT "chk_tool_versions_status"
          CHECK ("status" IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED')),
        CONSTRAINT "chk_tool_versions_tier"
          CHECK ("tier" IS NULL OR "tier" IN ('UNVERIFIED', 'VERIFIED', 'GUARANTEED')),
        CONSTRAINT "chk_tool_versions_published"
          CHECK (("status" = 'DRAFT') = ("published_at" IS NULL)),
        CONSTRAINT "chk_tool_versions_sunset"
          CHECK ("status" NOT IN ('DEPRECATED', 'RETIRED') OR "sunset_at" IS NOT NULL),
        CONSTRAINT "chk_tool_versions_examples" CHECK (jsonb_typeof("examples") = 'array')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_tool_versions_one_draft"
        ON "tool_versions" ("tool_id") WHERE "status" = 'DRAFT'
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tool_versions_sunset"
        ON "tool_versions" ("sunset_at") WHERE "status" = 'DEPRECATED'
    `);
    await queryRunner.query(`
      ALTER TABLE "tools"
        ADD CONSTRAINT "fk_tools_current_version"
          FOREIGN KEY ("id", "current_version") REFERENCES "tool_versions" ("tool_id", "version")
    `);

    const range = `'^\\^[0-9]{1,4}( \\|\\| \\^[0-9]{1,4})*$'`;
    for (const table of ['tool_bindings', 'binding_versions']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "tool_version_range" varchar(32) NOT NULL DEFAULT '^1',
          ADD COLUMN "provides_output_fields" text[] NOT NULL DEFAULT '{}',
          ADD COLUMN "supports_input_fields" text[] NOT NULL DEFAULT '{}',
          ADD CONSTRAINT "chk_${table}_tool_version_range" CHECK ("tool_version_range" ~ ${range})
      `);
    }
    await queryRunner.query(`
      ALTER TABLE "toolset_entries"
        ADD CONSTRAINT "chk_toolset_entries_tool_version_range"
          CHECK ("tool_version_range" IS NULL OR "tool_version_range" ~ ${range})
    `);

    await queryRunner.query(
      `ALTER TABLE "binding_test_runs" ADD COLUMN "tool_version" integer NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "tool_requests"
        ADD COLUMN "tool_id" uuid NULL,
        ADD CONSTRAINT "fk_tool_requests_tool" FOREIGN KEY ("tool_id") REFERENCES "tools" ("id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tool_requests"
        DROP CONSTRAINT "fk_tool_requests_tool",
        DROP COLUMN "tool_id"
    `);
    await queryRunner.query(`ALTER TABLE "binding_test_runs" DROP COLUMN "tool_version"`);
    await queryRunner.query(
      `ALTER TABLE "toolset_entries" DROP CONSTRAINT "chk_toolset_entries_tool_version_range"`,
    );
    for (const table of ['binding_versions', 'tool_bindings']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP CONSTRAINT "chk_${table}_tool_version_range",
          DROP COLUMN "supports_input_fields",
          DROP COLUMN "provides_output_fields",
          DROP COLUMN "tool_version_range"
      `);
    }
    await queryRunner.query(`ALTER TABLE "tools" DROP CONSTRAINT "fk_tools_current_version"`);
    await queryRunner.query(`DROP TABLE "tool_versions"`);
    // A DRAFT tool has no place in the old status set.
    await queryRunner.query(`DELETE FROM "tools" WHERE "status" = 'DRAFT'`);
    await queryRunner.query(`
      ALTER TABLE "tools"
        DROP CONSTRAINT "chk_tools_replacement_not_self",
        DROP CONSTRAINT "fk_tools_replacement_tool",
        DROP COLUMN "replacement_tool_id",
        DROP COLUMN "current_version",
        DROP CONSTRAINT "chk_tools_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "tools"
        ADD CONSTRAINT "chk_tools_status"
          CHECK ("status" IN ('ACTIVE', 'DEPRECATED', 'RETIRED', 'REMOVED'))
    `);
  }
}
