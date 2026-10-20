import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { ToolVersionEntity } from '../entities/tool-version.entity';
import { AbstractRepository } from './abstract.repository';

/** `tool_versions`. Platform-owned, like `tools`: not organization-scoped. */
@Injectable()
export class ToolVersionRepository extends AbstractRepository<ToolVersionEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolVersionEntity, dataSource);
  }

  /** Every version of these tools, any status. */
  async findByTools(toolIds: readonly string[]): Promise<ToolVersionEntity[]> {
    if (toolIds.length === 0) return [];
    return this.find({ where: { toolId: In([...toolIds]) }, order: { version: 'ASC' } });
  }

  async findVersion(toolId: string, version: number): Promise<ToolVersionEntity | null> {
    return this.findOne({ where: { toolId, version } });
  }
}
