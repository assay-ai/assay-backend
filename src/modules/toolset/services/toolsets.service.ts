import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { ToolsetEntryEntity } from '@database/postgres/entities/toolset-entry.entity';
import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ToolVersionRepository } from '@database/postgres/repositories/tool-version.repository';
import { formatVersionRange, parseVersionRange } from '@modules/tool/domain/contract/version-range';
import {
  ToolsetEntryRepository,
  ToolsetRepository,
} from '@database/postgres/repositories/toolset.repository';
import { getAssetMetadata, isRegisteredAsset } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';
import { OnEmpty, ProviderMode } from '@modules/tool/domain/routing';
import { ToolStatus, ToolVersionStatus } from '@modules/tool/ports/tool.types';
import { CursorPageDto, ListQueryDto, ListSpec, asInstant, paginate } from '@shared/api';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import {
  CreateToolsetBodyDto,
  ToolsetDto,
  ToolsetEntryDto,
  ToolsetEntryInputDto,
  ToolsetSummaryDto,
  UpdateToolsetBodyDto,
} from '../dto/toolset.dto';
import { ToolsetErrors } from '../errors/toolset.errors';
import {
  SharingTransitionError,
  ToolsetVisibility,
  applySharing,
  isShared,
  sharingEndsAt,
} from '../domain/sharing';
import { OFFICIAL_HANDLE } from '../domain/handle';
import { AccessEpochService } from './access-epoch.service';
import { HandlesService } from './handles.service';
import { sharingPatchOf, sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

/** Limits of design spec §7.13. Beyond one the REST API answers 429. */
export const TOOLSET_LIMITS = Object.freeze({
  entriesPerToolset: 200,
  pinnedTools: 5,
  toolsetsPerOrg: 100,
});

const TOOLSET_LIST: ListSpec = {
  alias: 'toolset',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'toolset.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: ToolsetEntity) => row.createdAt),
    },
  },
};

/**
 * A buyer's own toolsets: create, read, edit, delete, and the Draft
 * (design spec §7.7, §7.9, the T1 subset).
 *
 * Every read and write names the caller's organization, so a toolset of
 * another organization is a 404, never a 403. Every write bumps the
 * organization's access epoch: `/my/{slug}` serves the Draft live, and an
 * access policy that allows a toolset allows exactly its current entries.
 *
 * Publishing, sharing, versions and copies are T2.
 */
@Injectable()
export class ToolsetsService {
  constructor(
    private readonly toolsets: ToolsetRepository,
    private readonly entries: ToolsetEntryRepository,
    private readonly tools: ToolRepository,
    private readonly toolVersions: ToolVersionRepository,
    private readonly epochs: AccessEpochService,
    private readonly audit: AuditLogWriter,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
    private readonly handles: HandlesService,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  async list(
    organizationId: string,
    query: ListQueryDto,
  ): Promise<CursorPageDto<ToolsetSummaryDto>> {
    const qb = this.toolsets
      .createQueryBuilder('toolset')
      .where('toolset.owner_org_id = :organizationId', { organizationId })
      .andWhere('toolset.deleted_at IS NULL');
    const page = await paginate(qb, query, TOOLSET_LIST);

    const counts = await this.entryCounts(page.items.map((toolset) => toolset.id));
    const handle = (await this.handles.handlesOf([organizationId])).get(organizationId) ?? null;
    return page.map((toolset) => this.toSummary(toolset, counts.get(toolset.id) ?? 0, handle));
  }

  async get(organizationId: string, id: string): Promise<ToolsetDto> {
    const toolset = await this.requireOwned(organizationId, id);
    return this.toDto(toolset, await this.entries.findByToolsets([toolset.id]));
  }

  async create(
    organizationId: string,
    body: CreateToolsetBodyDto,
    actor: AuditActor,
  ): Promise<ToolsetDto> {
    if ((await this.toolsets.countOwned(organizationId)) >= TOOLSET_LIMITS.toolsetsPerOrg) {
      throw ToolsetErrors.limitExceeded({
        limit: 'toolsetsPerOrg',
        max: TOOLSET_LIMITS.toolsetsPerOrg,
      });
    }

    const entries = await this.validateEntries(body.entries ?? []);
    const toolNames = new Map(entries.map((entry) => [entry.toolId, entry.tool.name]));
    const pinnedTools = this.validatePinned(body.pinnedTools ?? [], [...toolNames.values()]);
    const slug = body.slug
      ? await this.requireFreeSlug(organizationId, body.slug)
      : await this.freeSlug(organizationId, slugify(body.name));

    const saved = await this.dataSource.transaction(async (manager) => {
      const toolset = await manager.save(ToolsetEntity, {
        ownerOrgId: organizationId,
        publisherKind: 'USER',
        slug,
        name: body.name,
        description: body.description ?? null,
        category: body.category ?? inferCategory(entries),
        tags: dedupe(body.tags ?? []),
        icon: body.icon ?? null,
        visibility: 'PRIVATE',
        discovery: body.discovery ?? 'AUTO',
        searchThreshold: body.searchThreshold ?? 25,
        pinnedTools,
      });
      await this.writeEntries(manager, toolset.id, entries);
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'toolset.created',
        resourceType: 'toolset',
        resourceId: toolset.id,
        before: null,
        after: { slug, name: body.name, toolCount: entries.length },
      });
      return toolset;
    });

