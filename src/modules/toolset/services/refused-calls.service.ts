import { Injectable } from '@nestjs/common';

import { ToolCallRecordEntity } from '@database/postgres/entities/tool-call-record.entity';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import { RefusalLayer } from '../domain/attribution';
import { EndpointKind } from '../domain/mcp-url';
import {
  ListRefusedCallsQueryDto,
  RefusedCallDto,
  RefusedProviderDto,
} from '../dto/refused-call.dto';
import { ToolsetErrors } from '../errors/toolset.errors';

const REFUSED_LIST: ListSpec = {
  alias: 'record',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'record.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: ToolCallRecordEntity) => row.createdAt),
    },
  },
};

/** The refused calls of the organization, newest first — the Calls page's "Refused" filter. */
@Injectable()
export class RefusedCallsService {
  constructor(private readonly records: ToolCallRecordRepository) {}

  async list(
    organizationId: string,
    query: ListRefusedCallsQueryDto,
  ): Promise<CursorPageDto<RefusedCallDto>> {
    const qb = this.records
      .createQueryBuilder('record')
      .where('record.organization_id = :organizationId', { organizationId })
      .andWhere('record.refusal_code IS NOT NULL');
    if (query.agentId) qb.andWhere('record.agent_id = :agentId', { agentId: query.agentId });

    const page = await paginate(qb, query, REFUSED_LIST);
    return page.map(toDto);
  }

  async get(organizationId: string, callId: string): Promise<RefusedCallDto> {
    const row = await this.records.findOneBy({ organizationId, callId });
    if (!row || !row.refusalCode) throw ToolsetErrors.refusedCallNotFound();
    return toDto(row);
  }
}

function toDto(row: ToolCallRecordEntity): RefusedCallDto {
  const providers = (row.refusalDetail?.providers as RefusedProviderDto[] | undefined) ?? [];
  return {
    callId: row.callId,
    agentId: row.agentId,
    toolId: row.toolId,
    toolName: row.toolName,
    refusalCode: row.refusalCode as string,
    refusalLayer: row.refusalLayer as RefusalLayer,
    charged: false,
    providers,
    endpointKind: (row.endpointKind as EndpointKind | null) ?? null,
    toolsetId: row.toolsetId,
    toolsetVersion: row.toolsetVersion,
    viewFilter: row.viewFilter,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
