import { Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';

import { ModerationCutoffEntity } from '@database/postgres/entities/moderation-cutoff.entity';
import { ToolsetReportEntity } from '@database/postgres/entities/toolset-report.entity';
import {
  ModerationCutoffRepository,
  ToolsetReportRepository,
} from '@database/postgres/repositories/toolset-sharing.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';
import { ToolsetErrors } from '@modules/toolset/errors/toolset.errors';
import {
  CutoffAction,
  CutoffRevertReason,
  ToolsetModerationService,
} from '@modules/toolset/services/toolset-moderation.service';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  ListModerationQueryDto,
  ModerationBodyDto,
  ModerationCutoffDto,
  OperatorReportDto,
  ReassignHandleBodyDto,
  RenameHandleBodyDto,
  ResolveReportBodyDto,
} from '../dto/operator-moderation.dto';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';
import { OverrideLogService } from './override-log.service';

export const RENAME_HANDLE_APPROVAL_ACTION = 'handle.rename';
export const REASSIGN_HANDLE_APPROVAL_ACTION = 'handle.reassign';
export const LIFT_CUTOFF_APPROVAL_ACTION = 'moderation.cutoff_lift';

/**
 * The operator's toolset and handle moderation (design spec §7.9, FR-15,
 * FR-18), every write through `OverrideLogService.perform` so the state change
 * and its register entry commit together.
 *
 * ```text
 * A-15 delist · A-16 takedown · A-17 handle takedown   one operator, at once; a cutoff row opens
 * A-18 confirm                                          a different operator, within 72 h
 * A-19 revert                                           reject a pending cutoff; lifting a confirmed one is two-person
 * A-20 relist · A-23 resolve a report                   one operator
 * A-21 rename a locked handle · A-22 reassign           two-person, through the approvals queue
 * ```
 *
 * The domain writes are `ToolsetModerationService`'s, run on the register's
 * transaction; once it commits, every cached shared view and access re-reads.
 */
@Injectable()
export class OperatorModerationService {
  constructor(
    private readonly overrides: OverrideLogService,
    private readonly approvals: OperatorApprovalService,
    private readonly moderation: ToolsetModerationService,
    private readonly toolsets: ToolsetRepository,
    private readonly cutoffs: ModerationCutoffRepository,
    private readonly reports: ToolsetReportRepository,
  ) {
    approvals.register(RENAME_HANDLE_APPROVAL_ACTION, {
      code: 'A-21',
      run: (requester, approver, payload, requestId) =>
        this.renameHandle(
          requester,
          payload.handle as string,
          payload.body as RenameHandleBodyDto,
          requestId,
          approver,
        ),
    });
    approvals.register(REASSIGN_HANDLE_APPROVAL_ACTION, {
      code: 'A-22',
      run: (requester, approver, payload, requestId) =>
        this.reassignHandle(
          requester,
          payload.handle as string,
          payload.body as ReassignHandleBodyDto,
          requestId,
          approver,
        ),
    });
    approvals.register(LIFT_CUTOFF_APPROVAL_ACTION, {
      code: 'A-19',
      run: (requester, approver, payload, requestId) =>
        this.revertCutoff(
          requester,
          payload.cutoffId as string,
          payload.body as ModerationBodyDto,
          requestId,
          approver,
        ),
    });
  }

  /** `A-15` / `A-16`: at once, then a second operator confirms within 72 hours. */
  async cutoffToolset(
    operator: OperatorSession,
    toolsetId: string,
    action: CutoffAction,
    body: ModerationBodyDto,
    requestId: string | null,
  ): Promise<ModerationCutoffDto> {
    const toolset = await this.toolsets.findAnyById(toolsetId);
    if (!toolset) throw ToolsetErrors.notFound();
    const cutoff = await this.overrides.perform<ModerationCutoffEntity>(
      {
        code: action === CutoffAction.DELIST ? 'A-15' : 'A-16',
        actor: operator,
        targetType: 'toolset',
        targetId: toolset.id,
        organizationId: toolset.ownerOrgId,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const manager = queryRunner.manager;
        const { cutoff: row } = await this.moderation.cutoffToolset(manager, {
          toolsetId: toolset.id,
          action,
          operatorId: operator.operatorId,
          note: body.note,
          reportId: body.reportId ?? null,
        });
        await this.closeReport(
          manager,
          body.reportId,
          action === CutoffAction.DELIST ? 'DELISTED' : 'TAKEN_DOWN',
          operator,
        );
        return {
          value: row,
          before: { visibility: toolset.visibility, listingStatus: toolset.listingStatus },
          after: { action, cutoffId: row.id, confirmBy: row.confirmBy.toISOString() },
        };
      },
    );
    await this.moderation.afterCommit([toolset.ownerOrgId]);
    return cutoffDtoOf(cutoff);
  }

