import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agent_connect_urls.server_name` grows from 9 to 56 characters (spec 8.3.1,
 * O5): the name is free-form within a per-URL length budget that the Connect
 * UI and `assay-mcp add` check, so storage only carries the pattern and the
 * 56-character bound. The check constraint drops `_` (it would blur the `__`
 * separator of the client tool prefix) and widens with the column.
 */
export class ConnectUrlServerName1762400000030 implements MigrationInterface {
  name = 'ConnectUrlServerName1762400000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_connect_urls" DROP CONSTRAINT "chk_agent_connect_urls_server_name"`,
    );
    // Rows from before this migration may hold `_`, which the new pattern refuses.
    await queryRunner.query(
      `UPDATE "agent_connect_urls" SET "server_name" = NULL WHERE "server_name" ~ '_'`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_connect_urls" ALTER COLUMN "server_name" TYPE varchar(56)`,
    );
    await queryRunner.query(`
      ALTER TABLE "agent_connect_urls"
        ADD CONSTRAINT "chk_agent_connect_urls_server_name"
        CHECK ("server_name" IS NULL OR "server_name" ~ '^[a-z][a-z0-9-]{0,55}$')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_connect_urls" DROP CONSTRAINT "chk_agent_connect_urls_server_name"`,
    );
    // A name longer than the old 9-character bound cannot be kept.
    await queryRunner.query(
      `UPDATE "agent_connect_urls" SET "server_name" = NULL WHERE length("server_name") > 9`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_connect_urls" ALTER COLUMN "server_name" TYPE varchar(9)`,
    );
    await queryRunner.query(`
      ALTER TABLE "agent_connect_urls"
        ADD CONSTRAINT "chk_agent_connect_urls_server_name"
        CHECK ("server_name" IS NULL OR "server_name" ~ '^[a-z][a-z0-9_-]{0,8}$')
    `);
  }
}
