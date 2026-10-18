import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The OAuth authorization server's data model (buyer MCP onboarding, Part 1).
 *
 * OAuth only changes how a credential is obtained. A grant is one
 * `agent_credentials` row, with the same limits, narrowing, revocation and
 * audit as an API key; it differs only in having no bearer token of its own.
 * Its tokens live in `oauth_access_tokens` and `oauth_refresh_tokens`, and
 * `ck_agent_credentials_issued_via` keeps the two kinds of row apart: an API
 * key has a token hash and a prefix and no OAuth client, a grant has an OAuth
 * client and neither of the others.
 *
 * Every token and code is stored as a SHA-256 hex digest only. There is no
 * signing or encryption key to provision: tokens are opaque.
 *
 * `oauth_clients` and `oauth_authorization_codes` are platform-wide (a client
 * is not any one tenant's, and a code is looked up before its tenant is
 * known). The token tables carry `organization_id` like every business table.
 *
 * No `BUILTIN` client row is seeded here: its `client_id` is a URL under
 * `MCP_PUBLIC_URL`, so the server upserts it at boot. No backfill: existing
 * credentials take `issued_via = 'API_KEY'` from the column default.
 */
export class OAuth1762400000000 implements MigrationInterface {
  name = 'OAuth1762400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── oauth_clients ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "oauth_clients" (
        "id"            uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"    timestamptz   NOT NULL DEFAULT now(),
        "updated_at"    timestamptz   NOT NULL DEFAULT now(),
        "version"       integer       NOT NULL DEFAULT 1,
        "client_id"     varchar(512)  NOT NULL,
        "kind"          varchar(8)    NOT NULL,
        "client_name"   varchar(64)   NOT NULL,
        "client_uri"    varchar(512)  NULL,
        "redirect_uris" text[]        NOT NULL,
        "metadata"      jsonb         NOT NULL,
        "fetched_at"    timestamptz   NULL,
        "cache_until"   timestamptz   NULL,
        "last_used_at"  timestamptz   NULL,
        CONSTRAINT "pk_oauth_clients" PRIMARY KEY ("id"),
        CONSTRAINT "chk_oauth_clients_kind" CHECK ("kind" IN ('CIMD', 'DCR', 'BUILTIN'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_oauth_clients_client_id" ON "oauth_clients" ("client_id")`,
    );

    // ── agent_credentials ────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        ADD COLUMN "issued_via" varchar(16) NOT NULL DEFAULT 'API_KEY',
        ADD COLUMN "oauth_client_id" uuid NULL,
        ALTER COLUMN "prefix" DROP NOT NULL,
        ALTER COLUMN "token_hash" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        ADD CONSTRAINT "fk_agent_credentials_oauth_client"
          FOREIGN KEY ("oauth_client_id") REFERENCES "oauth_clients" ("id") ON DELETE RESTRICT,
        ADD CONSTRAINT "chk_agent_credentials_issued_via_kind"
          CHECK ("issued_via" IN ('API_KEY', 'OAUTH')),
        ADD CONSTRAINT "ck_agent_credentials_issued_via" CHECK (
          ("issued_via" = 'API_KEY' AND "token_hash" IS NOT NULL AND "prefix" IS NOT NULL
             AND "oauth_client_id" IS NULL) OR
          ("issued_via" = 'OAUTH' AND "token_hash" IS NULL AND "prefix" IS NULL
             AND "oauth_client_id" IS NOT NULL)
        )
    `);
    // The 50-live-grants-per-agent cap counts through this index.
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_oauth_live" ON "agent_credentials" ("agent_id") ` +
        `WHERE "issued_via" = 'OAUTH' AND "revoked_at" IS NULL`,
    );
    // Postgres does not index FK columns: without this, every client delete's
    // RESTRICT check (and the cleanup job's "still referenced?") scans the table.
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_oauth_client" ON "agent_credentials" ("oauth_client_id") ` +
        `WHERE "oauth_client_id" IS NOT NULL`,
    );

    // ── oauth_authorization_codes ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "oauth_authorization_codes" (
        "id"                      uuid           NOT NULL DEFAULT gen_random_uuid(),
        "created_at"              timestamptz    NOT NULL DEFAULT now(),
        "updated_at"              timestamptz    NOT NULL DEFAULT now(),
        "version"                 integer        NOT NULL DEFAULT 1,
        "code_hash"               varchar(64)    NOT NULL,
        "oauth_client_id"         uuid           NOT NULL,
        "organization_id"         uuid           NOT NULL,
        "agent_id"                uuid           NOT NULL,
        "credential_name"         varchar(128)   NOT NULL,
        "replaces_credential_id"  uuid           NULL,
        "approved_by"             varchar(128)   NOT NULL,
        "redirect_uri"            varchar(2048)  NOT NULL,
        "code_challenge"          varchar(64)    NOT NULL,
        "scope"                   varchar(128)   NOT NULL,
        "resource"                varchar(512)   NOT NULL,
        "expires_at"              timestamptz    NOT NULL,
        "used_at"                 timestamptz    NULL,
        "credential_id"           uuid           NULL,
        CONSTRAINT "pk_oauth_authorization_codes" PRIMARY KEY ("id"),
        CONSTRAINT "fk_oauth_authorization_codes_client"
          FOREIGN KEY ("oauth_client_id") REFERENCES "oauth_clients" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_oauth_authorization_codes_code" ` +
        `ON "oauth_authorization_codes" ("code_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_authorization_codes_client" ` +
        `ON "oauth_authorization_codes" ("oauth_client_id")`,
    );

    // ── oauth_refresh_tokens ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "oauth_refresh_tokens" (
        "id"               uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        "version"          integer       NOT NULL DEFAULT 1,
        "organization_id"  uuid          NOT NULL,
        "credential_id"    uuid          NOT NULL,
        "oauth_client_id"  uuid          NOT NULL,
        "token_hash"       varchar(64)   NOT NULL,
        "parent_id"        uuid          NULL,
        "scope"            varchar(128)  NOT NULL,
        "expires_at"       timestamptz   NOT NULL,
        "used_at"          timestamptz   NULL,
        "revoked_at"       timestamptz   NULL,
        CONSTRAINT "pk_oauth_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "fk_oauth_refresh_tokens_credential"
          FOREIGN KEY ("credential_id") REFERENCES "agent_credentials" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_oauth_refresh_tokens_token" ON "oauth_refresh_tokens" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_refresh_tokens_credential" ON "oauth_refresh_tokens" ("credential_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_refresh_tokens_parent" ON "oauth_refresh_tokens" ("parent_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_refresh_tokens_organization" ON "oauth_refresh_tokens" ("organization_id")`,
    );

    // ── oauth_access_tokens ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "oauth_access_tokens" (
        "id"                uuid          NOT NULL DEFAULT gen_random_uuid(),
        "created_at"        timestamptz   NOT NULL DEFAULT now(),
        "updated_at"        timestamptz   NOT NULL DEFAULT now(),
        "version"           integer       NOT NULL DEFAULT 1,
        "organization_id"   uuid          NOT NULL,
        "credential_id"     uuid          NOT NULL,
        "refresh_token_id"  uuid          NULL,
        "token_hash"        varchar(64)   NOT NULL,
        "scope"             varchar(128)  NOT NULL,
        "audience"          varchar(512)  NOT NULL,
        "expires_at"        timestamptz   NOT NULL,
        "first_used_at"     timestamptz   NULL,
        "revoked_at"        timestamptz   NULL,
        CONSTRAINT "pk_oauth_access_tokens" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_oauth_access_tokens_token" ON "oauth_access_tokens" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_access_tokens_credential" ` +
        `ON "oauth_access_tokens" ("credential_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_access_tokens_organization" ON "oauth_access_tokens" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Credential rows are never deleted (spec §6.2), and the old schema cannot
    // hold a grant: refuse rather than drop grants silently.
    const [{ count }] = (await queryRunner.query(
      `SELECT count(*)::int AS "count" FROM "agent_credentials" WHERE "issued_via" = 'OAUTH'`,
    )) as { count: number }[];
    if (count > 0) {
      throw new Error(
        `Cannot revert OAuth1762400000000: ${count} OAuth credential row(s) exist. ` +
          `Revoke and remove them deliberately first.`,
      );
    }
    await queryRunner.query(`DROP TABLE "oauth_access_tokens"`);
    await queryRunner.query(`DROP TABLE "oauth_refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "oauth_authorization_codes"`);
    await queryRunner.query(`DROP INDEX "idx_agent_credentials_oauth_client"`);
    await queryRunner.query(`DROP INDEX "idx_agent_credentials_oauth_live"`);
    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        DROP CONSTRAINT "ck_agent_credentials_issued_via",
        DROP CONSTRAINT "chk_agent_credentials_issued_via_kind",
        DROP CONSTRAINT "fk_agent_credentials_oauth_client",
        DROP COLUMN "oauth_client_id",
        DROP COLUMN "issued_via",
        ALTER COLUMN "prefix" SET NOT NULL,
        ALTER COLUMN "token_hash" SET NOT NULL
    `);
    await queryRunner.query(`DROP TABLE "oauth_clients"`);
  }
}
