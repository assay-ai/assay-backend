import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the two-person publish needs to approve content, not a number
 * (design spec §7.5, review P1-1):
 *
 * - `tools.last_version_number`: the highest version number ever handed out
 *   for the tool, discarded drafts included, so a number is never reused.
 * - `tool_versions.edited_by`: the operator who last saved a draft; they may
 *   not be the second person who approves its publish.
 */
export class ToolDraftIntegrity1761600000000 implements MigrationInterface {
  name = 'ToolDraftIntegrity1761600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
        ADD COLUMN "last_version_number" integer NOT NULL DEFAULT 0,
        ADD CONSTRAINT "chk_tools_last_version_number" CHECK ("last_version_number" >= 0)
    `);
    await queryRunner.query(`
      UPDATE "tools" t SET "last_version_number" = v.highest
        FROM (SELECT "tool_id", max("version") AS highest FROM "tool_versions" GROUP BY "tool_id") v
       WHERE v."tool_id" = t."id"
    `);
    await queryRunner.query(`ALTER TABLE "tool_versions" ADD COLUMN "edited_by" uuid NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tool_versions" DROP COLUMN "edited_by"`);
    await queryRunner.query(`
      ALTER TABLE "tools"
        DROP CONSTRAINT "chk_tools_last_version_number",
        DROP COLUMN "last_version_number"
    `);
  }
}
