import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `expires_at` indexes for the OAuth cleanup job's daily deletes (spec §6.2).
 *
 * Without them each delete is a sequential scan, and `oauth_access_tokens` is
 * the high-volume table (one row per hour per active grant).
 */
export class OAuthExpiryIndexes1762400000012 implements MigrationInterface {
  name = 'OAuthExpiryIndexes1762400000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_access_tokens_expires" ON "oauth_access_tokens" ("expires_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_refresh_tokens_expires" ON "oauth_refresh_tokens" ("expires_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_oauth_authorization_codes_expires" ` +
        `ON "oauth_authorization_codes" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_oauth_authorization_codes_expires"`);
    await queryRunner.query(`DROP INDEX "idx_oauth_refresh_tokens_expires"`);
    await queryRunner.query(`DROP INDEX "idx_oauth_access_tokens_expires"`);
  }
}
