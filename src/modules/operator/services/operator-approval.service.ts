import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { OperatorApprovalEntity } from '@database/postgres/entities/operator-approval.entity';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { asInstant, CursorPageDto, ListSpec, paginate } from '@shared/api';
import { BaseError } from '@shared/errors/base.error';

import { approverRolesSatisfy, lookupOverride, OperatorRole } from '../domain/override-register';
import {
  ApprovalDecisionDto,
  ApprovalQueuedDto,
  ListOperatorApprovalsQueryDto,
  OperatorApprovalDto,
} from '../dto/operator-approval.dto';
import { OperatorErrorCode, OperatorErrors } from '../errors/operator.errors';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorService } from './operator.service';

/** How long a queued action waits for its second person. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** How a queued action is re-run once a second operator approves it. */
export interface ApprovalHandler {
  /** The register row the action writes; its `approverRoles` gate who may approve. */
  readonly code: string;
  run(
    requester: OperatorSession,
    approver: OperatorApprover,
    payload: Record<string, unknown>,
    requestId: string | null,
  ): Promise<unknown>;
}

export interface QueueRequest {
  readonly action: string;
  readonly target: string;
  readonly payload: Record<string, unknown>;
  readonly requester: OperatorSession;
}

export function isApprovalQueued(value: unknown): value is ApprovalQueuedDto {
  return value instanceof ApprovalQueuedDto;
}

/** JSON with object keys sorted, so the hash does not depend on jsonb's key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * The two-person approvals queue.
 *
 * A two-person route runs its action with no approver. When the register says
 * the occurrence needs one, `OverrideLogService` refuses with
 * `OPERATOR_SECOND_APPROVER_REQUIRED` before anything is written, and
 * {@link orQueue} turns that refusal into a `PENDING` row holding the exact
 * request — the route answers 202 `{approvalId}` and nothing else happens.
 * Everything the action checks before that point (the requester's roles and
 * limit, the target's state) has already been checked, so a request that
 * could never be approved is refused at once.
 *
 * {@link approve} is called by a different operator, with their own session.
 * It re-runs the original action through the same service, as the requester
 * (re-read from `operators`, so a requester removed since is refused), with
 * the approver attached. Every check runs again on the state as it is now;
 * the register then checks the approver's roles and limit, and marks the
 * approval `APPROVED` in the action's own transaction. A failure leaves the
 * approval `PENDING`, to be retried, rejected, or left to expire after 24h.
 */
@Injectable()
export class OperatorApprovalService {
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(
    private readonly approvals: OperatorApprovalRepository,
    private readonly operators: OperatorRepository,
    private readonly directory: OperatorService,
  ) {}

  /** Called once per action by the service that owns it. */
  register(action: string, handler: ApprovalHandler): void {
    if (this.handlers.has(action)) throw new Error(`approval action ${action} registered twice`);
    this.handlers.set(action, handler);
  }

  /** Run `attempt`; if it needs a second person, queue it instead. */
  async orQueue<T>(
    request: QueueRequest,
    attempt: () => Promise<T>,
  ): Promise<T | ApprovalQueuedDto> {
    if (!this.handlers.has(request.action)) {
      throw new Error(`approval action ${request.action} has no handler`);
    }
    try {
      return await attempt();
    } catch (error) {
      if (
        !(error instanceof BaseError) ||
        error.errorCode !== OperatorErrorCode.OPERATOR_SECOND_APPROVER_REQUIRED
      ) {
        throw error;
      }
    }

    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
    const row = await this.approvals.save(
      this.approvals.create({
        action: request.action,
        target: request.target,
        payload: request.payload,
        payloadHash: payloadHash(request.payload),
        requestedBy: request.requester.operatorId,
        status: 'PENDING',
        expiresAt,
      }),
    );
    return Object.assign(new ApprovalQueuedDto(), {
      approvalId: row.id,
      status: 'PENDING' as const,
      action: row.action,
      expiresAt: row.expiresAt,
    });
  }

  async list(query: ListOperatorApprovalsQueryDto): Promise<CursorPageDto<OperatorApprovalDto>> {
    await this.approvals.expireStale();
    const qb = this.approvals.createQueryBuilder('approval');
    if (query.status) qb.andWhere('approval.status = :status', { status: query.status });
    const page = await paginate(qb, query, APPROVAL_LIST);
    return new CursorPageDto(await this.toDtos(page.items), page.pageInfo.nextCursor);
  }

