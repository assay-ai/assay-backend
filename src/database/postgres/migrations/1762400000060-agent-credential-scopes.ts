import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent key scopes are enforced and every API key expires.
 *
 * 1. `scopes` becomes a permission (`AgentScope`), so every row gets the
 *    scopes it would get if created today: an API key and a grant of the
 *    built-in `assay-mcp` client `tools:call payments activity:read`, any
 *    other OAuth grant `tools:call`. Before this, scopes were labels nothing
 *    read (the buyer UI wrote `{tools:call}`), so they are overwritten, not
 *    interpreted.
 * 2. An API key with no expiry, or one further away than the 365-day maximum,
 *    gets the 90-day default / the maximum from now. OAuth rows keep theirs
 *    (their refresh lifetime).
 *
 * Not in production: no compatibility path is kept.
 */
export class AgentCredentialScopes1762400000060 implements MigrationInterface {
  name = 'AgentCredentialScopes1762400000060';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "agent_credentials" SET "scopes" = ARRAY['tools:call','payments','activity:read']::text[] ` +
        `WHERE "issued_via" = 'API_KEY'`,
    );
    await queryRunner.query(
      `UPDATE "agent_credentials" AS "c" SET "scopes" = CASE WHEN "o"."kind" = 'BUILTIN' ` +
        `THEN ARRAY['tools:call','payments','activity:read']::text[] ` +
        `ELSE ARRAY['tools:call']::text[] END ` +
        `FROM "oauth_clients" AS "o" ` +
        `WHERE "c"."issued_via" = 'OAUTH' AND "o"."id" = "c"."oauth_client_id"`,
    );
    await queryRunner.query(
      `UPDATE "agent_credentials" SET "expires_at" = now() + interval '90 days' ` +
        `WHERE "issued_via" = 'API_KEY' AND "expires_at" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agent_credentials" SET "expires_at" = now() + interval '365 days' ` +
        `WHERE "issued_via" = 'API_KEY' AND "expires_at" > now() + interval '365 days'`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Scopes and expiries were overwritten, not interpreted: nothing to restore.
  }
}
