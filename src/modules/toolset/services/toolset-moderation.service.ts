import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { ModerationCutoffEntity } from '@database/postgres/entities/moderation-cutoff.entity';
import { OrgHandleHistoryEntity } from '@database/postgres/entities/org-handle-history.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { ToolsetReportEntity } from '@database/postgres/entities/toolset-report.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { NOTIFICATION_PORT, NotificationPort } from '@modules/notification/ports/notification.port';
import { providerToolNotification } from '@modules/provider-tool/domain/notices';

import { handleNotification } from '../domain/handle-notices';
import {
  TOOL_CONTRACT_CHANGES,
  ToolContractChanges,
} from '@modules/tool/ports/tool-contracts.port';
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
import {
  removeHandleTools,
  renameHandleTools,
  restoreHandleTools,
  restoreTakenDownTool,
  tombstoneHandleTools,
} from './handle-tools';
import { HandlesService, lockHandle } from './handles.service';
import { sharingPatchOf, sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

/** FR-18: a second operator confirms a cutoff within this, or it is reverted. */
export const CUTOFF_CONFIRM_WINDOW_MS = 72 * 60 * 60 * 1000;

export enum CutoffTarget {
  TOOLSET = 'TOOLSET',
  HANDLE = 'HANDLE',
  /** A provider tool (T4, `/operator/tools/:id/takedown`). */
  TOOL = 'TOOL',
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
    // A tool's or a handle's takedown changes which tools serve: every
    // process re-reads its contracts at once. Optional for hand-built harnesses.
    @Optional()
    @Inject(TOOL_CONTRACT_CHANGES)
    private readonly contracts?: ToolContractChanges,
    // A provider tool's own takedown and its lifting are told to its
    // provider. Optional for hand-built harnesses.
    @Optional()
    @Inject(NOTIFICATION_PORT)
    private readonly notifications?: NotificationPort | null,
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

  /**
   * Take down a provider tool, at once (FR-18): REMOVED everywhere — every
   * view, pinned toolset versions included — and calls get `TOOL_REMOVED`.
   * The status it had is kept, so a reverted cutoff restores it.
   */
  async cutoffTool(
    manager: EntityManager,
    input: {
      toolId: string;
      operatorId: string;
      note: string;
      reportId?: string | null;
      /** What the provider is told (`TakedownReasonCode`), and a note for them. */
      publicReasonCode?: string | null;
      publicNote?: string | null;
    },
  ): Promise<{ cutoff: ModerationCutoffEntity; organizationId: string | null }> {
    const tool = await manager
      .createQueryBuilder(ToolEntity, 'tool')
      .setLock('pessimistic_write')
      .where('tool.id = :id', { id: input.toolId })
      .getOne();
    if (!tool || tool.kind !== 'PROVIDER') throw ToolsetErrors.notFound();
    // Its own takedown, recorded even when its handle's already removed it:
    // the two reasons stand apart (lifting one never lifts the other).
    if (tool.takenDownAt) {
      throw ToolsetErrors.sharingRefused({ refusal: 'ALREADY_TAKEN_DOWN' });
    }
    const now = this.now();
    const removedNow = tool.status !== 'REMOVED';
    await manager.update(
      ToolEntity,
      { id: tool.id },
      {
        status: 'REMOVED',
        removedAt: tool.removedAt ?? now,
        takenDownAt: now,
        statusBeforeRemoval: removedNow ? tool.status : tool.statusBeforeRemoval,
        // A review in flight is void: nothing taken down can be approved.
        ...(tool.reviewStatus === 'PENDING'
          ? {
              reviewStatus: tool.approvedVersion !== null ? 'APPROVED' : 'NONE',
              reviewContentHash: null,
            }
          : {}),
        updatedAt: now,
      },
    );
    const cutoff = await this.insertCutoff(manager, {
      targetType: CutoffTarget.TOOL,
      targetId: tool.id,
      action: CutoffAction.TAKEDOWN,
      operatorId: input.operatorId,
      note: input.note,
      reportId: input.reportId ?? null,
      now,
      publicReasonCode: input.publicReasonCode ?? null,
      publicNote: input.publicNote ?? null,
    });
    return { cutoff, organizationId: tool.ownerOrgId };
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
    // Its provider tools (`{handle}__…`) stop with it, on every URL.
    await removeHandleTools(manager, org.id, this.now());
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
    } else if (cutoff.targetType === CutoffTarget.TOOL) {
      // Its own reason is cleared; it serves again only if its handle's
      // takedown does not stand and it is still named under its owner's
      // current, active handle (`restoreTakenDownTool`).
      await restoreTakenDownTool(manager, cutoff.targetId);
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
        await restoreHandleTools(manager, org.id);
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
    // Its provider tools are named under the handle: they move with it.
    await renameHandleTools(manager, org.id, handle, next);
    await manager.update(
      OrganizationEntity,
      { id: org.id },
      { handle: next, handleSkeleton: handleSkeleton(next) },
    );
    // A tool left removed for want of an active handle serves under this one.
    await restoreHandleTools(manager, org.id);
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
    // Locked: a provider tool created under its current handle meanwhile is
    // renamed with the rest below, never left behind.
    const to = await manager.findOne(OrganizationEntity, {
      where: { id: toOrganizationId },
      lock: { mode: 'pessimistic_write' },
    });
    // The same 404 the pre-queue check gives, on the approved and the direct path alike.
    if (!to) throw ToolsetErrors.organizationNotFound();
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
    // The old holder's `{handle}__…` tools are tombstoned: they never come
    // back under the brand's name, and the names are free for the new holder.
    await tombstoneHandleTools(manager, from.id, handle);
    await manager.update(
      OrganizationEntity,
      { id: from.id },
      { handle: null, handleSkeleton: null, handleStatus: null, handleLockedAt: null },
    );
    // The handle it held but had not locked is released: its tools move to
    // the new name (refused past the 48-character cap), and any left removed
    // for want of an active handle serve under it.
    if (to.handle) {
      try {
        await renameHandleTools(manager, to.id, to.handle, handle);
      } catch (error) {
        if ((error as { context?: { reason?: string } }).context?.reason === 'TOOL_NAME_TOO_LONG') {
          throw ToolsetErrors.handleReassignRefused({
            reason: 'a provider tool name of the organization would pass 48 characters under it',
          });
        }
        throw error;
      }
    }
    await manager.update(
      OrganizationEntity,
      { id: to.id },
      { handle, handleSkeleton: handleSkeleton(handle), handleStatus: HandleStatus.ACTIVE },
    );
    await restoreHandleTools(manager, to.id);
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
    await this.contracts?.contractsChanged();
    await this.epochs.bumpShared();
    for (const id of new Set(organizationIds)) if (id) await this.epochs.bump(id);
  }

  /** Scheduler: revert every cutoff nobody confirmed within 72 hours. */
  async revertExpired(): Promise<number> {
    const due = await this.cutoffs.findDue(this.now());
    let reverted = 0;
    const lifted: string[] = [];
    const liftedHandles: string[] = [];
    for (const cutoff of due) {
      try {
        await this.dataSource.transaction((manager) =>
          this.revert(manager, cutoff.id, null, CutoffRevertReason.EXPIRED),
        );
        reverted += 1;
        if (cutoff.targetType === CutoffTarget.TOOL) lifted.push(cutoff.targetId);
        if (cutoff.targetType === CutoffTarget.HANDLE) liftedHandles.push(cutoff.targetId);
      } catch (error) {
        this.logger.warn(`cutoff ${cutoff.id} not reverted: ${String(error)}`);
      }
    }
    if (reverted > 0) await this.afterCommit();
    for (const toolId of lifted) await this.announceTool(toolId, 'TAKEDOWN_LIFTED');
    for (const handle of liftedHandles) await this.announceHandle(handle, 'TAKEDOWN_LIFTED');
    return reverted;
  }

  /** A provider tool's own takedown still in force, newest first; `null` if none. */
  async standingToolTakedown(
    manager: EntityManager,
    toolId: string,
  ): Promise<ModerationCutoffEntity | null> {
    return manager.findOne(ModerationCutoffEntity, {
      where: {
        targetType: CutoffTarget.TOOL,
        targetId: toolId,
        action: CutoffAction.TAKEDOWN,
        revertedAt: IsNull(),
      },
      order: { actedAt: 'DESC' },
    });
  }

  /**
   * Tells a handle's owner it was taken down, or that the takedown was
   * lifted — after the commit, once per handle. A lifted handle is told only
   * when it serves again under the same name (a reassigned one is somebody
   * else's). Best-effort, and never throws.
   */
  async announceHandle(handle: string, kind: 'TAKEN_DOWN' | 'TAKEDOWN_LIFTED'): Promise<void> {
    if (!this.notifications) return;
    try {
      const name = normalizeHandle(handle);
      const org = await this.dataSource
        .getRepository(OrganizationEntity)
        .createQueryBuilder('org')
        .where('lower(org.handle) = :handle', { handle: name })
        .getOne();
      if (!org) return;
      const status = kind === 'TAKEN_DOWN' ? HandleStatus.FROZEN : HandleStatus.ACTIVE;
      if (org.handleStatus !== status) return;
      await this.notifications.notify(
        handleNotification({ kind, organizationId: org.id, handle: name }),
      );
    } catch (error) {
      this.logger.error(`Handle ${handle}: could not notify: ${String(error)}`);
    }
  }

  /**
   * Tells a provider tool's owner it was taken down, or that its takedown
   * was lifted (rejected, lifted or lapsed) — after the commit. Best-effort,
   * and never throws: the cutoff stands whether or not this lands.
   */
  async announceTool(toolId: string, kind: 'TAKEN_DOWN' | 'TAKEDOWN_LIFTED'): Promise<void> {
    if (!this.notifications) return;
    try {
      const tool = await this.dataSource.getRepository(ToolEntity).findOne({
        where: { id: toolId },
        select: { id: true, name: true, ownerOrgId: true, kind: true, status: true },
      });
      if (!tool || tool.kind !== 'PROVIDER' || !tool.ownerOrgId) return;
      const facts = { organizationId: tool.ownerOrgId, toolId: tool.id, toolName: tool.name };
      const standing =
        kind === 'TAKEN_DOWN'
          ? await this.standingToolTakedown(this.dataSource.manager, toolId)
          : null;
      await this.notifications.notify(
        providerToolNotification(
          kind === 'TAKEN_DOWN'
            ? {
                ...facts,
                kind,
                reasonCode: standing?.publicReasonCode ?? null,
                publicNote: standing?.publicNote ?? null,
              }
            : { ...facts, kind, serving: tool.status !== 'REMOVED' },
        ),
      );
    } catch (error) {
      this.logger.error(`Provider tool ${toolId}: could not notify: ${String(error)}`);
    }
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
      publicReasonCode?: string | null;
      publicNote?: string | null;
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
      publicReasonCode: input.publicReasonCode ?? null,
      publicNote: input.publicNote ?? null,
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

  /**
   * The lookups a rename or reassign makes before it is queued for a second
   * operator, so a request naming a handle (or, for a reassign, an
   * organization) that does not exist is a 404 and never an approval. The
   * write re-checks everything under its locks once approved.
   */
  async assertHandleTargetsExist(
    rawHandle: string,
    toOrganizationId: string | null = null,
  ): Promise<void> {
    const manager = this.dataSource.manager;
    await this.requireHandleOwner(manager, normalizeHandle(rawHandle));
    if (toOrganizationId === null) return;
    const exists = await manager.exists(OrganizationEntity, { where: { id: toOrganizationId } });
    if (!exists) throw ToolsetErrors.organizationNotFound();
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
