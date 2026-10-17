import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { ModerationCutoffEntity } from '@database/postgres/entities/moderation-cutoff.entity';
import { OrgHandleHistoryEntity } from '@database/postgres/entities/org-handle-history.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { ToolsetReportEntity } from '@database/postgres/entities/toolset-report.entity';
import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import { ModerationCutoffRepository } from '@database/postgres/repositories/toolset-sharing.repository';

import {
  HANDLE_ALIAS_MS,
  HandleHistoryReason,
  HandleStatus,
  handleRefusal,
  handleSkeleton,
  normalizeHandle,
} from '../domain/handle';
import { SharingAction, SharingTransitionError, applySharing } from '../domain/sharing';
import { ToolsetErrors } from '../errors/toolset.errors';
import { AccessEpochService } from './access-epoch.service';
import { HandlesService, lockHandle } from './handles.service';
import { sharingPatchOf, sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

/** FR-18: a second operator confirms a cutoff within this, or it is reverted. */
export const CUTOFF_CONFIRM_WINDOW_MS = 72 * 60 * 60 * 1000;

export enum CutoffTarget {
  TOOLSET = 'TOOLSET',
  HANDLE = 'HANDLE',
}

export enum CutoffAction {
  DELIST = 'DELIST',
  TAKEDOWN = 'TAKEDOWN',
}

export enum CutoffRevertReason {
  /** Nobody confirmed it within 72 hours. */
  EXPIRED = 'EXPIRED',
  /** The second operator disagreed. */
  REJECTED = 'REJECTED',
  /** Lifted later, after it was confirmed. */
  LIFTED = 'LIFTED',
  /** A handle takedown whose handle was reassigned: closed, so the new holder starts clean. */
  REASSIGNED = 'REASSIGNED',
}

/**
 * The state changes behind the operator's moderation tools (design spec
 * §7.1, §7.7, FR-15, FR-18): delist and take down a toolset, take down a
 * handle, rename and reassign a handle, confirm or revert a cutoff.
 *
 * Every write takes the caller's `EntityManager`, so the operator service
 * runs it inside `OverrideLogService.perform` and the register entry commits
 * with it. The automatic revert of an unconfirmed cutoff is a system act and
 * writes no register entry ({@link revertExpired}).
 *
 * A delist or a takedown takes effect at once; the cutoff row is what a
 * second operator confirms within 72 hours. After any of these the caller
 * calls {@link afterCommit}, which moves the sharing epoch so every cached
 * shared view and access sees it on the next request.
 */
@Injectable()
export class ToolsetModerationService {
  private readonly logger = new Logger(ToolsetModerationService.name);

  constructor(
    private readonly cutoffs: ModerationCutoffRepository,
    private readonly handles: HandlesService,
    private readonly epochs: AccessEpochService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  /** Delist or take down a toolset, at once; returns the cutoff to confirm. */
  async cutoffToolset(
    manager: EntityManager,
    input: {
      toolsetId: string;
      action: CutoffAction;
      operatorId: string;
      note: string;
      reportId?: string | null;
    },
  ): Promise<{ cutoff: ModerationCutoffEntity; toolset: ToolsetEntity }> {
    const toolset = await this.lockToolset(manager, input.toolsetId);
    const now = this.now();
    const next = transition(
      sharingStateOf(toolset),
      input.action === CutoffAction.DELIST ? { kind: 'DELIST' } : { kind: 'TAKEDOWN' },
      now,
    );
    await manager.update(ToolsetEntity, { id: toolset.id }, sharingPatchOf(next));
    const cutoff = await this.insertCutoff(manager, {
      targetType: CutoffTarget.TOOLSET,
      targetId: toolset.id,
      action: input.action,
      operatorId: input.operatorId,
      note: input.note,
      reportId: input.reportId ?? null,
      now,
    });
    return { cutoff, toolset };
  }

  /** Take down a handle: every URL under it stops at once, with no alias. */
  async cutoffHandle(
    manager: EntityManager,
    input: { handle: string; operatorId: string; note: string; reportId?: string | null },
  ): Promise<{ cutoff: ModerationCutoffEntity; organizationId: string }> {
    const handle = normalizeHandle(input.handle);
    await lockHandle(manager, handle);
    const org = await this.requireHandleOwner(manager, handle);
    if (org.handleStatus === HandleStatus.FROZEN) {
      throw ToolsetErrors.sharingRefused({ refusal: 'ALREADY_TAKEN_DOWN' });
    }
    await manager.update(OrganizationEntity, { id: org.id }, { handleStatus: HandleStatus.FROZEN });
    const cutoff = await this.insertCutoff(manager, {
      targetType: CutoffTarget.HANDLE,
      targetId: handle,
      action: CutoffAction.TAKEDOWN,
      operatorId: input.operatorId,
      note: input.note,
      reportId: input.reportId ?? null,
      now: this.now(),
    });
    return { cutoff, organizationId: org.id };
  }

  /** The second operator agrees: the cutoff stands. */
  async confirm(
    manager: EntityManager,
    cutoffId: string,
    operatorId: string,
  ): Promise<ModerationCutoffEntity> {
    const cutoff = await this.lockCutoff(manager, cutoffId);
    if (cutoff.revertedAt || cutoff.confirmedAt) {
      throw ToolsetErrors.cutoffNotPending({
        status: cutoff.revertedAt ? 'REVERTED' : 'CONFIRMED',
      });
    }
    if (cutoff.actedBy === operatorId) throw ToolsetErrors.cutoffSelfConfirm();
    await manager.update(
      ModerationCutoffEntity,
      { id: cutoff.id },
      { confirmedBy: operatorId, confirmedAt: this.now() },
    );
    return manager.findOneOrFail(ModerationCutoffEntity, { where: { id: cutoff.id } });
  }

  /**
   * Undo a cutoff: the second operator rejects it (`REJECTED`), nobody
   * confirmed it in time (`EXPIRED`, `operatorId` null), or a confirmed one
   * is lifted later (`LIFTED`).
   */
  async revert(
    manager: EntityManager,
    cutoffId: string,
    operatorId: string | null,
    reason: CutoffRevertReason,
  ): Promise<ModerationCutoffEntity> {
    const cutoff = await this.lockCutoff(manager, cutoffId);
    if (cutoff.revertedAt) throw ToolsetErrors.cutoffNotPending({ status: 'REVERTED' });
    if (reason !== CutoffRevertReason.LIFTED && cutoff.confirmedAt) {
      throw ToolsetErrors.cutoffNotPending({ status: 'CONFIRMED' });
    }

    if (cutoff.targetType === CutoffTarget.TOOLSET) {
      const toolset = await this.lockToolset(manager, cutoff.targetId);
      const state = sharingStateOf(toolset);
      const action: SharingAction =
        cutoff.action === CutoffAction.DELIST ? { kind: 'RELIST' } : { kind: 'RESTORE' };
      // Already undone by another path (a relist): nothing left to restore.
      const undone =
        (action.kind === 'RELIST' && state.delistedAt === null) ||
        (action.kind === 'RESTORE' && state.removedAt === null);
      if (!undone) {
        await manager.update(
          ToolsetEntity,
          { id: toolset.id },
          sharingPatchOf(transition(state, action, this.now())),
        );
      }
    } else {
      await lockHandle(manager, cutoff.targetId);
      const org = await manager
        .createQueryBuilder(OrganizationEntity, 'org')
        .where('lower(org.handle) = :handle', { handle: cutoff.targetId })
        .getOne();
      // Reassigned since: the handle is somebody else's now, and stays theirs.
      if (org && org.handleStatus === HandleStatus.FROZEN) {
        await manager.update(
          OrganizationEntity,
          { id: org.id },
          { handleStatus: HandleStatus.ACTIVE },
        );
      }
    }

    await manager.update(
      ModerationCutoffEntity,
      { id: cutoff.id },
      { revertedAt: this.now(), revertedBy: operatorId, revertReason: reason },
    );
    return manager.findOneOrFail(ModerationCutoffEntity, { where: { id: cutoff.id } });
  }

  /** An operator relists a delisted toolset; a standing delist cutoff is lifted with it. */
  async relist(manager: EntityManager, toolsetId: string, operatorId: string): Promise<void> {
    const toolset = await this.lockToolset(manager, toolsetId);
    await manager.update(
      ToolsetEntity,
      { id: toolset.id },
      sharingPatchOf(transition(sharingStateOf(toolset), { kind: 'RELIST' }, this.now())),
    );
    await manager.update(
      ModerationCutoffEntity,
      {
        targetType: CutoffTarget.TOOLSET,
        targetId: toolset.id,
        action: CutoffAction.DELIST,
        revertedAt: IsNull(),
      },
      { revertedAt: this.now(), revertedBy: operatorId, revertReason: CutoffRevertReason.LIFTED },
    );
  }

  /**
   * An operator rename after the lock (two-person): the old handle stays an
   * alias for 90 days, then is held for good.
   */
  async renameHandle(
    manager: EntityManager,
    rawHandle: string,
    rawNewHandle: string,
  ): Promise<{ organizationId: string; aliasUntil: Date }> {
    const handle = normalizeHandle(rawHandle);
    const next = normalizeHandle(rawNewHandle);
    const refusal = handleRefusal(next, await this.handles.categories());
    if (refusal) throw ToolsetErrors.handleInvalid({ reason: refusal });
    // Both locks, in a fixed order, so a rename A→B and B→A cannot deadlock.
    for (const name of [handle, next].sort()) await lockHandle(manager, name);

    const org = await this.requireHandleOwner(manager, handle);
    if (org.handleStatus !== HandleStatus.ACTIVE) {
      throw ToolsetErrors.sharingRefused({ refusal: 'TAKEN_DOWN' });
    }
    if (!(await this.handles.isAvailable(manager, next, org.id))) {
      throw ToolsetErrors.handleTaken({ suggestions: [] });
    }
    const now = this.now();
    const aliasUntil = new Date(now.getTime() + HANDLE_ALIAS_MS);
    await manager.update(
      OrganizationEntity,
      { id: org.id },
      { handle: next, handleSkeleton: handleSkeleton(next) },
    );
    await manager.insert(OrgHandleHistoryEntity, {
      oldHandle: handle,
      oldSkeleton: handleSkeleton(handle),
      orgId: org.id,
      reason: HandleHistoryReason.RENAME,
      newHandle: next,
      changedAt: now,
      aliasUntil,
    });
    return { organizationId: org.id, aliasUntil };
  }

  /**
   * A taken-down (frozen) handle moves to another verified organization —
   * for example the brand it imitated (two-person). The source organization
   * loses it; a handle the target held but had not locked is released.
   */
  async reassignHandle(
    manager: EntityManager,
    rawHandle: string,
    toOrganizationId: string,
  ): Promise<{ fromOrganizationId: string }> {
    const handle = normalizeHandle(rawHandle);
    await lockHandle(manager, handle);
    const from = await this.requireHandleOwner(manager, handle);
    if (from.handleStatus !== HandleStatus.FROZEN) {
      throw ToolsetErrors.handleReassignRefused({ reason: 'only a taken-down handle moves' });
    }
    if (from.id === toOrganizationId) {
      throw ToolsetErrors.handleReassignRefused({ reason: 'it already holds the handle' });
    }
    const to = await manager.findOne(OrganizationEntity, { where: { id: toOrganizationId } });
    if (!to) throw ToolsetErrors.handleReassignRefused({ reason: 'unknown organization' });
    if (to.handleLockedAt || to.handleStatus === HandleStatus.FROZEN) {
      throw ToolsetErrors.handleReassignRefused({
        reason: 'the organization already has a public name in use',
      });
    }
    if (!(await this.handles.isVerified(to.id))) {
      throw ToolsetErrors.handleReassignRefused({ reason: 'the organization is not verified' });
    }
    // Only a takedown two operators agreed on moves a public name: a pending
    // one may still be reverted, and the name would then be in other hands.
    const standing = await manager
      .createQueryBuilder(ModerationCutoffEntity, 'cutoff')
      .setLock('pessimistic_write')
      .where('cutoff.target_type = :type', { type: CutoffTarget.HANDLE })
      .andWhere('cutoff.target_id = :handle', { handle })
      .andWhere('cutoff.action = :action', { action: CutoffAction.TAKEDOWN })
      .andWhere('cutoff.reverted_at IS NULL')
      .getOne();
    if (!standing?.confirmedAt) {
      throw ToolsetErrors.handleReassignRefused({
        reason: 'the takedown is not confirmed by a second operator yet',
      });
    }

    const now = this.now();
    await manager.update(
      OrganizationEntity,
      { id: from.id },
      { handle: null, handleSkeleton: null, handleStatus: null, handleLockedAt: null },
    );
    await manager.update(
      OrganizationEntity,
      { id: to.id },
      { handle, handleSkeleton: handleSkeleton(handle), handleStatus: HandleStatus.ACTIVE },
    );
    await manager.insert(OrgHandleHistoryEntity, {
      oldHandle: handle,
      oldSkeleton: handleSkeleton(handle),
      orgId: from.id,
      reason: HandleHistoryReason.TAKEDOWN,
      newHandle: null,
      changedAt: now,
      aliasUntil: null,
      reassignedToOrgId: to.id,
      reassignedAt: now,
    });
    // The takedown has done its job; closing it lets the new holder be taken
    // down later like anyone else.
    await manager.update(
      ModerationCutoffEntity,
      { id: standing.id },
      { revertedAt: now, revertedBy: null, revertReason: CutoffRevertReason.REASSIGNED },
    );
    return { fromOrganizationId: from.id };
  }

  /** Close a report. */
  async resolveReport(
    manager: EntityManager,
    reportId: string,
    resolution: string,
    operatorId: string,
  ): Promise<ToolsetReportEntity> {
    const report = await manager.findOne(ToolsetReportEntity, { where: { id: reportId } });
    if (!report) throw ToolsetErrors.reportNotFound();
    if (report.resolvedAt) throw ToolsetErrors.cutoffNotPending({ status: 'RESOLVED' });
    await manager.update(
      ToolsetReportEntity,
      { id: report.id },
      { resolvedAt: this.now(), resolution, resolvedBy: operatorId },
    );
    return manager.findOneOrFail(ToolsetReportEntity, { where: { id: report.id } });
  }

  /** After a moderation write commits: every cached shared view and access re-reads. */
  async afterCommit(organizationIds: readonly (string | null)[] = []): Promise<void> {
    await this.epochs.bumpShared();
    for (const id of new Set(organizationIds)) if (id) await this.epochs.bump(id);
  }

  /** Scheduler: revert every cutoff nobody confirmed within 72 hours. */
  async revertExpired(): Promise<number> {
    const due = await this.cutoffs.findDue(this.now());
    let reverted = 0;
    for (const cutoff of due) {
      try {
        await this.dataSource.transaction((manager) =>
          this.revert(manager, cutoff.id, null, CutoffRevertReason.EXPIRED),
        );
        reverted += 1;
      } catch (error) {
        this.logger.warn(`cutoff ${cutoff.id} not reverted: ${String(error)}`);
      }
    }
    if (reverted > 0) await this.afterCommit();
    return reverted;
  }

  /**
   * Scheduler: end grace periods that are over; a link that served only
   * through one is cleared. Each row is locked and recomputed from what it
   * holds now, and only the grace columns and the token are written — a
   * rotation or a share that landed since the scan is never overwritten.
   */
  async expireGrace(): Promise<number> {
    const now = this.now();
    const due = (await this.dataSource.query(
      `SELECT id FROM toolsets WHERE grace_until <= $1 ORDER BY grace_until LIMIT 500`,
      [now],
    )) as { id: string }[];
    let ended = 0;
    for (const { id } of due) {
      const changed = await this.dataSource.transaction(async (manager) => {
        const toolset = await manager
          .createQueryBuilder(ToolsetEntity, 'toolset')
          .setLock('pessimistic_write')
          .where('toolset.id = :id', { id })
          .getOne();
        if (!toolset) return false;
        const before = sharingStateOf(toolset);
        const next = applySharing(before, { kind: 'EXPIRE_GRACE' }, now);
        if (next === before) return false;
        await manager.update(
          ToolsetEntity,
          { id },
          {
            graceVisibility: next.graceVisibility,
            graceUntil: next.graceUntil,
            unlistedToken: next.unlistedToken,
          },
        );
        return true;
      });
      if (changed) ended += 1;
    }
    if (ended > 0) await this.afterCommit();
    return ended;
  }

  private async insertCutoff(
    manager: EntityManager,
    input: {
      targetType: CutoffTarget;
      targetId: string;
      action: CutoffAction;
      operatorId: string;
      note: string;
      reportId: string | null;
      now: Date;
    },
  ): Promise<ModerationCutoffEntity> {
    const row = manager.create(ModerationCutoffEntity, {
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      actedBy: input.operatorId,
      actedAt: input.now,
      confirmBy: new Date(input.now.getTime() + CUTOFF_CONFIRM_WINDOW_MS),
      note: input.note,
      reportId: input.reportId,
    });
    return manager.save(ModerationCutoffEntity, row);
  }

  private async lockToolset(manager: EntityManager, id: string): Promise<ToolsetEntity> {
    const toolset = await manager
      .createQueryBuilder(ToolsetEntity, 'toolset')
      .setLock('pessimistic_write')
      .where('toolset.id = :id', { id })
      .getOne();
    if (!toolset) throw ToolsetErrors.notFound();
    return toolset;
  }

  private async lockCutoff(manager: EntityManager, id: string): Promise<ModerationCutoffEntity> {
    const cutoff = await manager
      .createQueryBuilder(ModerationCutoffEntity, 'cutoff')
      .setLock('pessimistic_write')
      .where('cutoff.id = :id', { id })
      .getOne();
    if (!cutoff) throw ToolsetErrors.cutoffNotFound();
    return cutoff;
  }

  private async requireHandleOwner(
    manager: EntityManager,
    handle: string,
  ): Promise<OrganizationEntity> {
    const org = await manager
      .createQueryBuilder(OrganizationEntity, 'org')
      .where('lower(org.handle) = :handle', { handle })
      .getOne();
    if (!org) throw ToolsetErrors.handleNotFound();
    return org;
  }
}

function transition(state: ReturnType<typeof sharingStateOf>, action: SharingAction, now: Date) {
  try {
    return applySharing(state, action, now);
  } catch (error) {
    if (error instanceof SharingTransitionError) {
      throw ToolsetErrors.sharingRefused({ refusal: error.refusal });
    }
    throw error;
  }
}
