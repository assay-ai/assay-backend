import { MigrationInterface, QueryRunner } from 'typeorm';

import { VERSION_RANGE_SQL } from './1761500000000-tool-versions';

/**
 * What a binding promises about the contract (design spec §7.2, §7.5, T3):
 *
 * - `tool_bindings` and their `binding_versions` snapshots gain the contract
 *   majors served (`tool_version_range`, default `^1`) and the optional
 *   fields declared (`provides_output_fields`, `supports_input_fields`).
 *   They are terms of the revision: the snapshot records them, and routing
 *   serves the published revision's.
 * - `binding_test_runs.tool_version`: which contract version a tester run
 *   checked, so the publish gate can ask for a green run per major.
 *
 * Separate from `tool_versions` so a schema with bindings but no `tools`
 * table (the binding editor's own test context) can carry it.
 */
export class BindingContractTerms1761500000001 implements MigrationInterface {
  name = 'BindingContractTerms1761500000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['tool_bindings', 'binding_versions']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "tool_version_range" varchar(32) NOT NULL DEFAULT '^1',
          ADD COLUMN "provides_output_fields" text[] NOT NULL DEFAULT '{}',
          ADD COLUMN "supports_input_fields" text[] NOT NULL DEFAULT '{}',
          ADD CONSTRAINT "chk_${table}_tool_version_range"
            CHECK ("tool_version_range" ~ ${VERSION_RANGE_SQL})
      `);
    }
    await queryRunner.query(
      `ALTER TABLE "binding_test_runs" ADD COLUMN "tool_version" integer NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "binding_test_runs" DROP COLUMN "tool_version"`);
    for (const table of ['binding_versions', 'tool_bindings']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP CONSTRAINT "chk_${table}_tool_version_range",
          DROP COLUMN "supports_input_fields",
          DROP COLUMN "provides_output_fields",
          DROP COLUMN "tool_version_range"
      `);
    }
  }
}
