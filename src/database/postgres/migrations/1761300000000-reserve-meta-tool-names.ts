import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `search_tools`, `get_tool` and `call_tool` are the MCP host's meta tools
 * (design spec §7.4): no tool, of either kind, may take one of these names.
 * The seed loader and the `tools` upsert refuse them first; this CHECK is the
 * last line for anything that writes the table directly.
 */
export class ReserveMetaToolNames1761300000000 implements MigrationInterface {
  name = 'ReserveMetaToolNames1761300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
        ADD CONSTRAINT "chk_tools_name_not_reserved"
          CHECK ("name" NOT IN ('search_tools', 'get_tool', 'call_tool'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tools" DROP CONSTRAINT "chk_tools_name_not_reserved"`);
  }
}
