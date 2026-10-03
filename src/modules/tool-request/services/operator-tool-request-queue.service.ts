import { Injectable } from '@nestjs/common';

import { ToolRequestEntity } from '@database/postgres/entities/tool-request.entity';
import { ToolRequestRepository } from '@database/postgres/repositories/tool-request.repository';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import {
  AnswerToolRequestBodyDto,
  ListToolRequestQueueQueryDto,
  OperatorToolRequestQueueRowDto,
  ToolRequestDto,
} from '../dto/tool-request.dto';
import { canTransition, requiresClosure, ToolRequestStatus } from '../domain/tool-request-state';
import { ToolRequestErrors } from '../errors/tool-request.errors';

const QUEUE_LIST: ListSpec = {
  alias: 'request',
  defaultSort: 'firstResponseDueAt',
  sortable: {
    firstResponseDueAt: {
      column: 'request.first_response_due_at',
      type: 'timestamptz',
      valueOf: asInstant((row: ToolRequestEntity) => row.firstResponseDueAt),
    },
  },
  timeColumn: 'request.created_at',
};

/**
 * The operator's side of the tool request queue, MVP slice.
 *
 * Modelled on `AdjudicationQueueService` / `SlashProposalService.acknowledge`,
 * scaled down to what a ticket queue actually needs: a list ordered by the
 * clock, and one write that moves `status` and stamps whichever of the two
 * timestamps the transition requires. There is no arbitration split here —
 * `SlashCaseService` versus `ArbitrationService` exists because opening a case
 * and deciding one are different actors with different incentives; answering
 * a tool request is one actor doing one thing, so it is one service.
 */
@Injectable()
export class ToolRequestQueueService {
  constructor(private readonly requests: ToolRequestRepository) {}

  /**
   * The queue. Cross-organization, like `SlashProposalRepository
   * .queueQueryBuilder` — the caller is a platform operator with no tenant of
   * their own, reached only through `OperatorAuthGuard`.
   */
  async listQueue(
    query: ListToolRequestQueueQueryDto,
  ): Promise<CursorPageDto<OperatorToolRequestQueueRowDto>> {
    const page = await paginate(this.requests.queueQueryBuilder(), query, QUEUE_LIST);
    return page.map((row) => OperatorToolRequestQueueRowDto.fromEntity(row));
  }

  /**
   * `PATCH /operator/tool-requests/:id` — acknowledge, accept or decline.
   *
   * A compare-and-swap against the state read at the top of the call, exactly
   * like `SlashProposalRepository.transitionIfIn`'s other callers: two
   * operators answering the same ticket, or a retried request, must leave one
   * winner rather than two writes landing in either order. `affected === 0`
   * means somebody else already moved it — a race, not a client error, and it
   * is reported as the transition it collided with rather than swallowed.
   *
   * `ownerOperatorId` is set to the acting operator only if the ticket has
   * none yet — the first responder becomes the named owner the queue's copy
   * promises, and a later responder (finishing what a colleague started)
   * does not reassign it out from under them.
   *
   * `firstRespondedAt` is stamped only if it is still null — "set on the first
   * transition and never cleared," per the migration and
   * `requiresFirstResponseStamp`'s docstring.
   */
  async answer(
    operatorId: string,
    id: string,
    body: AnswerToolRequestBodyDto,
  ): Promise<ToolRequestDto> {
    const organizationId = await this.requests.tenantOf(id);
    if (!organizationId) throw ToolRequestErrors.notFound({ id });

    const current = await this.requests.findOneScoped(organizationId, id);
    if (!current) throw ToolRequestErrors.notFound({ id });

    const from = current.status as ToolRequestStatus;
    const to = body.status;

    if (!canTransition(from, to)) {
      throw ToolRequestErrors.invalidTransition({ from, to });
    }

    if (requiresClosure(to) && !body.resolutionNote?.trim()) {
      throw ToolRequestErrors.resolutionNoteRequired();
    }

    const now = new Date();
    const patch: Partial<ToolRequestEntity> & { status: string } = {
      status: to,
      ownerOperatorId: current.ownerOperatorId ?? operatorId,
    };

    if (current.firstRespondedAt === null) {
      patch.firstRespondedAt = now;
    }

    if (requiresClosure(to)) {
      patch.closedAt = now;
      patch.resolutionNote = body.resolutionNote as string;
    }

    const affected = await this.requests.transitionIfIn(organizationId, id, [from], patch);
    if (affected === 0) {
      throw ToolRequestErrors.invalidTransition({ from, to });
    }

    const saved = await this.requests.findOneScoped(organizationId, id);
    // Cannot be null: the row we just updated within the same transaction
    // boundary is the row we are about to re-read.
    return ToolRequestDto.fromEntity(saved as ToolRequestEntity);
  }

  /** The brief an operator reads before answering. Cross-organization by id. */
  async brief(id: string): Promise<ToolRequestDto> {
    const organizationId = await this.requests.tenantOf(id);
    if (!organizationId) throw ToolRequestErrors.notFound({ id });

    const entity = await this.requests.findOneScoped(organizationId, id);
    if (!entity) throw ToolRequestErrors.notFound({ id });

    return ToolRequestDto.fromEntity(entity);
  }
}
