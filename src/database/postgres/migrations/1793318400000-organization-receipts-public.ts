import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `organizations.receipts_public`: whether the public receipt page
 * (`GET /public/receipts/:id`) may answer for this organization's calls.
 *
 * Public by default (owner decision 2026-10-29): `DEFAULT true` also covers the
 * rows that exist today. A buyer can turn it off in Settings; a hidden receipt
 * then answers 404, the same as one that does not exist.
 */
export class OrganizationReceiptsPublic1793318400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "receipts_public" boolean NOT NULL DEFAULT true`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN IF EXISTS "receipts_public"`);
  }
}
