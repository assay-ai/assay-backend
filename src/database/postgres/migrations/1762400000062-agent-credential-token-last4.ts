import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agent_credentials.prefix` (the first 20 characters, 6 of them random) is
 * replaced by `token_last4`: the token's last 4 characters, the only part of
 * a key we keep in clear, shown as `assay_sk_live_…2fds`. The fixed
 * `assay_sk_live_` part is not stored — every key has it.
 *
 * Existing rows get `NULL`: their plaintext is unknown, and nothing reads the
 * old prefix. `ck_agent_credentials_issued_via` no longer requires the hint
 * for an API key (an older key has none) but still forbids one on a grant.
 */
export class AgentCredentialTokenLast41762400000062 implements MigrationInterface {
  name = 'AgentCredentialTokenLast41762400000062';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "ck_agent_credentials_issued_via"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_credentials_prefix"`);
    await queryRunner.query(`ALTER TABLE "agent_credentials" DROP COLUMN "prefix"`);
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD COLUMN "token_last4" varchar(4) NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        ADD CONSTRAINT "ck_agent_credentials_token_last4"
          CHECK ("token_last4" IS NULL OR char_length("token_last4") = 4),
        ADD CONSTRAINT "ck_agent_credentials_issued_via" CHECK (
          ("issued_via" = 'API_KEY' AND "token_hash" IS NOT NULL AND "oauth_client_id" IS NULL) OR
          ("issued_via" = 'OAUTH' AND "token_hash" IS NULL AND "token_last4" IS NULL
             AND "oauth_client_id" IS NOT NULL)
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "ck_agent_credentials_issued_via"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "ck_agent_credentials_token_last4"`,
    );
    await queryRunner.query(`ALTER TABLE "agent_credentials" DROP COLUMN IF EXISTS "token_last4"`);
    await queryRunner.query(`ALTER TABLE "agent_credentials" ADD COLUMN "prefix" varchar(24) NULL`);
    // The old prefix cannot be recovered; give API keys the fixed part so the old check holds.
    await queryRunner.query(
      `UPDATE "agent_credentials" SET "prefix" = 'assay_sk_live_' WHERE "issued_via" = 'API_KEY'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_prefix" ON "agent_credentials" ("organization_id", "prefix")`,
    );
    await queryRunner.query(`
      ALTER TABLE "agent_credentials"
        ADD CONSTRAINT "ck_agent_credentials_issued_via" CHECK (
          ("issued_via" = 'API_KEY' AND "token_hash" IS NOT NULL AND "prefix" IS NOT NULL
             AND "oauth_client_id" IS NULL) OR
          ("issued_via" = 'OAUTH' AND "token_hash" IS NULL AND "prefix" IS NULL
             AND "oauth_client_id" IS NOT NULL)
        )
    `);
  }
}