    await this.epochs.bump(organizationId);
    return this.get(organizationId, saved.id);
  }

  async update(
    organizationId: string,
    id: string,
    body: UpdateToolsetBodyDto,
    actor: AuditActor,
  ): Promise<ToolsetDto> {
    const toolset = await this.requireOwned(organizationId, id);
    const rows = await this.entries.findByToolsets([toolset.id]);

    const patch: Partial<ToolsetEntity> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined && body.slug !== toolset.slug) {
      // Shared URLs and pinned versions name the slug: it is fixed from the first share.
      if (toolset.firstSharedAt) throw ToolsetErrors.slugLocked();
      patch.slug = await this.requireFreeSlug(organizationId, body.slug);
    }
    if (body.description !== undefined) patch.description = body.description;
    if (body.category !== undefined) patch.category = body.category;
    if (body.tags !== undefined) patch.tags = dedupe(body.tags);
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.discovery !== undefined) patch.discovery = body.discovery;
    if (body.searchThreshold !== undefined) patch.searchThreshold = body.searchThreshold;
    if (body.pinnedTools !== undefined) {
      const names = await this.toolNamesOf(rows.map((row) => row.toolId));
      patch.pinnedTools = this.validatePinned(body.pinnedTools, [...names.values()]);
    }

    if (Object.keys(patch).length > 0) {
      await this.dataSource.transaction(async (manager) => {
        await manager.update(ToolsetEntity, { id: toolset.id, ownerOrgId: organizationId }, patch);
        await this.audit.record(manager, {
          organizationId,
          actor,
          action: 'toolset.updated',
          resourceType: 'toolset',
          resourceId: toolset.id,
          before: pickKeys(toolset, Object.keys(patch)),
          after: patch as Record<string, unknown>,
        });
      });
      await this.epochs.bump(organizationId);
    }

    return this.get(organizationId, toolset.id);
  }

  /** Replaces the Draft. `/my/{slug}` serves the new entries on the next request. */
  async replaceEntries(
    organizationId: string,
    id: string,
    input: readonly ToolsetEntryInputDto[],
    actor: AuditActor,
  ): Promise<ToolsetDto> {
    const toolset = await this.requireOwned(organizationId, id);
    // An entry re-sent without a range keeps the one it has (T3).
    const stored = new Map(
      (await this.entries.findByToolsets([toolset.id])).map((row) => [
        row.toolId,
        row.toolVersionRange,
      ]),
    );
    const entries = await this.validateEntries(input, stored);
    const names = new Set(entries.map((entry) => entry.tool.name));

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ToolsetEntryEntity, { toolsetId: toolset.id });
      await this.writeEntries(manager, toolset.id, entries);
      await manager.update(
        ToolsetEntity,
        { id: toolset.id, ownerOrgId: organizationId },
        {
          // A pinned tool the new Draft no longer holds stops being pinned.
          pinnedTools: toolset.pinnedTools.filter((name) => names.has(name)),
          category: toolset.category ?? inferCategory(entries),
          updatedAt: new Date(),
        },
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'toolset.entries_replaced',
        resourceType: 'toolset',
        resourceId: toolset.id,
        before: null,
        after: { toolIds: entries.map((entry) => entry.toolId) },
      });
    });

    await this.epochs.bump(organizationId);
    return this.get(organizationId, toolset.id);
  }

  /**
   * Soft delete (design spec §7.7). When other organizations used the toolset
   * in the last 30 days or allow it in their access, its shared URLs keep
   * serving the last version for 90 days, as after Stop sharing; otherwise
   * they stop at once. Pinned access of other organizations keeps its
   * snapshot either way. The owner's own access to it allows nothing from now
   * (fail closed).
   */
  async delete(organizationId: string, id: string, actor: AuditActor): Promise<void> {
    const toolset = await this.requireOwned(organizationId, id);
    const usedByOthers = await this.usedByOthers(organizationId, toolset.id);
    const state = sharingStateOf(toolset);
    const wasShared = isShared(state) || state.graceUntil !== null;
    let next;
    try {
      next = applySharing(state, { kind: 'DELETE', usedByOthers }, this.now());
    } catch (error) {
      if (error instanceof SharingTransitionError) {
        throw ToolsetErrors.sharingRefused({ refusal: error.refusal });
      }
      throw error;
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        ToolsetEntity,
        { id: toolset.id, ownerOrgId: organizationId, deletedAt: IsNull() },
        sharingPatchOf(next),
      );
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'toolset.deleted',
        resourceType: 'toolset',
        resourceId: toolset.id,
        before: { slug: toolset.slug, name: toolset.name, visibility: toolset.visibility },
        after: { graceUntil: next.graceUntil?.toISOString() ?? null },
      });
    });
    await this.epochs.bump(organizationId);
    if (wasShared) await this.epochs.bumpShared();
  }

  /** Other organizations called it in the last 30 days, or allow it in their access. */
  private async usedByOthers(organizationId: string, toolsetId: string): Promise<boolean> {
    const ref = JSON.stringify([{ toolsetId }]);
    const [row] = (await this.dataSource.query(
      `SELECT (
         EXISTS (SELECT 1 FROM payment_intents
                  WHERE toolset_id = $1 AND organization_id <> $2
                    AND created_at > now() - interval '30 days')
         OR EXISTS (SELECT 1 FROM tool_call_records
                     WHERE toolset_id = $1 AND organization_id <> $2
                       AND created_at > now() - interval '30 days')
         OR EXISTS (SELECT 1 FROM spend_policies
                     WHERE organization_id <> $2 AND allowed_toolsets @> $3::jsonb)
         OR EXISTS (SELECT 1 FROM agent_credentials
                     WHERE organization_id <> $2 AND allowed_toolsets @> $3::jsonb)
       ) AS used`,
      [toolsetId, organizationId, ref],
    )) as { used: boolean }[];
    return row?.used === true;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  private async validateEntries(
    input: readonly ToolsetEntryInputDto[],
    storedRanges: ReadonlyMap<string, string | null> = new Map(),
  ): Promise<ValidEntry[]> {
    if (input.length > TOOLSET_LIMITS.entriesPerToolset) {
      throw ToolsetErrors.limitExceeded({
        limit: 'entriesPerToolset',
        max: TOOLSET_LIMITS.entriesPerToolset,
      });
    }

    const ids = input.map((entry) => entry.toolId);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) {
      throw ToolsetErrors.invalid({ reason: 'a tool appears twice', toolIds: [duplicate] });
    }

    const tools = new Map((await this.tools.findByIds(ids)).map((tool) => [tool.id, tool]));
    // Only LISTED tools that still serve: a STANDARD tool is always LISTED, and
    // an UNLISTED provider tool may only sit in its own provider's toolsets (T4).
    const unknown = ids.filter((id) => {
      const tool = tools.get(id);
      return !tool || tool.visibility !== 'LISTED' || tool.status === ToolStatus.REMOVED;
    });
    if (unknown.length > 0) {
      throw ToolsetErrors.invalid({ reason: 'unknown or unavailable tools', toolIds: unknown });
    }

    // The contract half of each entry (T3): the range of majors it routes
    // to and the outputs it requires, checked against the published versions.
    const versions = new Map<string, ToolVersionEntity[]>();
    for (const row of await this.toolVersions.findByTools(ids)) {
      if (row.status === ToolVersionStatus.DRAFT) continue;
      versions.set(row.toolId, [...(versions.get(row.toolId) ?? []), row]);
    }

    return input.map((entry) => {
      const contract = entryContractTerms(
        entry,
        tools.get(entry.toolId) as ToolEntity,
        versions.get(entry.toolId) ?? [],
        storedRanges.get(entry.toolId) ?? null,
      );
      const mode = entry.providerMode ?? ProviderMode.BEST;
      const providerIds = dedupe(entry.providerIds ?? []);
      if (mode === ProviderMode.BEST && providerIds.length > 0) {
        throw ToolsetErrors.invalid({
          reason: 'providerIds must be empty when providerMode is BEST',
          toolIds: [entry.toolId],
        });
      }
      if (mode !== ProviderMode.BEST && providerIds.length === 0) {
        throw ToolsetErrors.invalid({
          reason: `providerMode ${mode} needs at least one provider`,
          toolIds: [entry.toolId],
        });
      }

      let maxPrice: ValidEntry['maxPrice'] = null;
      if (entry.maxPrice) {
        const asset = entry.maxPrice.asset as AssetId;
        if (!isRegisteredAsset(asset)) {
          throw ToolsetErrors.invalid({
            reason: `maxPrice is in an asset this deployment does not hold: ${asset}`,
            toolIds: [entry.toolId],
          });
        }
        maxPrice = {
          amount: entry.maxPrice.amount,
          asset,
          decimals: getAssetMetadata(asset).decimals,
        };
      }

      return {
        toolId: entry.toolId,
        tool: tools.get(entry.toolId) as ToolEntity,
        providerMode: mode,
        providerIds,
        minTier: entry.minTier ?? null,
        maxPrice,
        minQuality: entry.minQuality ?? null,
        onEmpty: entry.onEmpty ?? OnEmpty.FAIL,
        ...contract,
      };
    });
  }

  private validatePinned(pinned: readonly string[], toolNames: readonly string[]): string[] {
    const names = dedupe(pinned);
    if (names.length > TOOLSET_LIMITS.pinnedTools) {
      throw ToolsetErrors.limitExceeded({ limit: 'pinnedTools', max: TOOLSET_LIMITS.pinnedTools });
    }
    const present = new Set(toolNames);
    const missing = names.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw ToolsetErrors.invalid({
        reason: `pinned tools not in this tool set: ${missing.join(', ')}`,
      });
    }
    return names;
  }

  private async requireFreeSlug(organizationId: string, slug: string): Promise<string> {
    if (await this.toolsets.findHolderOfSlug(organizationId, slug)) {
      throw ToolsetErrors.slugTaken({
        slug,
        suggestion: await this.freeSlug(organizationId, slug),
      });
    }
    return slug;
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

  // ── Persistence ───────────────────────────────────────────────────────────

  private async writeEntries(
    manager: EntityManager,
    toolsetId: string,
    entries: readonly ValidEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await manager.insert(
      ToolsetEntryEntity,
      entries.map((entry, position) => ({
        toolsetId,
        position,
        toolId: entry.toolId,
        providerMode: entry.providerMode,
        providerIds: entry.providerIds,
        minTier: entry.minTier,
        maxPriceAmount: entry.maxPrice?.amount ?? null,
        maxPriceAssetId: entry.maxPrice?.asset ?? null,
        maxPriceDecimals: entry.maxPrice?.decimals ?? null,
        minQuality: entry.minQuality === null ? null : String(entry.minQuality),
        onEmpty: entry.onEmpty,
        toolVersionRange: entry.toolVersionRange,
        requireOutputFields: entry.requireOutputFields,
      })),
    );
  }

  private async requireOwned(organizationId: string, id: string): Promise<ToolsetEntity> {
    const toolset = await this.toolsets.findOwned(organizationId, id);
    if (!toolset) throw ToolsetErrors.notFound();
    return toolset;
  }

  private async entryCounts(toolsetIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.entries.findByToolsets(toolsetIds);
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.toolsetId, (counts.get(row.toolsetId) ?? 0) + 1);
    return counts;
  }

  private async toolNamesOf(toolIds: readonly string[]): Promise<Map<string, string>> {
    return new Map((await this.tools.findByIds(toolIds)).map((tool) => [tool.id, tool.name]));
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private async toDto(
    toolset: ToolsetEntity,
    rows: readonly ToolsetEntryEntity[],
  ): Promise<ToolsetDto> {
    const tools = new Map(
      (await this.tools.findByIds(rows.map((row) => row.toolId))).map((tool) => [tool.id, tool]),
    );
    const handle =
      toolset.ownerOrgId === null
        ? OFFICIAL_HANDLE
        : ((await this.handles.handlesOf([toolset.ownerOrgId])).get(toolset.ownerOrgId) ?? null);
    return {
      ...this.toSummary(toolset, rows.length, handle),
      entries: rows.map((row) => toEntryDto(row, tools.get(row.toolId))),
    };
  }

  private toSummary(
    toolset: ToolsetEntity,
    toolCount: number,
    handle: string | null,
  ): ToolsetSummaryDto {
    const state = sharingStateOf(toolset);
    const base = this.host.mcpPublicUrl;
    const latest = toolset.latestVersion;
    const publicUrl =
      handle && toolset.visibility === ToolsetVisibility.PUBLIC
        ? `${base}/@${handle}/${toolset.slug}`
        : null;
    return {
      id: toolset.id,
      slug: toolset.slug,
      name: toolset.name,
      description: toolset.description,
      category: toolset.category,
      tags: toolset.tags,
      icon: toolset.icon,
      visibility: toolset.visibility,
      discovery: toolset.discovery,
      searchThreshold: toolset.searchThreshold,
      pinnedTools: toolset.pinnedTools,
      mcpUrl: `${base}/my/${toolset.slug}`,
      toolCount,
      createdAt: new Date(toolset.createdAt).toISOString(),
      updatedAt: new Date(toolset.updatedAt).toISOString(),
      publisherKind: toolset.publisherKind,
      handle,
      listingStatus: toolset.listingStatus,
      latestVersion: latest,
      sharingEndsAt:
        (sharingEndsAt(state, 'PUBLIC') ?? sharingEndsAt(state, 'UNLISTED'))?.toISOString() ?? null,
      delisted: toolset.delistedAt !== null,
      removed: toolset.removedAt !== null,
      urls: {
        draft: `${base}/my/${toolset.slug}`,
        myPinned: latest ? `${base}/my/${toolset.slug}@${latest}` : null,
        public: publicUrl,
        publicPinned:
          publicUrl && toolset.lastPublicVersion
            ? `${publicUrl}@${toolset.lastPublicVersion}`
            : null,
        unlisted:
          toolset.unlistedToken && isShared(state) ? `${base}/u/${toolset.unlistedToken}` : null,
        unlistedPinned:
          toolset.unlistedToken && isShared(state) && toolset.lastSharedVersion
            ? `${base}/u/${toolset.unlistedToken}@${toolset.lastSharedVersion}`
            : null,
      },
      unlistedToken: isShared(state) ? toolset.unlistedToken : null,
      forkedFrom: toolset.forkedFromId
        ? { toolsetId: toolset.forkedFromId, version: toolset.forkedFromVersion }
        : null,
    };
  }
}

