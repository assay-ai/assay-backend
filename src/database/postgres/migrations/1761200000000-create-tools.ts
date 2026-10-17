import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The `tools` table, and `tool_bindings.tool_id` as a real reference to it.
 *
 * Until now a tool existed only in the catalogue seed and `tool_bindings.tool_id`
 * was a bare `varchar(128)` naming it. Toolsets, access policies and the quote
 * index all name tools by id, and an id with no row behind it is an id nothing
 * can join, constrain or list. So the minimal row lands here (design spec
 * §7.2, phase T1): identity, kind, category, tags, visibility and status.
 * Schemas stay in the seed until `tool_versions` (T3).
 *
 * ## Who writes the rows
 *
 * `ToolRegistrySeeder` upserts every seeded tool at boot, before anything can
 * reference one. The seed is still the source of truth for STANDARD tools.
 *
 * ## Existing bindings
 *
 * Nothing runs in production (§11.2), so no data is converted. A local
 * database may still hold bindings for seeded tools, and the foreign key would
 * refuse them before the first boot has upserted the seed. Each such tool id
 * gets a placeholder row, which the next boot's upsert overwrites with the
 * seeded name, category and tags. A binding whose `tool_id` is not a uuid
 * fails the cast loudly: such a row can only come from a hand-written test
 * fixture.
 */
export class CreateTools1761200000000 implements MigrationInterface {
  name = 'CreateTools1761200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tools" (
        "id"            uuid           NOT NULL,
        "name"          varchar(48)    NOT NULL,
        "kind"          varchar(16)    NOT NULL,
        "owner_org_id"  uuid           NULL,
        "category"      varchar(64)    NOT NULL,
        "tags"          text[]         NOT NULL DEFAULT '{}',
        "visibility"    varchar(16)    NOT NULL,
        "review_status" varchar(16)    NULL,
        "review_note"   varchar(1000)  NULL,
        "status"        varchar(16)    NOT NULL,
        "created_at"    timestamptz    NOT NULL DEFAULT now(),
        "updated_at"    timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tools" PRIMARY KEY ("id"),
        CONSTRAINT "uq_tools_name" UNIQUE ("name"),
        CONSTRAINT "chk_tools_kind" CHECK ("kind" IN ('STANDARD', 'PROVIDER')),
        CONSTRAINT "chk_tools_visibility"
          CHECK ("visibility" IN ('PRIVATE', 'UNLISTED', 'LISTED')),
        CONSTRAINT "chk_tools_status"
          CHECK ("status" IN ('ACTIVE', 'DEPRECATED', 'RETIRED', 'REMOVED')),
        CONSTRAINT "chk_tools_review_status"
          CHECK ("review_status" IS NULL
                 OR "review_status" IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED')),
        CONSTRAINT "chk_tools_owner" CHECK (("kind" = 'PROVIDER') = ("owner_org_id" IS NOT NULL)),
        CONSTRAINT "chk_tools_standard_listed"
          CHECK ("kind" <> 'STANDARD' OR "visibility" = 'LISTED'),
        CONSTRAINT "chk_tools_standard_name"
          CHECK ("kind" <> 'STANDARD'
                 OR ("name" ~ '^[a-z][a-z0-9_]{1,47}$' AND position('__' IN "name") = 0)),
        CONSTRAINT "chk_tools_category" CHECK ("category" ~ '^[a-z][a-z0-9-]{1,63}$')
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_tools_category" ON "tools" ("category")`);

    await queryRunner.query(`
      INSERT INTO "tools" ("id", "name", "kind", "category", "visibility", "status")
      SELECT DISTINCT "tool_id"::uuid,
             'unseeded_' || replace("tool_id", '-', '_'),
             'STANDARD', 'uncategorised', 'LISTED', 'ACTIVE'
        FROM "tool_bindings"
    `);

    await queryRunner.query(
      `ALTER TABLE "tool_bindings" ALTER COLUMN "tool_id" TYPE uuid USING "tool_id"::uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "tool_bindings"
        ADD CONSTRAINT "fk_tool_bindings_tool"
        FOREIGN KEY ("tool_id") REFERENCES "tools" ("id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tool_bindings" DROP CONSTRAINT "fk_tool_bindings_tool"`);
    await queryRunner.query(
      `ALTER TABLE "tool_bindings" ALTER COLUMN "tool_id" TYPE varchar(128) USING "tool_id"::text`,
    );
    await queryRunner.query(`DROP TABLE "tools"`);
  }
}
