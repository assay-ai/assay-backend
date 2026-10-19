import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `oauth_authorization_codes.reuse_detected_at` (spec §6.3.10, R-OA-6).
 *
 * A replayed code must never leave a live grant, even when the replay lands
 * while the first exchange is still creating its grant. The replay sets this
 * column (compare-and-set on the code row); the first exchange's grant
 * transaction locks the row first and creates nothing when it is set. Once the
 * grant transaction holds the row, a replay's update waits for its commit and
 * then sees `credential_id`, which it revokes.
 */
export class OAuthCodeReuseDetected1762400000013 implements MigrationInterface {
  name = 'OAuthCodeReuseDetected1762400000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "oauth_authorization_codes" ADD COLUMN "reuse_detected_at" timestamptz NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "oauth_authorization_codes" DROP COLUMN "reuse_detected_at"`,
    );
  }
}