interface ValidEntry {
  readonly toolId: string;
  readonly tool: ToolEntity;
  readonly providerMode: ProviderMode;
  readonly providerIds: string[];
  readonly minTier: string | null;
  readonly maxPrice: { amount: string; asset: string; decimals: number } | null;
  readonly minQuality: number | null;
  readonly onEmpty: OnEmpty;
  readonly toolVersionRange: string | null;
  readonly requireOutputFields: string[];
}

/**
 * An entry's contract range and required outputs (T3, design spec §7.2):
 * the range named, else the stored one, else `^N` of the tool's current
 * major; every major in it must have a published version that still serves,
 * and every required output must be a field of the contract in that range.
 */
export function entryContractTerms(
  entry: Pick<ToolsetEntryInputDto, 'toolId' | 'toolVersionRange' | 'requireOutputFields'>,
  tool: Pick<ToolEntity, 'currentVersion'>,
  versions: readonly Pick<ToolVersionEntity, 'version' | 'major' | 'status' | 'outputSchema'>[],
  storedRange: string | null,
): { toolVersionRange: string | null; requireOutputFields: string[] } {
  const servable = versions.filter(
    (version) =>
      version.status === ToolVersionStatus.ACTIVE ||
      version.status === ToolVersionStatus.DEPRECATED,
  );
  const current =
    versions.find((version) => version.version === tool.currentVersion) ??
    [...servable].sort((a, b) => b.version - a.version)[0];
  const text = entry.toolVersionRange ?? storedRange ?? (current ? `^${current.major}` : null);
  const range = text === null ? null : parseVersionRange(text);
  if (text !== null && !range) {
    throw ToolsetErrors.invalid({
      reason: `"${text}" is not a version range (write ^1, or ^1 || ^2)`,
      toolIds: [entry.toolId],
    });
  }
  const majors = range ?? [];
  const missing = majors.filter((major) => !servable.some((version) => version.major === major));
  if (missing.length > 0) {
    throw ToolsetErrors.invalid({
      reason: `no published version serves ${missing.map((major) => `v${major}`).join(', ')}`,
      toolIds: [entry.toolId],
    });
  }

  const required = dedupe(entry.requireOutputFields ?? []);
  const inRange = servable.filter(
    (version) => majors.length === 0 || majors.includes(version.major),
  );
  const unknownFields = required.filter(
    (field) =>
      !inRange.some((version) =>
        Object.prototype.hasOwnProperty.call(
          (version.outputSchema as { properties?: Record<string, unknown> }).properties ?? {},
          field,
        ),
      ),
  );
  if (unknownFields.length > 0) {
    throw ToolsetErrors.invalid({
      reason: `not an output of this tool: ${unknownFields.join(', ')}`,
      toolIds: [entry.toolId],
    });
  }
  return {
    toolVersionRange: range ? formatVersionRange(range) : null,
    requireOutputFields: required,
  };
}