  /** `A-20`. */
  async relistToolset(
    operator: OperatorSession,
    toolsetId: string,
    body: ModerationBodyDto,
    requestId: string | null,
  ): Promise<void> {
    const toolset = await this.toolsets.findAnyById(toolsetId);
    if (!toolset) throw ToolsetErrors.notFound();
    await this.overrides.perform<void>(
      {
        code: 'A-20',
        actor: operator,
        targetType: 'toolset',
        targetId: toolset.id,
        organizationId: toolset.ownerOrgId,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        await this.moderation.relist(queryRunner.manager, toolset.id, operator.operatorId);
        await this.closeReport(queryRunner.manager, body.reportId, 'ACTIONED', operator);
        return { value: undefined, before: { delisted: true }, after: { delisted: false } };
      },
    );
    await this.moderation.afterCommit([toolset.ownerOrgId]);
  }

  /** `A-17`: every URL under the handle stops at once, with no alias. */
  async takedownHandle(
    operator: OperatorSession,
    handle: string,
    body: ModerationBodyDto,
    requestId: string | null,
  ): Promise<ModerationCutoffDto> {
    let organizationId: string | null = null;
    const cutoff = await this.overrides.perform<ModerationCutoffEntity>(
      {
        code: 'A-17',
        actor: operator,
        targetType: 'handle',
        targetId: handle,
        organizationId: null,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const result = await this.moderation.cutoffHandle(queryRunner.manager, {
          handle,
          operatorId: operator.operatorId,
          note: body.note,
          reportId: body.reportId ?? null,
        });
        organizationId = result.organizationId;
        await this.closeReport(queryRunner.manager, body.reportId, 'TAKEN_DOWN', operator);
        return {
          value: result.cutoff,
          before: { handleStatus: 'ACTIVE' },
          after: { handleStatus: 'FROZEN', cutoffId: result.cutoff.id },
        };
      },
    );
    await this.moderation.afterCommit([organizationId]);
    return cutoffDtoOf(cutoff);
  }

  /** `A-18`: a different operator agrees; the cutoff stands. */
  async confirmCutoff(
    operator: OperatorSession,
    cutoffId: string,
    body: ModerationBodyDto,
    requestId: string | null,
  ): Promise<ModerationCutoffDto> {
    const existing = await this.requireCutoff(cutoffId);
    const cutoff = await this.overrides.perform<ModerationCutoffEntity>(
      {
        code: 'A-18',
        actor: operator,
        targetType: 'moderation_cutoff',
        targetId: existing.id,
        organizationId: null,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const row = await this.moderation.confirm(
          queryRunner.manager,
          existing.id,
          operator.operatorId,
        );
        return { value: row, before: { confirmed: false }, after: { confirmed: true } };
      },
    );
    return cutoffDtoOf(cutoff);
  }

