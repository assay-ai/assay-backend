import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { assertNoReservedToolNames } from '@modules/tool/domain/reserved-tool-names';

import { ToolEntity } from '../entities/tool.entity';
import { AbstractRepository } from './abstract.repository';

/** The upsert's shape: identity plus the fields the seed owns. */
export interface ToolSeedRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
  /** Version 1.0.0 of the contract, which the seed owns (design spec §11.2). */
  readonly version?: ToolSeedVersion;
}

/** The seeded contract, written as `tool_versions` version 1 (`1.0.0`, ACTIVE). */
export interface ToolSeedVersion {
  readonly summary: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly optionalInputFields: readonly string[];
  readonly optionalOutputFields: readonly string[];
  readonly examples: readonly unknown[];
  readonly verificationPolicyId: string | null;
  readonly tier: string | null;
}

/**
 * `tools`. Not organization-scoped: a STANDARD tool is the platform's, and
 * reading the catalogue is the same answer for every tenant.
 */
@Injectable()
export class ToolRepository extends AbstractRepository<ToolEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolEntity, dataSource);
  }

  /**
   * Insert or refresh the seeded STANDARD tools, in one statement.
   *
   * `ON CONFLICT (id)` rather than by name: the id is what bindings reference,
   * so a renamed tool keeps its bindings. Kind, visibility and status are
   * written only on insert — an operator action on an existing row (a status
   * change) is not undone by the next boot.
   */
  async upsertSeeded(rows: readonly ToolSeedRow[]): Promise<void> {
    if (rows.length === 0) return;
    assertNoReservedToolNames(
      rows.map((row) => row.name),
      'tools upsert',
    );

    const values: unknown[] = [];
    const tuples = rows.map((row, index) => {
      const base = index * 4;
      values.push(row.id, row.name, row.category, [...row.tags]);
      return `($${base + 1}::uuid, $${base + 2}, 'STANDARD', $${base + 3}, $${base + 4}::text[], 'LISTED', 'ACTIVE')`;
    });

    await this.query(
      `INSERT INTO "tools" ("id", "name", "kind", "category", "tags", "visibility", "status")
       VALUES ${tuples.join(', ')}
       ON CONFLICT ("id") DO UPDATE
         SET "name" = EXCLUDED."name",
             "category" = EXCLUDED."category",
             "tags" = EXCLUDED."tags",
             "updated_at" = now()`,
      values,
    );

    const versioned = rows.filter((row) => row.version);
    if (versioned.length === 0) return;
    await this.upsertSeededVersions(versioned);
  }

  /**
   * Version 1.0.0 of each seeded contract, refreshed from the seed on every
   * boot: the seed owns version 1 of a seeded tool (local runs and tests,
   * §13 D4). Every later version is the operator editor's. A tool with no
   * current version is pointed at it.
   */
  private async upsertSeededVersions(rows: readonly ToolSeedRow[]): Promise<void> {
    const values: unknown[] = [];
    const tuples = rows.map((row, index) => {
      const v = row.version as ToolSeedVersion;
      const base = index * 10;
      values.push(
        row.id,
        v.summary,
        v.description,
        JSON.stringify(v.inputSchema),
        JSON.stringify(v.outputSchema),
        [...v.optionalInputFields],
        [...v.optionalOutputFields],
        JSON.stringify(v.examples),
        v.verificationPolicyId,
        v.tier,
      );
      const p = (n: number) => `$${base + n}`;
      return (
        `(${p(1)}::uuid, 1, '1.0.0', 1, ${p(2)}, ${p(3)}, ${p(4)}::jsonb, ${p(5)}::jsonb, ` +
        `${p(6)}::text[], ${p(7)}::text[], ${p(8)}::jsonb, ${p(9)}, ${p(10)}, 'ACTIVE', now())`
      );
    });

    await this.query(
      `INSERT INTO "tool_versions"
         ("tool_id", "version", "semver", "major", "summary", "description", "input_schema",
          "output_schema", "optional_input_fields", "optional_output_fields", "examples",
          "verification_policy_id", "tier", "status", "published_at")
       VALUES ${tuples.join(', ')}
       ON CONFLICT ("tool_id", "version") DO UPDATE
         SET "summary" = EXCLUDED."summary",
             "description" = EXCLUDED."description",
             "input_schema" = EXCLUDED."input_schema",
             "output_schema" = EXCLUDED."output_schema",
             "optional_input_fields" = EXCLUDED."optional_input_fields",
             "optional_output_fields" = EXCLUDED."optional_output_fields",
             "examples" = EXCLUDED."examples",
             "verification_policy_id" = EXCLUDED."verification_policy_id",
             "tier" = EXCLUDED."tier",
             "updated_at" = now()`,
      values,
    );
    await this.query(
      `UPDATE "tools" SET "current_version" = 1, "updated_at" = now()
        WHERE "id" = ANY($1::uuid[]) AND "current_version" IS NULL`,
      [rows.map((row) => row.id)],
    );
  }

  /**
   * A new STANDARD tool with no published version: status DRAFT, in no
   * catalogue until its first version is published (design spec §7.5). The
   * name is refused by `uq_tools_name` when taken.
   */
  async insertDraft(input: {
    readonly name: string;
    readonly category: string;
    readonly tags: readonly string[];
  }): Promise<ToolEntity> {
    assertNoReservedToolNames([input.name], 'tools insert');
    const [row] = (await this.query(
      `INSERT INTO "tools" ("id", "name", "kind", "category", "tags", "visibility", "status")
       VALUES (gen_random_uuid(), $1, 'STANDARD', $2, $3::text[], 'LISTED', 'DRAFT')
       RETURNING "id"`,
      [input.name, input.category, [...input.tags]],
    )) as { id: string }[];
    return (await this.findOne({ where: { id: row.id } })) as ToolEntity;
  }

  /** `base`, or `base_2`, `base_3` … — the first name no tool holds. */
  async freeName(base: string): Promise<string> {
    const rows = (await this.query(`SELECT "name" FROM "tools" WHERE "name" LIKE $1`, [
      `${base.replace(/[%_]/g, (c) => `\\${c}`)}%`,
    ])) as { name: string }[];
    const taken = new Set(rows.map((row) => row.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const suffix = `_${n}`;
      const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async findByIds(ids: readonly string[]): Promise<ToolEntity[]> {
    if (ids.length === 0) return [];
    return this.find({ where: { id: In([...ids]) } });
  }
}
