import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolsetEntryEntity } from '@database/postgres/entities/toolset-entry.entity';
import { ToolsetVersionEntity } from '@database/postgres/entities/toolset-version.entity';
import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import {
  ToolsetStatsRepository,
  ToolsetVersionRepository,
} from '@database/postgres/repositories/toolset-sharing.repository';
import {
  ToolsetEntryRepository,
  ToolsetRepository,
} from '@database/postgres/repositories/toolset.repository';
import { ToolStatus } from '@modules/tool/ports/tool.types';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import {
  SharingAction,
  SharingState,
  SharingTransitionError,
  ToolsetVisibility,
  applySharing,
  isShared,
  listedInCatalogue,
  servesPublicPath,
  servesUnlistedPath,
} from '../domain/sharing';
import { SnapshotEntry, ToolsetSnapshot, changelogOf, diffSnapshots } from '../domain/snapshot';
import {
  CopyExcludedToolDto,
  CopyResultDto,
  CopyToolsetBodyDto,
  PublishResultDto,
  PublishToolsetBodyDto,
  ToolsetOwnStatsDto,
  ToolsetVersionDto,
  ToolsetVersionSummaryDto,
} from '../dto/toolset-publishing.dto';
import { ToolsetErrors } from '../errors/toolset.errors';
import { AccessEpochService } from './access-epoch.service';
import { HandlesService } from './handles.service';
import { sharingPatchOf, sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';
import { snapshotOfVersion, versionDtoOf, versionSummaryOf } from './version-mapping';
import { ToolsetNoticesService } from './toolset-notices.service';
import { TOOLSET_LIMITS, ToolsetsService, slugify } from './toolsets.service';

/** Limits of design spec §7.13 for publishing and copies. */
export const PUBLISHING_LIMITS = Object.freeze({
  versionsPerToolsetPerDay: 10,
  copiesPerOrgPerDay: 50,
});

/**
 * Publishing a toolset: the Share dialog, versions, the unlisted link, Make
 * my own version, and the owner's stats (design spec §7.7, §7.9).
 *
 * ```text
 * publish     next version = immutable snapshot of the Draft + settings; visibility per the state machine
 * unpublish   Stop sharing: old URLs serve the last version for 90 days
 * rotate      a new unlisted token; the old link dies at once
 * copy        a PRIVATE copy of a version this org can see, crediting its source, never updated
 * ```
 *
 * Shared URLs serve published versions only, never the Draft. Every write
 * bumps the owner's access epoch and, when it touches anything shared, the
 * sharing epoch every cached shared view is keyed on.
 */
@Injectable()
export class ToolsetPublishingService {
  private readonly logger = new Logger(ToolsetPublishingService.name);

  constructor(
    private readonly toolsets: ToolsetRepository,
    private readonly entries: ToolsetEntryRepository,
    private readonly versions: ToolsetVersionRepository,
    private readonly tools: ToolRepository,
    private readonly stats: ToolsetStatsRepository,
    private readonly owned: ToolsetsService,
    private readonly handles: HandlesService,
    private readonly epochs: AccessEpochService,
    private readonly audit: AuditLogWriter,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional() private readonly notices?: ToolsetNoticesService,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  /** `POST /toolsets/:id/publish`: the next version, and the visibility, in one step. */
  async publish(
    organizationId: string,
    id: string,
    body: PublishToolsetBodyDto,
    actor: AuditActor,
  ): Promise<PublishResultDto> {
    const now = this.now();
    const result = await this.dataSource.transaction(async (manager) => {
      const toolset = await this.lockOwned(manager, organizationId, id);
      const since = startOfUtcDay(now);
      const today = await manager
        .createQueryBuilder(ToolsetVersionEntity, 'v')
        .where('v.toolset_id = :id', { id: toolset.id })
        .andWhere('v.published_at >= :since', { since })
        .getCount();
      if (today >= PUBLISHING_LIMITS.versionsPerToolsetPerDay) {
        throw ToolsetErrors.limitExceeded({
          limit: 'versionsPerToolsetPerDay',
          max: PUBLISHING_LIMITS.versionsPerToolsetPerDay,
        });
      }

      const snapshot = await this.snapshotOfDraft(manager, toolset);
      await this.assertPublishable(organizationId, snapshot, body.visibility);

      const before = sharingStateOf(toolset);
      const next = this.transition(before, { kind: 'SHARE', visibility: body.visibility }, now);
      if (isShared(next)) await this.handles.lockForSharing(manager, organizationId);

      const previous = toolset.latestVersion
        ? await manager.findOne(ToolsetVersionEntity, {
            where: { toolsetId: toolset.id, version: toolset.latestVersion },
          })
        : null;
      const diff = diffSnapshots(previous ? snapshotOfVersion(previous) : null, snapshot);
      const version = (toolset.latestVersion ?? 0) + 1;
      const changelog = body.changelog?.trim() || changelogOf(diff, previous === null);

      await manager.insert(ToolsetVersionEntity, {
        toolsetId: toolset.id,
        version,
        entries: snapshot.entries as unknown as object,
        toolIds: snapshot.entries.map((entry) => entry.toolId),
        discovery: snapshot.discovery,
        searchThreshold: snapshot.searchThreshold,
        pinnedTools: [...snapshot.pinnedTools],
        name: snapshot.name,
        description: snapshot.description,
        icon: snapshot.icon,
        changelog,
        publishedAt: now,
      });
      await manager.update(
        ToolsetEntity,
        { id: toolset.id },
        {
          ...sharingPatchOf(next),
          latestVersion: version,
          lastSharedVersion: isShared(next) ? version : toolset.lastSharedVersion,
          updatedAt: now,
        },
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'toolset.published',
        resourceType: 'toolset',
        resourceId: toolset.id,
        before: { visibility: before.visibility, latestVersion: toolset.latestVersion },
        after: { visibility: next.visibility, latestVersion: version, changelog },
      });
      return {
        toolset,
        version,
        changelog,
        diff,
        sharedNow: isShared(next),
        touchedShared: isShared(before) || isShared(next) || before.graceUntil !== null,
      };
    });

    await this.epochs.bump(organizationId);
    if (result.touchedShared) await this.epochs.bumpShared();
    if (result.sharedNow && result.version > 1) {
      void this.notices
        ?.onPublished(result.toolset.id, result.version)
        .catch((error: unknown) =>
          this.logger.warn(
            `toolset ${result.toolset.id} v${result.version}: update notices failed: ${String(error)}`,
          ),
        );
    }

    return {
      toolset: await this.owned.get(organizationId, id),
      version: {
        version: result.version,
        publishedAt: now.toISOString(),
        changelog: result.changelog,
        name: result.toolset.name,
        toolCount: (await this.entries.findByToolsets([id])).length,
      },
      diff: {
        added: [...result.diff.added],
        removed: [...result.diff.removed],
        rulesChanged: [...result.diff.rulesChanged],
        settingsChanged: [...result.diff.settingsChanged],
      },
    };
  }

  /** `POST /toolsets/:id/unpublish` — Stop sharing. */
  async unpublish(
    organizationId: string,
    id: string,
    actor: AuditActor,
  ): Promise<PublishResultDto> {
    await this.changeSharing(organizationId, id, { kind: 'STOP' }, 'toolset.unpublished', actor);
    return { toolset: await this.owned.get(organizationId, id), version: null, diff: null };
  }

  /** `POST /toolsets/:id/unlisted-token/rotate` — the old link dies at once. */
  async rotateToken(
    organizationId: string,
    id: string,
    actor: AuditActor,
  ): Promise<PublishResultDto> {
    await this.changeSharing(
      organizationId,
      id,
      { kind: 'ROTATE' },
      'toolset.unlisted_token_rotated',
      actor,
    );
    return { toolset: await this.owned.get(organizationId, id), version: null, diff: null };
  }

  /** Every published version of an own toolset, newest first. */
  async listVersions(organizationId: string, id: string): Promise<ToolsetVersionSummaryDto[]> {
    const toolset = await this.requireOwned(organizationId, id);
    return (await this.versions.listVersions(toolset.id)).map(versionSummaryOf);
  }

  async getVersion(
    organizationId: string,
    id: string,
    version: number,
  ): Promise<ToolsetVersionDto> {
    const toolset = await this.requireOwned(organizationId, id);
    const row = await this.versions.findVersion(toolset.id, version);
    if (!row) throw ToolsetErrors.versionNotFound();
    return versionDtoOf(row);
  }

  /** `GET /toolsets/:id/stats` — own toolsets only; the weekly, k-checked figures. */
  async ownStats(organizationId: string, id: string): Promise<ToolsetOwnStatsDto> {
    const toolset = await this.requireOwned(organizationId, id);
    const row = (await this.stats.latestFor([toolset.id])).get(toolset.id);
    return {
      weekStart: row?.weekStart ?? null,
      figures: row?.figures ?? null,
      dashboard: row?.dashboard ?? null,
    };
  }

  /**
   * `POST /toolsets/:id/copy` — Make my own version (FR-8). The source must be
   * the caller's own, or one it can see: PUBLIC and LISTED (or in its PUBLIC
   * grace period), or link-only with the current token. Anything else is the
   * same 404 as a missing id. Another organization's link-only provider tools
   * are not copied: they are reachable only through their provider's own
   * toolsets (§7.6).
   */
  async copy(
    organizationId: string,
    sourceId: string,
    body: CopyToolsetBodyDto,
    actor: AuditActor,
  ): Promise<CopyResultDto> {
    const source = await this.toolsets.findAnyById(sourceId);
    if (!source) throw ToolsetErrors.notFound();
    const own = source.ownerOrgId === organizationId;
    const now = this.now();

    let snapshot: ToolsetSnapshot;
    let version: number | null;
    if (own && !source.deletedAt && body.version === undefined) {
      snapshot = await this.snapshotOfDraft(this.dataSource.manager, source);
      version = null;
    } else {
      if (!own && !visibleToOthers(sharingStateOf(source), body.unlistedToken, now)) {
        throw ToolsetErrors.notFound();
      }
      if (own && source.deletedAt) throw ToolsetErrors.notFound();
      // Another organization sees only what was published while shared.
      const newest = own ? source.latestVersion : source.lastSharedVersion;
      version = body.version ?? newest;
      if (!version || !newest || version > newest) throw ToolsetErrors.versionNotFound();
      const row = await this.versions.findVersion(source.id, version);
      if (!row) throw ToolsetErrors.versionNotFound();
      snapshot = snapshotOfVersion(row);
    }

    const since = startOfUtcDay(now);
    const copiesToday = await this.toolsets
      .createQueryBuilder('t')
      .where('t.owner_org_id = :organizationId', { organizationId })
      .andWhere('t.forked_from_id IS NOT NULL')
      .andWhere('t.created_at >= :since', { since })
      .getCount();
    if (copiesToday >= PUBLISHING_LIMITS.copiesPerOrgPerDay) {
      throw ToolsetErrors.limitExceeded({
        limit: 'copiesPerOrgPerDay',
        max: PUBLISHING_LIMITS.copiesPerOrgPerDay,
      });
    }
    if ((await this.toolsets.countOwned(organizationId)) >= TOOLSET_LIMITS.toolsetsPerOrg) {
      throw ToolsetErrors.limitExceeded({
        limit: 'toolsetsPerOrg',
        max: TOOLSET_LIMITS.toolsetsPerOrg,
      });
    }

    const tools = new Map(
      (await this.tools.findByIds(snapshot.entries.map((entry) => entry.toolId))).map((tool) => [
        tool.id,
        tool,
      ]),
    );
    const excluded: CopyExcludedToolDto[] = [];
    const kept: SnapshotEntry[] = [];
    for (const entry of snapshot.entries) {
      const tool = tools.get(entry.toolId);
      const reason = copyExclusion(tool, organizationId);
      if (reason) excluded.push({ toolId: entry.toolId, toolName: entry.toolName, reason });
      else kept.push(entry);
    }
    const keptNames = new Set(kept.map((entry) => tools.get(entry.toolId)?.name));

    const name = body.name ?? snapshot.name;
    const copyId = await this.dataSource.transaction(async (manager) => {
      const slug = await this.freeSlug(organizationId, slugify(name));
      const created = await manager.save(ToolsetEntity, {
        ownerOrgId: organizationId,
        publisherKind: 'USER',
        slug,
        name,
        description: snapshot.description,
        category: source.category,
        tags: source.tags,
        icon: snapshot.icon,
        visibility: ToolsetVisibility.PRIVATE,
        discovery: snapshot.discovery,
        searchThreshold: snapshot.searchThreshold,
        pinnedTools: snapshot.pinnedTools.filter((tool) => keptNames.has(tool)),
        forkedFromId: source.id,
        forkedFromVersion: version,
      });
      if (kept.length > 0) {
        await manager.insert(
          ToolsetEntryEntity,
          kept.map((entry, position) => entryRowOf(created.id, position, entry)),
        );
      }
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'toolset.copied',
        resourceType: 'toolset',
        resourceId: created.id,
        before: null,
        after: {
          forkedFromId: source.id,
          forkedFromVersion: version,
          excluded: excluded.map((tool) => tool.toolId),
        },
      });
      return created.id;
    });

    await this.epochs.bump(organizationId);
    return { toolset: await this.owned.get(organizationId, copyId), excluded };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async changeSharing(
    organizationId: string,
    id: string,
    action: SharingAction,
    auditAction: string,
    actor: AuditActor,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const toolset = await this.lockOwned(manager, organizationId, id);
      const before = sharingStateOf(toolset);
      const next = this.transition(before, action, this.now());
      if (next === before) return;
      await manager.update(ToolsetEntity, { id: toolset.id }, sharingPatchOf(next));
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: auditAction,
        resourceType: 'toolset',
        resourceId: toolset.id,
        before: { visibility: before.visibility },
        // Never the token: the audit trail is readable by more people than the link is.
        after: { visibility: next.visibility, graceUntil: next.graceUntil?.toISOString() ?? null },
      });
    });
    await this.epochs.bump(organizationId);
    await this.epochs.bumpShared();
  }

  private transition(state: SharingState, action: SharingAction, now: Date): SharingState {
    try {
      return applySharing(state, action, now);
    } catch (error) {
      if (error instanceof SharingTransitionError) {
        throw ToolsetErrors.sharingRefused({ refusal: error.refusal });
      }
      throw error;
    }
  }

  /** PUBLIC holds only LISTED tools that still serve (§7.7); every share needs at least one tool. */
  private async assertPublishable(
    organizationId: string,
    snapshot: ToolsetSnapshot,
    visibility: ToolsetVisibility,
  ): Promise<void> {
    if (snapshot.entries.length === 0) {
      throw ToolsetErrors.notPublishable({ reason: 'a tool set needs at least one tool' });
    }
    const tools = new Map(
      (await this.tools.findByIds(snapshot.entries.map((entry) => entry.toolId))).map((tool) => [
        tool.id,
        tool,
      ]),
    );
    const refused = snapshot.entries
      .filter((entry) => {
        const tool = tools.get(entry.toolId);
        if (!tool || tool.status === ToolStatus.REMOVED || tool.status === 'RETIRED') return true;
        if (tool.visibility === 'LISTED') return false;
        // An UNLISTED tool may sit only in its own provider's non-public toolsets (§7.6).
        return visibility === ToolsetVisibility.PUBLIC || tool.ownerOrgId !== organizationId;
      })
      .map((entry) => entry.toolId);
    if (refused.length > 0) {
      throw ToolsetErrors.notPublishable({
        reason:
          visibility === ToolsetVisibility.PUBLIC
            ? 'a listed tool set may hold only listed tools'
            : 'some tools are no longer available',
        toolIds: refused,
      });
    }
  }

  private async snapshotOfDraft(
    manager: EntityManager,
    toolset: ToolsetEntity,
  ): Promise<ToolsetSnapshot> {
    const rows = await manager.find(ToolsetEntryEntity, {
      where: { toolsetId: toolset.id },
      order: { position: 'ASC' },
    });
    const names = new Map(
      (await this.tools.findByIds(rows.map((row) => row.toolId))).map((tool) => [
        tool.id,
        tool.name,
      ]),
    );
    return {
      entries: rows.map((row) => ({
        toolId: row.toolId,
        toolName: names.get(row.toolId) ?? '',
        providerMode: row.providerMode,
        providerIds: [...row.providerIds],
        minTier: row.minTier,
        maxPrice:
          row.maxPriceAmount !== null && row.maxPriceAssetId && row.maxPriceDecimals !== null
            ? {
                amount: row.maxPriceAmount,
                asset: row.maxPriceAssetId,
                decimals: row.maxPriceDecimals,
              }
            : null,
        minQuality: row.minQuality === null ? null : Number(row.minQuality),
        requireOutputFields: [...row.requireOutputFields],
        onEmpty: row.onEmpty,
      })),
      discovery: toolset.discovery,
      searchThreshold: toolset.searchThreshold,
      pinnedTools: [...toolset.pinnedTools],
      name: toolset.name,
      description: toolset.description,
      icon: toolset.icon,
    };
  }

  /** The owned, live row, locked for this transaction: publishes of one toolset serialise. */
  private async lockOwned(
    manager: EntityManager,
    organizationId: string,
    id: string,
  ): Promise<ToolsetEntity> {
    const toolset = await manager
      .createQueryBuilder(ToolsetEntity, 'toolset')
      .setLock('pessimistic_write')
      .where('toolset.id = :id', { id })
      .andWhere('toolset.owner_org_id = :organizationId', { organizationId })
      .andWhere('toolset.deleted_at IS NULL')
      .getOne();
    if (!toolset) throw ToolsetErrors.notFound();
    return toolset;
  }

  private async requireOwned(organizationId: string, id: string): Promise<ToolsetEntity> {
    const toolset = await this.toolsets.findOwned(organizationId, id);
    if (!toolset) throw ToolsetErrors.notFound();
    return toolset;
  }

  private async freeSlug(organizationId: string, base: string): Promise<string> {
    const taken = new Set(await this.toolsets.slugsLike(organizationId, base));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}