  /**
   * `A-19`: reject a pending cutoff (one operator), or lift a confirmed one —
   * two people agreed to it, so lifting it takes two as well (queued).
   */
  async revertCutoff(
    operator: OperatorSession,
    cutoffId: string,
    body: ModerationBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<ModerationCutoffDto | ApprovalQueuedDto> {
    const existing = await this.requireCutoff(cutoffId);
    const confirmed = existing.confirmedAt !== null;
    const attempt = async () => {
      const cutoff = await this.overrides.perform<ModerationCutoffEntity>(
        {
          code: 'A-19',
          actor: operator,
          approver,
          escalateToTwoPerson: confirmed,
          targetType: 'moderation_cutoff',
          targetId: existing.id,
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const row = await this.moderation.revert(
            queryRunner.manager,
            existing.id,
            operator.operatorId,
            confirmed ? CutoffRevertReason.LIFTED : CutoffRevertReason.REJECTED,
          );
          return { value: row, before: { reverted: false }, after: { reverted: true } };
        },
      );
      await this.moderation.afterCommit(await this.ownersOf(existing));
      return cutoffDtoOf(cutoff);
    };
    if (approver || !confirmed) return attempt();
    return this.approvals.orQueue(
      {
        action: LIFT_CUTOFF_APPROVAL_ACTION,
        target: `moderation_cutoff:${existing.id}`,
        payload: { cutoffId: existing.id, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  /** `A-21`, two-person: the old handle stays an alias for 90 days, then is held. */
  async renameHandle(
    operator: OperatorSession,
    handle: string,
    body: RenameHandleBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<{ handle: string; aliasUntil: string } | ApprovalQueuedDto> {
    const attempt = async () => {
      let organizationId: string | null = null;
      const aliasUntil = await this.overrides.perform<Date>(
        {
          code: 'A-21',
          actor: operator,
          approver,
          targetType: 'handle',
          targetId: handle,
          organizationId: null,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const result = await this.moderation.renameHandle(
            queryRunner.manager,
            handle,
            body.newHandle,
          );
          organizationId = result.organizationId;
          return {
            value: result.aliasUntil,
            before: { handle },
            after: { handle: body.newHandle, aliasUntil: result.aliasUntil.toISOString() },
          };
        },
      );
      await this.moderation.afterCommit([organizationId]);
      return { handle: body.newHandle, aliasUntil: aliasUntil.toISOString() };
    };
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: RENAME_HANDLE_APPROVAL_ACTION,
        target: `handle:${handle}`,
        payload: { handle, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  /** `A-22`, two-person: a taken-down handle moves to another verified organization. */
  async reassignHandle(
    operator: OperatorSession,
    handle: string,
    body: ReassignHandleBodyDto,
    requestId: string | null,
    approver: OperatorApprover | null = null,
  ): Promise<{ handle: string; organizationId: string } | ApprovalQueuedDto> {
    const attempt = async () => {
      let from: string | null = null;
      await this.overrides.perform<void>(
        {
          code: 'A-22',
          actor: operator,
          approver,
          targetType: 'handle',
          targetId: handle,
          organizationId: body.toOrganizationId,
          reasonCode: body.reasonCode,
          reason: body.note,
          ticketRef: body.ticketRef ?? null,
          requestId,
        },
        async (queryRunner) => {
          const result = await this.moderation.reassignHandle(
            queryRunner.manager,
            handle,
            body.toOrganizationId,
          );
          from = result.fromOrganizationId;
          return {
            value: undefined,
            before: { organizationId: result.fromOrganizationId },
            after: { organizationId: body.toOrganizationId },
          };
        },
      );
      await this.moderation.afterCommit([from, body.toOrganizationId]);
      return { handle, organizationId: body.toOrganizationId };
    };
    if (approver) return attempt();
    return this.approvals.orQueue(
      {
        action: REASSIGN_HANDLE_APPROVAL_ACTION,
        target: `handle:${handle}`,
        payload: { handle, body: { ...body } },
        requester: operator,
      },
      attempt,
    );
  }

  /** `A-23`. */
  async resolveReport(
    operator: OperatorSession,
    reportId: string,
    body: ResolveReportBodyDto,
    requestId: string | null,
  ): Promise<OperatorReportDto> {
    const report = await this.reports.findOneBy({ id: reportId });
    if (!report) throw ToolsetErrors.reportNotFound();
    const row = await this.overrides.perform<ToolsetReportEntity>(
      {
        code: 'A-23',
        actor: operator,
        targetType: 'toolset_report',
        targetId: report.id,
        organizationId: null,
        reasonCode: body.reasonCode,
        reason: body.note,
        ticketRef: body.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const resolved = await this.moderation.resolveReport(
          queryRunner.manager,
          report.id,
          body.resolution,
          operator.operatorId,
        );
        return {
          value: resolved,
          before: { resolved: false },
          after: { resolution: body.resolution },
        };
      },
    );
    return reportDtoOf(row);
  }

  async listCutoffs(query: ListModerationQueryDto): Promise<ModerationCutoffDto[]> {
    const rows = await this.cutoffs.find({
      where: query.pending ? { confirmedAt: IsNull(), revertedAt: IsNull() } : {},
      order: { actedAt: 'DESC' },
      take: 200,
    });
    return rows.map(cutoffDtoOf);
  }

  async listReports(query: ListModerationQueryDto): Promise<OperatorReportDto[]> {
    const rows = await this.reports.find({
      where: query.pending ? { resolvedAt: IsNull() } : {},
      order: { createdAt: 'DESC' },
      take: 200,
    });
    return rows.map(reportDtoOf);
  }

  private async closeReport(
    manager: EntityManager,
    reportId: string | undefined,
    resolution: string,
    operator: OperatorSession,
  ): Promise<void> {
    if (!reportId) return;
    const report = await manager.findOne(ToolsetReportEntity, { where: { id: reportId } });
    if (!report || report.resolvedAt) return;
    await this.moderation.resolveReport(manager, reportId, resolution, operator.operatorId);
  }

  private async requireCutoff(id: string): Promise<ModerationCutoffEntity> {
    const cutoff = await this.cutoffs.findOneBy({ id });
    if (!cutoff) throw ToolsetErrors.cutoffNotFound();
    return cutoff;
  }

  private async ownersOf(cutoff: ModerationCutoffEntity): Promise<(string | null)[]> {
    if (cutoff.targetType !== 'TOOLSET') return [];
    return [(await this.toolsets.findAnyById(cutoff.targetId))?.ownerOrgId ?? null];
  }
}

function iso(date: Date | null): string | null {
  return date ? new Date(date).toISOString() : null;
}

function cutoffDtoOf(row: ModerationCutoffEntity): ModerationCutoffDto {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    action: row.action,
    actedBy: row.actedBy,
    actedAt: new Date(row.actedAt).toISOString(),
    confirmBy: new Date(row.confirmBy).toISOString(),
    confirmedBy: row.confirmedBy,
    confirmedAt: iso(row.confirmedAt),
    revertedAt: iso(row.revertedAt),
    revertReason: row.revertReason,
    reportId: row.reportId,
    note: row.note,
  };
}

function reportDtoOf(row: ToolsetReportEntity): OperatorReportDto {
  return {
    id: row.id,
    toolsetId: row.toolsetId,
    toolId: row.toolId,
    handle: row.handle,
    reporterOrgId: row.reporterOrgId,
    reason: row.reason,
    createdAt: new Date(row.createdAt).toISOString(),
    resolvedAt: iso(row.resolvedAt),
    resolution: row.resolution,
  };
}
