import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which URL a call came through, refused calls, and the URLs the Connect
 * sheet handed out (design spec §7.2, §7.8, FR-16).
 *
 * ## Attribution, on `payment_intents` and `tool_call_records`
 *
 * `endpoint_kind` (`ROOT` | `HANDLE` | `CATEGORY` | `TOOLSET`), `toolset_id`,
 * `toolset_version` (`NULL` = the Draft), `endpoint_handle` and `view_filter`
 * (only the parameters that differ from the URL's default). Shipped now
 * because past calls cannot be attributed later.
 *
 * ## Refused calls, on `tool_call_records`
 *
 * A call refused before anything was charged — the URL does not serve the
 * tool, the agent may not use it, the rules leave no provider, a spend limit —
 * leaves a row with `refusal_code` and `refusal_layer` (`SERVER` |
 * `AGENT_LIMITS` | `TOOLSET_RULES`). Such a row reached no provider and
 * served nothing, so it has no pricing mode, classification, binding or
 * provider, and its tool may be one that does not exist. Two additions the
 * spec does not list, both for the refused-call view: `tool_name` (the name
 * the agent asked for) and `refusal_detail` (each provider's reason and
 * source on `NO_PROVIDER_MATCHES_RULES`). The free-quota counts read only
 * rows with no refusal.
 *
 * ## `agent_connect_urls`
 *
 * Bookkeeping, not a connection: which canonical URLs the Connect sheet gave
 * an agent, for "Waiting for first call" and the remembered client tab.
 * Nothing is enforced from it.
 */
export class CallAttributionAndConnectUrls1761000000003 implements MigrationInterface {
  name = 'CallAttributionAndConnectUrls1761000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['payment_intents', 'tool_call_records']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "endpoint_kind"   varchar(12) NULL,
          ADD COLUMN "toolset_id"      uuid        NULL,
          ADD COLUMN "toolset_version" integer     NULL,
          ADD COLUMN "endpoint_handle" varchar(24) NULL,
          ADD COLUMN "view_filter"     jsonb       NULL,
          ADD CONSTRAINT "chk_${table}_endpoint_kind"
            CHECK ("endpoint_kind" IS NULL
                   OR "endpoint_kind" IN ('ROOT', 'HANDLE', 'CATEGORY', 'TOOLSET'))
      `);
    }

    await queryRunner.query(`
      ALTER TABLE "tool_call_records"
        ADD COLUMN "refusal_code"   varchar(48)  NULL,
        ADD COLUMN "refusal_layer"  varchar(16)  NULL,
        ADD COLUMN "refusal_detail" jsonb        NULL,
        ADD COLUMN "tool_name"      varchar(128) NULL,
        ALTER COLUMN "tool_id"        DROP NOT NULL,
        ALTER COLUMN "pricing_mode"   DROP NOT NULL,
        ALTER COLUMN "classification" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "tool_call_records"
        DROP CONSTRAINT "chk_tool_call_records_pricing_mode",
        ADD CONSTRAINT "chk_tool_call_records_pricing_mode"
          CHECK ("pricing_mode" IS NULL OR "pricing_mode" IN ('FREE', 'FREEMIUM', 'PAID')),
        ADD CONSTRAINT "chk_tool_call_records_refusal_layer"
          CHECK ("refusal_layer" IS NULL
                 OR "refusal_layer" IN ('SERVER', 'AGENT_LIMITS', 'TOOLSET_RULES')),
        ADD CONSTRAINT "chk_tool_call_records_refusal_pair"
          CHECK (("refusal_code" IS NULL) = ("refusal_layer" IS NULL)),
        ADD CONSTRAINT "chk_tool_call_records_served_shape"
          CHECK ("refusal_code" IS NOT NULL
                 OR ("tool_id" IS NOT NULL
                     AND "pricing_mode" IN ('FREE', 'FREEMIUM')
                     AND "classification" IS NOT NULL))
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tool_call_records_refused_feed"
        ON "tool_call_records" ("organization_id", "created_at", "id")
        WHERE "refusal_code" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "agent_connect_urls" (
        "agent_id"        uuid           NOT NULL,
        "organization_id" uuid           NOT NULL,
        "canonical_url"   varchar(2048)  NOT NULL,
        "server_name"     varchar(9)     NULL,
        "client"          varchar(24)    NULL,
        "created_at"      timestamptz    NOT NULL DEFAULT now(),
        "first_call_at"   timestamptz    NULL,
        CONSTRAINT "pk_agent_connect_urls" PRIMARY KEY ("agent_id", "canonical_url"),
        CONSTRAINT "chk_agent_connect_urls_server_name"
          CHECK ("server_name" IS NULL OR "server_name" ~ '^[a-z][a-z0-9_-]{0,8}$')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_agent_connect_urls_organization" ON "agent_connect_urls" ("organization_id", "agent_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "agent_connect_urls"`);
    // Refused rows cannot satisfy the old NOT NULLs; they go with the columns.
    await queryRunner.query(`DELETE FROM "tool_call_records" WHERE "refusal_code" IS NOT NULL`);
    await queryRunner.query(`DROP INDEX "idx_tool_call_records_refused_feed"`);
    await queryRunner.query(`
      ALTER TABLE "tool_call_records"
        DROP CONSTRAINT "chk_tool_call_records_served_shape",
        DROP CONSTRAINT "chk_tool_call_records_refusal_pair",
        DROP CONSTRAINT "chk_tool_call_records_refusal_layer",
        DROP CONSTRAINT "chk_tool_call_records_pricing_mode",
        ADD CONSTRAINT "chk_tool_call_records_pricing_mode"
          CHECK ("pricing_mode" IN ('FREE', 'FREEMIUM')),
        ALTER COLUMN "classification" SET NOT NULL,
        ALTER COLUMN "pricing_mode"   SET NOT NULL,
        ALTER COLUMN "tool_id"        SET NOT NULL,
        DROP COLUMN "tool_name",
        DROP COLUMN "refusal_detail",
        DROP COLUMN "refusal_layer",
        DROP COLUMN "refusal_code"
    `);
    for (const table of ['tool_call_records', 'payment_intents']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP CONSTRAINT "chk_${table}_endpoint_kind",
          DROP COLUMN "view_filter",
          DROP COLUMN "endpoint_handle",
          DROP COLUMN "toolset_version",
          DROP COLUMN "toolset_id",
          DROP COLUMN "endpoint_kind"
      `);
    }
  }
}
