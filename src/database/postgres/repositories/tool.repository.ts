import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { ToolEntity } from '../entities/tool.entity';
import { AbstractRepository } from './abstract.repository';

/** The upsert's shape: identity plus the fields the seed owns. */
export interface ToolSeedRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
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
  }

  async findByIds(ids: readonly string[]): Promise<ToolEntity[]> {
    if (ids.length === 0) return [];
    return this.find({ where: { id: In([...ids]) } });
  }
}