  async get(id: string): Promise<OperatorApprovalDto> {
    await this.approvals.expireStale();
    return (await this.toDtos([await this.require(id)]))[0];
  }

  async approve(
    id: string,
    approver: OperatorSession,
    requestId: string | null,
  ): Promise<ApprovalDecisionDto> {
    await this.approvals.expireStale();
    const row = await this.require(id);
    if (row.status !== 'PENDING') throw OperatorErrors.approvalNotPending({ status: row.status });
    if (row.requestedBy === approver.operatorId) {
      throw OperatorErrors.selfApprovalRefused({ code: row.action });
    }
    if (payloadHash(row.payload) !== row.payloadHash) {
      throw OperatorErrors.approvalPayloadMismatch();
    }

    const handler = this.handlerFor(row);
    // Cheap and early; the register checks it again, with the limit, inside
    // the action.
    const definition = lookupOverride(handler.code);
    if (definition && !approverRolesSatisfy(definition, approver.roles as OperatorRole[])) {
      throw OperatorErrors.approverRoleRequired({
        code: handler.code,
        required: definition.approverRoles,
        held: approver.roles,
      });
    }

    const requester = this.directory.sessionOf(await this.directory.requireActive(row.requestedBy));
    const result = await handler.run(
      requester,
      { ...approver, approvalId: row.id },
      row.payload,
      requestId,
    );

    return { approval: (await this.toDtos([await this.require(id)]))[0], result };
  }

  /**
   * Turn a pending action down. The requester may withdraw their own; anyone
   * else must be somebody who could have approved it.
   */
  async reject(id: string, operator: OperatorSession): Promise<ApprovalDecisionDto> {
    await this.approvals.expireStale();
    const row = await this.require(id);
    if (row.status !== 'PENDING') throw OperatorErrors.approvalNotPending({ status: row.status });

    if (row.requestedBy !== operator.operatorId) {
      const handler = this.handlerFor(row);
      const definition = lookupOverride(handler.code);
      if (definition && !approverRolesSatisfy(definition, operator.roles as OperatorRole[])) {
        throw OperatorErrors.approverRoleRequired({
          code: handler.code,
          required: definition.approverRoles,
          held: operator.roles,
        });
      }
    }

    if (!(await this.approvals.markRejected(id, operator.operatorId))) {
      const now = await this.require(id);
      throw OperatorErrors.approvalNotPending({ status: now.status });
    }
    return { approval: (await this.toDtos([await this.require(id)]))[0] };
  }

  private handlerFor(row: OperatorApprovalEntity): ApprovalHandler {
    const handler = this.handlers.get(row.action);
    // A row written by a version that knew an action this one does not.
    if (!handler) throw OperatorErrors.unknownOverrideCode({ code: row.action });
    return handler;
  }

  private async require(id: string): Promise<OperatorApprovalEntity> {
    const row = await this.approvals.findOneBy({ id });
    if (!row) throw OperatorErrors.approvalNotFound({ approvalId: id });
    return row;
  }

  private async toDtos(rows: readonly OperatorApprovalEntity[]): Promise<OperatorApprovalDto[]> {
    const subjects = new Map<string, string>();
    const subjectOf = async (operatorId: string | null): Promise<string | null> => {
      if (!operatorId) return null;
      if (!subjects.has(operatorId)) {
        const found = await this.operators.findById(operatorId);
        subjects.set(operatorId, found?.subject ?? operatorId);
      }
      return subjects.get(operatorId) as string;
    };

    const out: OperatorApprovalDto[] = [];
    for (const row of rows) {
      out.push({
        id: row.id,
        action: row.action,
        code: this.handlers.get(row.action)?.code ?? '',
        target: row.target,
        payload: row.payload,
        status: row.status,
        requestedBy: (await subjectOf(row.requestedBy)) as string,
        requestedById: row.requestedBy,
        approvedBy: await subjectOf(row.approvedBy),
        rejectedBy: await subjectOf(row.rejectedBy),
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        expiresAt: row.expiresAt,
      });
    }
    return out;
  }
}

/** Newest first. */
const APPROVAL_LIST: ListSpec = {
  alias: 'approval',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'approval.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: OperatorApprovalEntity) => row.createdAt),
    },
  },
  timeColumn: 'approval.created_at',
};
