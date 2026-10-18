import { Injectable } from '@nestjs/common';

import { ToolCallRecordEntity } from '@database/postgres/entities/tool-call-record.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import { RefusalLayer } from '../domain/attribution';
import { EndpointKind } from '../domain/mcp-url';
import {
  ListRefusedCallsQueryDto,
  RefusedCallDetailsDto,
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
  constructor(
    private readonly records: ToolCallRecordRepository,
    private readonly providers: ProviderRepository,
  ) {}

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
    const names = await this.providerNames(page.items);
    return page.map((row) => toDto(row, names));
  }

  async get(organizationId: string, callId: string): Promise<RefusedCallDto> {
    const row = await this.records.findOneBy({ organizationId, callId });
    if (!row || !row.refusalCode) throw ToolsetErrors.refusedCallNotFound();
    return toDto(row, await this.providerNames([row]));
  }

  /** One read for every provider the rows name, by id. */
  private providerNames(rows: readonly ToolCallRecordEntity[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const row of rows) for (const provider of providersOf(row)) ids.add(provider.providerId);
    return this.providers.findDisplayNames([...ids]);
  }
}

function providersOf(row: ToolCallRecordEntity): Omit<RefusedProviderDto, 'providerName'>[] {
  const providers = row.refusalDetail?.providers;
  return Array.isArray(providers) ? (providers as Omit<RefusedProviderDto, 'providerName'>[]) : [];
}

/** The structured details a refusal code carries (only CONTRACT_VERSION_RETIRED so far). */
function detailsOf(row: ToolCallRecordEntity): RefusedCallDetailsDto {
  if (row.refusalCode !== ToolAccessErrorCode.CONTRACT_VERSION_RETIRED) return {};
  const tool = row.refusalDetail?.replacementTool as Record<string, unknown> | null | undefined;
  const label = row.refusalDetail?.replacement;
  if (!tool || typeof tool.toolId !== 'string' || typeof tool.name !== 'string') {
    return { replacement: null };
  }
  return {
    replacement: {
      toolId: tool.toolId,
      name: tool.name,
      major: typeof tool.major === 'number' ? tool.major : null,
      semver: typeof tool.semver === 'string' ? tool.semver : null,
      label: typeof label === 'string' ? label : tool.name,
    },
  };
}

function toDto(row: ToolCallRecordEntity, names: ReadonlyMap<string, string>): RefusedCallDto {
  const providers = providersOf(row).map((provider) => ({
    ...provider,
    providerName: names.get(provider.providerId) ?? null,
  }));
  return {
    callId: row.callId,
    agentId: row.agentId,
    toolId: row.toolId,
    toolName: row.toolName,
    refusalCode: row.refusalCode as string,
    refusalLayer: row.refusalLayer as RefusalLayer,
    charged: false,
    providers,
    details: detailsOf(row),
    endpointKind: (row.endpointKind as EndpointKind | null) ?? null,
    toolsetId: row.toolsetId,
    toolsetVersion: row.toolsetVersion,
    viewFilter: row.viewFilter,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
