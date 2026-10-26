import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';

import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ToolsetEntryEntity } from '@database/postgres/entities/toolset-entry.entity';
import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';
import { OnEmpty, ProviderMode } from '@modules/tool/domain/routing';
import { ToolStatus } from '@modules/tool/ports/tool.types';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import { OFFICIAL_HANDLE } from '../domain/handle';
import {
  SharingState,
  SharingTransitionError,
  ToolsetVisibility,
  applySharing,
  isShared,
} from '../domain/sharing';
import { SnapshotDiff, ToolsetSnapshot, diffSnapshots, isEmptyDiff } from '../domain/snapshot';
import { OfficialToolsetDto, OfficialToolsetEntryDto } from '../dto/official-toolset.dto';
import { ToolsetErrors } from '../errors/toolset.errors';
import { AccessEpochService } from './access-epoch.service';
import { sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';
import { ToolsetNoticesService } from './toolset-notices.service';
import { TOOLSET_LIMITS, inferCategory } from './toolsets.service';
import {
  assertVersionBudget,
  latestVersionSnapshot,
  snapshotOfDraft,
  writeNextVersion,
} from './version-writer';

/** Limits of an official set, tighter than an organization's (§7.13). */
export const OFFICIAL_TOOLSET_LIMITS = Object.freeze({
  tools: 50,
  tags: 10,
  pinnedTools: TOOLSET_LIMITS.pinnedTools,
});

/** What an operator writes onto an official set's Draft. Every field optional on an update. */
export interface OfficialToolsetInput {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly category?: string | null;
  readonly tags?: readonly string[];
  readonly icon?: string | null;
  /** The tools, in order: each a LISTED, ACTIVE tool, routed to its current major. */
  readonly toolIds?: readonly string[];
  readonly pinnedTools?: readonly string[];
}

export interface OfficialPublishResult {
  readonly toolsetId: string;
  readonly version: number;
  readonly changelog: string;
  readonly diff: SnapshotDiff;
  /** {@link officialDraftHash} of what was published. */
  readonly contentHash: string;
  readonly before: { readonly visibility: string; readonly latestVersion: number | null };
}

/**
 * The platform's own tool sets, served at `/@assay/{slug}` (design spec
 * §7.10, §7.12): the one writer of `toolsets` rows with no owner.
 *
 * ```text
 * createDraft   PRIVATE, no version: serves nothing
 * updateDraft   the live version is unchanged; category and tags change the live row at once
 * publish       the next version, an immutable snapshot of the Draft; PUBLIC, LISTED
 *               (DELISTED while an operator's delist stands)
 * ```
 *
 * Every write takes the caller's `EntityManager`, as `ToolsetModerationService`
 * does, so the operator service runs a publish inside `OverrideLogService.perform`
 * and its register entry commits with it. After a commit the caller calls
 * {@link afterPublish} or {@link afterDraftChange}, which move the sharing epoch.
 *
 * Each entry is a LISTED, ACTIVE tool, provider mode BEST, routed to the tool's
 * current major (`^N`) — kept when the tool is already in the set.
 */
@Injectable()
export class OfficialToolsetsService {
  private readonly logger = new Logger(OfficialToolsetsService.name);

  constructor(
    private readonly toolsets: ToolsetRepository,
    private readonly epochs: AccessEpochService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
    @Optional() private readonly notices?: ToolsetNoticesService,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Every official set, Drafts and delisted ones included, oldest first. */
  async list(): Promise<OfficialToolsetDto[]> {
    const rows = await this.dataSource.manager.find(ToolsetEntity, {
      where: { ownerOrgId: IsNull(), deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
    return this.toDtos(rows);
  }

  async get(id: string): Promise<OfficialToolsetDto> {
    const row = await this.dataSource.manager.findOne(ToolsetEntity, {
      where: { id, ownerOrgId: IsNull(), deletedAt: IsNull() },
    });
    if (!row) throw ToolsetErrors.notFound();
    return (await this.toDtos([row]))[0];
  }

  /** The id of the official set holding `slug`, or `null`. */
  async idOfSlug(slug: string): Promise<string | null> {
    return (await this.toolsets.findHolderOfSlug(null, slug))?.id ?? null;
  }

  /** {@link officialDraftHash} of the Draft as it is now. */
  async contentHash(manager: EntityManager, id: string): Promise<string> {
    const toolset = await this.requireOfficial(manager, id, false);
    return officialDraftHash(toolset.slug, await snapshotOfDraft(manager, toolset));
  }

  // ── Drafts ────────────────────────────────────────────────────────────────

  /** A new PRIVATE Draft; returns its id. 409 `TOOLSET_SLUG_TAKEN` with a free suggestion. */
  async createDraft(
    manager: EntityManager,
    input: OfficialToolsetInput & { slug: string; name: string; toolIds: readonly string[] },
  ): Promise<string> {
    await this.assertFreeSlug(input.slug);
    const tools = await this.validTools(manager, input.toolIds, new Map());
    const pinnedTools = validPinned(
      input.pinnedTools ?? [],
      tools.map((entry) => entry.tool.name),
    );
    const id = await this.insertOrSlugTaken(input.slug, async () => {
      const saved = await manager.save(ToolsetEntity, {
        ownerOrgId: null,
        publisherKind: 'PLATFORM',
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? inferCategory(tools),
        tags: validTags(input.tags ?? []),
        icon: input.icon ?? null,
        visibility: ToolsetVisibility.PRIVATE,
        discovery: 'AUTO',
        searchThreshold: 25,
        pinnedTools,
      });
      return saved.id;
    });
    await writeEntries(manager, id, tools);
    return id;
  }

  /**
   * Edit the Draft. The slug is fixed from the first publish; a tool already
   * in the set keeps its range. Returns whether the live row changed
   * (category or tags of a shared set), for {@link afterDraftChange}.
   */
  async updateDraft(
    manager: EntityManager,
    id: string,
    input: OfficialToolsetInput,
  ): Promise<{ liveChanged: boolean }> {
    const toolset = await this.requireOfficial(manager, id, true);
    const patch: Partial<ToolsetEntity> = {};
    if (input.slug !== undefined && input.slug !== toolset.slug) {
      // Shared URLs and pinned versions name the slug.
      if (toolset.firstSharedAt) throw ToolsetErrors.slugLocked();
      await this.assertFreeSlug(input.slug);
      patch.slug = input.slug;
    }
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.category !== undefined) patch.category = input.category;
    if (input.tags !== undefined) patch.tags = validTags(input.tags);
    if (input.icon !== undefined) patch.icon = input.icon;

    let names: string[];
    if (input.toolIds !== undefined) {
      const stored = await manager.find(ToolsetEntryEntity, { where: { toolsetId: toolset.id } });
      const tools = await this.validTools(
        manager,
        input.toolIds,
        new Map(stored.map((row) => [row.toolId, row.toolVersionRange])),
      );
      await manager.delete(ToolsetEntryEntity, { toolsetId: toolset.id });
      await writeEntries(manager, toolset.id, tools);
      names = tools.map((entry) => entry.tool.name);
      // A pinned tool the new Draft no longer holds stops being pinned.
      if (input.pinnedTools === undefined) {
        patch.pinnedTools = toolset.pinnedTools.filter((name) => names.includes(name));
      }
    } else {
      names = (await snapshotOfDraft(manager, toolset)).entries.map((entry) => entry.toolName);
    }
    if (input.pinnedTools !== undefined) patch.pinnedTools = validPinned(input.pinnedTools, names);

    if (Object.keys(patch).length > 0 || input.toolIds !== undefined) {
      await this.insertOrSlugTaken(patch.slug ?? toolset.slug, () =>
        manager.update(ToolsetEntity, { id: toolset.id }, { ...patch, updatedAt: this.now() }),
      );
    }
    return {
      liveChanged:
        isShared(sharingStateOf(toolset)) &&
        (patch.category !== undefined || patch.tags !== undefined),
    };
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  /**
   * The next version of the Draft, shared PUBLIC. With `expectedHash` (the
   * approver's re-run), the Draft must still be exactly what was requested.
   */
  async publish(
    manager: EntityManager,
    id: string,
    options: { readonly changelog?: string | null; readonly expectedHash?: string } = {},
  ): Promise<OfficialPublishResult> {
    const now = this.now();
    const toolset = await this.requireOfficial(manager, id, true);
    const snapshot = await snapshotOfDraft(manager, toolset);
    const contentHash = officialDraftHash(toolset.slug, snapshot);
    if (options.expectedHash !== undefined && options.expectedHash !== contentHash) {
      throw ToolsetErrors.state({
        reason: 'the draft changed after its publish was requested; request it again',
      });
    }
    await this.assertPublishable(manager, toolset, snapshot);
    await assertVersionBudget(manager, toolset.id, now);

    const before = sharingStateOf(toolset);
    const next = transition(before, now);
    const written = await writeNextVersion(manager, {
      toolset,
      snapshot,
      next,
      changelog: options.changelog,
      now,
    });
    return {
      toolsetId: toolset.id,
      version: written.version,
      changelog: written.changelog,
      diff: written.diff,
      contentHash,
      before: { visibility: before.visibility, latestVersion: toolset.latestVersion },
    };
  }

  /**
   * Refused before anything is queued or written: an empty set, a tool that
   * is no longer LISTED and ACTIVE, or a Draft identical to the live version.
   */
  async assertPublishableNow(manager: EntityManager, id: string): Promise<void> {
    const toolset = await this.requireOfficial(manager, id, false);
    await this.assertPublishable(manager, toolset, await snapshotOfDraft(manager, toolset));
  }

  /** After the publish committed: every cached shared view re-reads, and pinned users hear of vN+1. */
  async afterPublish(result: Pick<OfficialPublishResult, 'toolsetId' | 'version'>): Promise<void> {
    await this.epochs.bumpShared();
    if (result.version > 1) {
      void this.notices
        ?.onPublished(result.toolsetId, result.version)
        .catch((error: unknown) =>
          this.logger.warn(
            `official toolset ${result.toolsetId} v${result.version}: update notices failed: ${String(error)}`,
          ),
        );
    }
  }

  /** After a Draft edit committed: only category and tags reach shared views. */
  async afterDraftChange(result: { liveChanged: boolean }): Promise<void> {
    if (result.liveChanged) await this.epochs.bumpShared();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async requireOfficial(
    manager: EntityManager,
    id: string,
    lock: boolean,
  ): Promise<ToolsetEntity> {
    const row = await manager.findOne(ToolsetEntity, {
      where: { id, ownerOrgId: IsNull(), deletedAt: IsNull() },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!row) throw ToolsetErrors.notFound();
    return row;
  }

  private async assertPublishable(
    manager: EntityManager,
    toolset: ToolsetEntity,
    snapshot: ToolsetSnapshot,
  ): Promise<void> {
    if (snapshot.entries.length === 0) {
      throw ToolsetErrors.notPublishable({ reason: 'a tool set needs at least one tool' });
    }
    const tools = new Map(
      (
        await manager.find(ToolEntity, {
          where: { id: In(snapshot.entries.map((entry) => entry.toolId)) },
        })
      ).map((tool) => [tool.id, tool]),
    );
    const refused = snapshot.entries
      .filter((entry) => !servesListed(tools.get(entry.toolId)))
      .map((entry) => entry.toolId);
    if (refused.length > 0) {
      throw ToolsetErrors.notPublishable({
        reason: 'an official tool set may hold only listed tools that are active',
        toolIds: refused,
      });
    }
    if (toolset.visibility === ToolsetVisibility.PUBLIC && toolset.latestVersion) {
      const live = await latestVersionSnapshot(manager, toolset);
      if (live && isEmptyDiff(diffSnapshots(live, snapshot))) {
        throw ToolsetErrors.state({ reason: `nothing changed since v${toolset.latestVersion}` });
      }
    }
  }

  private async validTools(
    manager: EntityManager,
    toolIds: readonly string[],
    storedRanges: ReadonlyMap<string, string | null>,
  ): Promise<ValidTool[]> {
    if (toolIds.length === 0 || toolIds.length > OFFICIAL_TOOLSET_LIMITS.tools) {
      throw ToolsetErrors.invalid({
        reason: `an official tool set holds 1 to ${OFFICIAL_TOOLSET_LIMITS.tools} tools`,
      });
    }
    const duplicate = toolIds.find((id, index) => toolIds.indexOf(id) !== index);
    if (duplicate) {
      throw ToolsetErrors.invalid({ reason: 'a tool appears twice', toolIds: [duplicate] });
    }
    const tools = new Map(
      (await manager.find(ToolEntity, { where: { id: In([...toolIds]) } })).map((tool) => [
        tool.id,
        tool,
      ]),
    );
    const refused = toolIds.filter((id) => !servesListed(tools.get(id)));
    if (refused.length > 0) {
      throw ToolsetErrors.invalid({
        reason: 'only listed tools that are active can be in an official tool set',
        toolIds: refused,
      });
    }
    const versions = await manager.find(ToolVersionEntity, {
      where: { toolId: In([...toolIds]) },
    });
    return toolIds.map((id) => {
      const tool = tools.get(id) as ToolEntity;
      const current = versions.find(
        (version) => version.toolId === id && version.version === tool.currentVersion,
      );
      return {
        tool,
        // The current major, as a Draft entry added through the API gets (§7.2, T3).
        toolVersionRange: storedRanges.get(id) ?? `^${current?.major ?? 1}`,
      };
    });
  }

  private async assertFreeSlug(slug: string): Promise<void> {
    if (await this.toolsets.findHolderOfSlug(null, slug)) {
      throw ToolsetErrors.slugTaken({ slug, suggestion: await this.freeSlug(slug) });
    }
  }

  /** The unique index decides a race the pre-check lost: the same 409, never a 500. */
  private async insertOrSlugTaken<T>(slug: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw ToolsetErrors.slugTaken({ slug, suggestion: await this.freeSlug(slug) });
      }
      throw error;
    }
  }

  private async freeSlug(base: string): Promise<string> {
    const taken = new Set(await this.toolsets.slugsLike(null, base));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private async toDtos(rows: readonly ToolsetEntity[]): Promise<OfficialToolsetDto[]> {
    if (rows.length === 0) return [];
    const manager = this.dataSource.manager;
    const entries = await manager.find(ToolsetEntryEntity, {
      where: { toolsetId: In(rows.map((row) => row.id)) },
      order: { position: 'ASC' },
    });
    const toolIds = [...new Set(entries.map((entry) => entry.toolId))];
    const tools = new Map(
      (toolIds.length ? await manager.find(ToolEntity, { where: { id: In(toolIds) } }) : []).map(
        (tool) => [tool.id, tool],
      ),
    );
    const bindings = new Map(
      (toolIds.length
        ? ((await manager.query(
            `SELECT tool_id AS "toolId", count(*)::int AS n FROM tool_bindings
              WHERE status = 'ACTIVE' AND tool_id = ANY($1::uuid[]) GROUP BY tool_id`,
            [toolIds],
          )) as { toolId: string; n: number }[])
        : []
      ).map((row) => [row.toolId, Number(row.n)]),
    );

    return Promise.all(
      rows.map(async (row) => {
        const own = entries.filter((entry) => entry.toolsetId === row.id);
        const live = await latestVersionSnapshot(manager, row);
        const draft = await snapshotOfDraft(manager, row);
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          category: row.category,
          tags: row.tags,
          icon: row.icon,
          pinnedTools: row.pinnedTools,
          visibility: row.visibility,
          listingStatus: row.listingStatus,
          delisted: row.delistedAt !== null,
          removed: row.removedAt !== null,
          latestVersion: row.latestVersion,
          draftChanged: !live || !isEmptyDiff(diffSnapshots(live, draft)),
          slugLocked: row.firstSharedAt !== null,
          publicUrl:
            row.visibility === ToolsetVisibility.PUBLIC
              ? `${this.host.mcpPublicUrl}/@${OFFICIAL_HANDLE}/${row.slug}`
              : null,
          entries: own.map((entry): OfficialToolsetEntryDto => {
            const tool = tools.get(entry.toolId);
            return {
              position: entry.position,
              toolId: entry.toolId,
              toolName: tool?.name ?? '',
              category: tool?.category ?? '',
              toolVersionRange: entry.toolVersionRange ?? null,
              toolStatus: tool?.status ?? ToolStatus.REMOVED,
              toolVisibility: tool?.visibility ?? 'PRIVATE',
              bindingCount: bindings.get(entry.toolId) ?? 0,
            };
          }),
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
      }),
    );
  }
}

/**
 * What a P-13 request is for: the slug and the snapshot the next version
 * would freeze. The approver's re-run publishes only if this is unchanged.
 * The snapshot is built in a fixed key order, so plain JSON is canonical.
 */
export function officialDraftHash(slug: string, snapshot: ToolsetSnapshot): string {
  return createHash('sha256').update(JSON.stringify({ slug, snapshot }), 'utf8').digest('hex');
}

interface ValidTool {
  readonly tool: ToolEntity;
  readonly toolVersionRange: string;
}

/** LISTED, ACTIVE, and not taken down by itself or with its handle. */
function servesListed(tool: ToolEntity | undefined): boolean {
  return Boolean(
    tool &&
    tool.visibility === 'LISTED' &&
    tool.status === ToolStatus.ACTIVE &&
    !tool.takenDownAt &&
    !tool.handleRemovedAt,
  );
}

function validPinned(pinned: readonly string[], toolNames: readonly string[]): string[] {
  const names = [...new Set(pinned)];
  if (names.length > OFFICIAL_TOOLSET_LIMITS.pinnedTools) {
    throw ToolsetErrors.limitExceeded({
      limit: 'pinnedTools',
      max: OFFICIAL_TOOLSET_LIMITS.pinnedTools,
    });
  }
  const missing = names.filter((name) => !toolNames.includes(name));
  if (missing.length > 0) {
    throw ToolsetErrors.invalid({
      reason: `pinned tools not in this tool set: ${missing.join(', ')}`,
    });
  }
  return names;
}

function validTags(tags: readonly string[]): string[] {
  const unique = [...new Set(tags)];
  if (unique.length > OFFICIAL_TOOLSET_LIMITS.tags) {
    throw ToolsetErrors.invalid({ reason: `at most ${OFFICIAL_TOOLSET_LIMITS.tags} tags` });
  }
  return unique;
}

async function writeEntries(
  manager: EntityManager,
  toolsetId: string,
  tools: readonly ValidTool[],
): Promise<void> {
  await manager.insert(
    ToolsetEntryEntity,
    tools.map((entry, position) => ({
      toolsetId,
      position,
      toolId: entry.tool.id,
      providerMode: ProviderMode.BEST,
      providerIds: [],
      minTier: null,
      maxPriceAmount: null,
      maxPriceAssetId: null,
      maxPriceDecimals: null,
      minQuality: null,
      onEmpty: OnEmpty.FAIL,
      toolVersionRange: entry.toolVersionRange,
      requireOutputFields: [],
    })),
  );
}

function transition(state: SharingState, now: Date): SharingState {
  try {
    return applySharing(state, { kind: 'SHARE', visibility: ToolsetVisibility.PUBLIC }, now);
  } catch (error) {
    if (error instanceof SharingTransitionError) {
      throw ToolsetErrors.sharingRefused({ refusal: error.refusal });
    }
    throw error;
  }
}
