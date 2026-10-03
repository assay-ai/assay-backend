import { Injectable } from '@nestjs/common';

import { ToolRequestEntity } from '@database/postgres/entities/tool-request.entity';
import { ToolRequestRepository } from '@database/postgres/repositories/tool-request.repository';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import {
  CreateToolRequestBodyDto,
  ListToolRequestsQueryDto,
  ToolRequestDto,
} from '../dto/tool-request.dto';
import { computeFirstResponseDueAt } from '../domain/working-days';
import { ToolRequestStatus } from '../domain/tool-request-state';
import { ToolRequestErrors } from '../errors/tool-request.errors';

const REQUESTER_LIST: ListSpec = {
  alias: 'request',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'request.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: ToolRequestEntity) => row.createdAt),
    },
  },
};

/**
 * The requester's own side of the tool request queue, MVP slice.
 *
 * File a ticket, read your own tickets back. Nothing here reviews a schema or
 * moves a status: this service only ever writes `status = 'OPEN'`, and every
 * later transition belongs to `ToolRequestQueueService`, the operator side.
 * That split mirrors `SlashProposalService` (opens cases, never decides them)
 * versus `ArbitrationService` (decides, never opens).
 */
@Injectable()
export class ToolRequestService {
  constructor(private readonly requests: ToolRequestRepository) {}

  /**
   * `POST /tool-requests`.
   *
   * `organization_id` here is the caller's own tenant — unlike
   * `payment_intents`, where it is the payer's — so this is an ordinary
   * organization-scoped insert, no tautology needed to satisfy the guard.
   */
  async file(
    organizationId: string,
    agentId: string | null,
    body: CreateToolRequestBodyDto,
  ): Promise<ToolRequestDto> {
    const now = new Date();

    const entity = new ToolRequestEntity();
    entity.organizationId = organizationId;
    entity.requestedByAgentId = agentId;
    entity.title = body.title;
    entity.description = body.description;
    entity.upstreamUrl = body.upstreamUrl ?? null;
    entity.expectedMonthlyCalls = body.expectedMonthlyCalls ?? null;
    entity.status = ToolRequestStatus.OPEN;
    entity.ownerOperatorId = null;
    entity.firstResponseDueAt = computeFirstResponseDueAt(now);
    entity.firstRespondedAt = null;
    entity.resolutionNote = null;
    entity.closedAt = null;

    const saved = await this.requests.save(entity);
    return ToolRequestDto.fromEntity(saved);
  }

  async list(
    organizationId: string,
    query: ListToolRequestsQueryDto,
  ): Promise<CursorPageDto<ToolRequestDto>> {
    const qb = this.requests
      .createQueryBuilder('request')
      .where('request.organizationId = :organizationId', { organizationId });

    const page = await paginate(qb, query, REQUESTER_LIST);
    return page.map((row) => ToolRequestDto.fromEntity(row));
  }

  /** `GET /tool-requests/:id`. Cross-tenant id or no such row — both 404. */
  async get(organizationId: string, id: string): Promise<ToolRequestDto> {
    const entity = await this.requests.findOneScoped(organizationId, id);
    if (!entity) throw ToolRequestErrors.notFound({ id });
    return ToolRequestDto.fromEntity(entity);
  }
}
