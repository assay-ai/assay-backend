import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The second contact (`owner_contact`) is optional at registration.
 *
 * It is an escalation contact only: nothing reads it for sign-in, recovery,
 * payouts or approvals. A solo developer could not register without inventing
 * a second person, so registration no longer asks for one. It is required
 * before the provider publishes a PAID listing instead (`SECOND_CONTACT` in the
 * binding publish gate), and is added later through
 * `PATCH /providers/me/registration`.
 *
 * `down` cannot restore NOT NULL while rows without a second contact exist, so
 * it refuses rather than inventing one.
 */
export class ProviderOwnerContactOptional1762400000140 implements MigrationInterface {
  name = 'ProviderOwnerContactOptional1762400000140';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "providers" ALTER COLUMN "owner_contact" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "providers" ALTER COLUMN "owner_contact" SET NOT NULL`);
  }
}
