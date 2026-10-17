import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The provider egress IP allowlist is gone: providers authenticate Assay by
 * API key or request signature instead, so a check no longer records the list
 * it published.
 */
export class DropConnectivityEgressIps1762000000000 implements MigrationInterface {
  name = 'DropConnectivityEgressIps1762000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "provider_connectivity_checks" DROP COLUMN "egress_ips"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "provider_connectivity_checks" ADD COLUMN "egress_ips" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }
}