/** Another organization may see a toolset: listed, in its public grace, or with the live token. */
export function visibleToOthers(
  state: SharingState,
  token: string | undefined,
  now: Date,
): boolean {
  if (listedInCatalogue(state) || servesPublicPath(state, now)) return true;
  return (
    token !== undefined &&
    state.unlistedToken !== null &&
    token === state.unlistedToken &&
    servesUnlistedPath(state, now)
  );
}

/** Why a copy leaves this tool out, or `null` to keep it. */
export function copyExclusion(
  tool: Pick<ToolEntity, 'status' | 'visibility' | 'ownerOrgId'> | undefined,
  organizationId: string,
): 'LINK_ONLY' | 'REMOVED' | null {
  if (!tool || tool.status === ToolStatus.REMOVED || tool.status === 'RETIRED') return 'REMOVED';
  if (tool.visibility !== 'LISTED' && tool.ownerOrgId !== organizationId) return 'LINK_ONLY';
  return null;
}

function entryRowOf(
  toolsetId: string,
  position: number,
  entry: SnapshotEntry,
): Partial<ToolsetEntryEntity> {
  return {
    toolsetId,
    position,
    toolId: entry.toolId,
    providerMode: entry.providerMode,
    providerIds: [...entry.providerIds],
    minTier: entry.minTier,
    maxPriceAmount: entry.maxPrice?.amount ?? null,
    maxPriceAssetId: entry.maxPrice?.asset ?? null,
    maxPriceDecimals: entry.maxPrice?.decimals ?? null,
    minQuality: entry.minQuality === null ? null : String(entry.minQuality),
    requireOutputFields: [...entry.requireOutputFields],
    onEmpty: entry.onEmpty,
  };
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