function toEntryDto(row: ToolsetEntryEntity, tool: ToolEntity | undefined): ToolsetEntryDto {
  return {
    position: row.position,
    toolId: row.toolId,
    toolName: tool?.name ?? '',
    category: tool?.category ?? '',
    providerMode: row.providerMode as ProviderMode,
    providerIds: row.providerIds,
    minTier: (row.minTier as ToolsetEntryDto['minTier']) ?? null,
    maxPrice:
      row.maxPriceAmount !== null && row.maxPriceAssetId && row.maxPriceDecimals !== null
        ? { amount: row.maxPriceAmount, asset: row.maxPriceAssetId, decimals: row.maxPriceDecimals }
        : null,
    minQuality: row.minQuality === null ? null : Number(row.minQuality),
    onEmpty: row.onEmpty as OnEmpty,
    toolVersionRange: row.toolVersionRange ?? null,
    requireOutputFields: [...(row.requireOutputFields ?? [])],
  };
}

/** The most common category among the entries' tools; the first one wins a tie. */
export function inferCategory(
  entries: readonly { readonly tool: { category: string } }[],
): string | null {
  const counts = new Map<string, number>();
  for (const { tool } of entries) counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
  let best: string | null = null;
  for (const [category, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = category;
  }
  return best;
}

/** A slug from a name: lowercase, `-` for anything else, 2..64 characters. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    // The accents NFKD split off: "é" becomes "e", not "e-".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : `set-${slug || 'new'}`.slice(0, 64);
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function pickKeys(row: ToolsetEntity, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.map((key) => [key, (row as unknown as Record<string, unknown>)[key]]),
  );
}
