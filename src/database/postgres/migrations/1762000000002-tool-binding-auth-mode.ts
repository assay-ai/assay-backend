import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How a binding authenticates to the provider's endpoint. A descriptive
 * setting, not a contract term: it is not part of a binding revision.
 */
export class ToolBindingAuthMode1762000000002 implements MigrationInterface {
  name = 'ToolBindingAuthMode1762000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tool_bindings"
        ADD COLUMN "auth_mode" varchar(16) NOT NULL DEFAULT 'NONE',
        ADD CONSTRAINT "ck_tool_bindings_auth_mode"
          CHECK ("auth_mode" IN ('NONE', 'API_KEY', 'SIGNATURE', 'BOTH'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tool_bindings"
        DROP CONSTRAINT "ck_tool_bindings_auth_mode",
        DROP COLUMN "auth_mode"
    `);
  }
}
