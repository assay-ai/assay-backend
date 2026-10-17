import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import {
  ToolsetStatsRepository,
  ToolsetVersionRepository,
} from '@database/postgres/repositories/toolset-sharing.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import { OFFICIAL_HANDLE } from '../domain/handle';
import { listedInCatalogue, servesUnlistedPath, sharingEndsAt } from '../domain/sharing';
import { SnapshotEntry, readSnapshotEntries } from '../domain/snapshot';
import {
  ListPublicToolsetsQueryDto,
  PublicCategoryListDto,
  PublicFigureDto,
  PublicHandleProfileDto,
  PublicToolsetCardDto,
  PublicToolsetListDto,
  PublicToolsetPageDto,
  PublicToolsetStatsDto,
  PublicToolsetVersionListDto,
} from '../dto/public-toolsets.dto';
import { ToolsetErrors } from '../errors/toolset.errors';
import { AccessEpochService } from './access-epoch.service';
import { HandlesService } from './handles.service';
import { sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

/** One public answer is reused for this long; matches the public catalogue. */
export const PUBLIC_TOOLSETS_CACHE_MS = 30_000;

interface ListedRow {
  readonly id: string;
  readonly ownerOrgId: string | null;
  readonly publisherKind: string;
  readonly slug: string;
  readonly category: string | null;
  readonly tags: string[];
  readonly firstSharedAt: Date | null;
  readonly createdAt: Date;
  readonly version: number;
  readonly handle: string;
  readonly name: string;
  readonly description: string | null;
  readonly icon: string | null;
  readonly toolIds: string[];
  readonly entries: SnapshotEntry[];
  readonly publishedAt: Date;
  readonly changelog: string | null;
  readonly popularScore: number;
  readonly trendingScore: number;
  readonly figures: Record<string, unknown> | null;
  readonly weekStart: string | null;
}

/**
 * The toolset catalogue as an anonymous visitor sees it (design spec §7.9,
 * §7.10 "Catalogue"): PUBLIC and LISTED toolsets only, at the newest version
 * published while shared, with the weekly figures. An UNLISTED one answers
 * only `POST /public/toolsets/by-token`, with its current token.
 *
 * Everything else — PRIVATE, UNLISTED by slug, delisted, removed, deleted, a
 * frozen handle — is the same 404 as a missing slug. Answers are cached in
 * process for 30 s; the routes are rate limited per address.
 */
@Injectable()
export class PublicToolsetsService {
  /** One slot: the newest epoch's list replaces the previous one. */
  private listed: { key: string; expiresAt: number; value: Promise<ListedRow[]> } | null = null;

  constructor(
    private readonly toolsets: ToolsetRepository,
    private readonly versions: ToolsetVersionRepository,
    private readonly stats: ToolsetStatsRepository,
    private readonly handles: HandlesService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
    private readonly epochs: AccessEpochService,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  async list(query: ListPublicToolsetsQueryDto): Promise<PublicToolsetListDto> {
    let rows = await this.listedRows();
    if (query.publisher)
      rows = rows.filter((row) => badgeOf(row).toLowerCase() === query.publisher);
    if (query.category) rows = rows.filter((row) => row.category === query.category);
    if (query.q?.trim()) {
      const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
      rows = rows.filter((row) => {
        const text = [
          row.name,
          row.description ?? '',
          row.category ?? '',
          row.handle,
          row.slug,
          ...row.tags,
          ...row.entries.map((entry) => entry.toolName),
        ]
          .join(' ')
          .toLowerCase();
        return terms.every((term) => text.includes(term));
      });
    }
    const sort = query.sort ?? 'popular';
    rows = [...rows].sort((a, b) => {
      if (sort === 'new') return startedAt(b) - startedAt(a) || a.slug.localeCompare(b.slug);
      const key = sort === 'trending' ? 'trendingScore' : 'popularScore';
      return b[key] - a[key] || startedAt(b) - startedAt(a) || a.slug.localeCompare(b.slug);
    });
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return {
      toolsets: rows.slice(offset, offset + limit).map((row) => this.card(row)),
      total: rows.length,
    };
  }

  async page(handle: string, slug: string): Promise<PublicToolsetPageDto> {
    const row = await this.findListed(handle, slug);
    const removed = await this.removedTools(row.entries.map((entry) => entry.toolId));
    return {
      ...this.card(row),
      changelog: row.changelog,
      publishedAt: new Date(row.publishedAt).toISOString(),
      entries: row.entries.map((entry) => ({
        toolId: entry.toolId,
        toolName: entry.toolName,
        providerMode: entry.providerMode,
        providerCount: entry.providerIds.length,
        minTier: entry.minTier,
        onEmpty: entry.onEmpty,
        removed: removed.has(entry.toolId),
      })),
      stats: statsOf(row.figures, row.weekStart),
      forkedFrom: await this.forkedFromOf(row.id),
      sharingEndsAt: null,
    };
  }

  async versionsOf(handle: string, slug: string): Promise<PublicToolsetVersionListDto> {
    const row = await this.findListed(handle, slug);
    const versions = (await this.versions.listVersions(row.id)).filter(
      (version) => version.version <= row.version,
    );
    return {
      versions: versions.map((version) => ({
        version: version.version,
        publishedAt: new Date(version.publishedAt).toISOString(),
        changelog: version.changelog,
        toolCount: version.toolIds.length,
      })),
    };
  }

  /** A link-only toolset's page; the token is the permission. */
  async byToken(token: string, v: number | undefined): Promise<PublicToolsetPageDto> {
    const toolset = await this.toolsets.findByUnlistedToken(token);
    const now = this.now();
    if (!toolset || toolset.unlistedToken !== token) throw ToolsetErrors.notFound();
    const state = sharingStateOf(toolset);
    if (!servesUnlistedPath(state, now)) throw ToolsetErrors.notFound();
    const handle =
      toolset.ownerOrgId === null
        ? OFFICIAL_HANDLE
        : (await this.handles.handlesOf([toolset.ownerOrgId])).get(toolset.ownerOrgId);
    if (!handle) throw ToolsetErrors.notFound();
    const newest = toolset.lastSharedVersion;
    const version = v ?? newest;
    if (!version || !newest || version > newest) throw ToolsetErrors.versionNotFound();
    const row = await this.versions.findVersion(toolset.id, version);
    if (!row) throw ToolsetErrors.versionNotFound();

    const entries = readSnapshotEntries(row.entries);
    const removed = await this.removedTools(entries.map((entry) => entry.toolId));
    const base = `${this.host.mcpPublicUrl}/u/${token}`;
    const stats = (await this.stats.latestFor([toolset.id])).get(toolset.id);
    const ends = sharingEndsAt(state, 'UNLISTED');
    return {
      handle,
      slug: toolset.slug,
      name: row.name,
      description: row.description,
      category: toolset.category,
      tags: toolset.tags,
      icon: row.icon,
      badge: badgeOf({ ownerOrgId: toolset.ownerOrgId, publisherKind: toolset.publisherKind }),
      version: row.version,
      toolCount: row.toolIds.length,
      toolIds: [...row.toolIds],
      activeUsers: figureOf(stats?.figures?.activeUsers),
      mcpUrls: {
        latest: base,
        pinned: `${base}@${row.version}`,
        recommended: `${base}@${row.version}`,
      },
      changelog: row.changelog,
      publishedAt: new Date(row.publishedAt).toISOString(),
      entries: entries.map((entry) => ({
        toolId: entry.toolId,
        toolName: entry.toolName,
        providerMode: entry.providerMode,
        providerCount: entry.providerIds.length,
        minTier: entry.minTier,
        onEmpty: entry.onEmpty,
        removed: removed.has(entry.toolId),
      })),
      stats: statsOf(stats?.figures ?? null, stats?.weekStart ?? null),
      forkedFrom: await this.forkedFromOf(toolset.id),
      sharingEndsAt: ends ? ends.toISOString() : null,
    };
  }

  async profile(handle: string): Promise<PublicHandleProfileDto> {
    const owner = await this.handles.resolve(handle);
    if (!owner) throw ToolsetErrors.handleNotFound();
    const current = owner.kind === 'OFFICIAL' ? OFFICIAL_HANDLE : (owner.renamedTo ?? handle);
    const rows = (await this.listedRows()).filter((row) => row.handle === current);
    return {
      handle: current,
      renamedTo: owner.kind === 'ORG' ? owner.renamedTo : null,
      toolsets: rows.map((row) => this.card(row)),
      tools: [],
    };
  }

  async categories(): Promise<PublicCategoryListDto> {
    const tools = (await this.dataSource.query(
      `SELECT category, count(*)::int AS n FROM tools
        WHERE visibility = 'LISTED' AND status IN ('ACTIVE', 'DEPRECATED')
        GROUP BY category`,
    )) as { category: string; n: number }[];
    const counts = new Map<string, { tools: number; toolsets: number }>();
    for (const row of tools) counts.set(row.category, { tools: row.n, toolsets: 0 });
    for (const row of await this.listedRows()) {
      if (!row.category) continue;
      const cell = counts.get(row.category) ?? { tools: 0, toolsets: 0 };
      cell.toolsets += 1;
      counts.set(row.category, cell);
    }
    return {
      categories: [...counts.entries()]
        .map(([category, cell]) => ({ category, ...cell }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async findListed(handle: string, slug: string): Promise<ListedRow> {
    const owner = await this.handles.resolve(handle);
    if (!owner) throw ToolsetErrors.notFound();
    const current = owner.kind === 'OFFICIAL' ? OFFICIAL_HANDLE : (owner.renamedTo ?? handle);
    const row = (await this.listedRows()).find(
      (candidate) => candidate.handle === current && candidate.slug === slug,
    );
    if (!row) throw ToolsetErrors.notFound();
    return row;
  }

  /**
   * Every listed toolset, cached under the sharing epoch: a delist, a takedown
   * or a stop-sharing leaves the catalogue at once on every instance, and the
   * 30 s window only bounds an unreadable epoch.
   */
  private async listedRows(): Promise<ListedRow[]> {
    const key = (await this.epochs.currentShared()) ?? 'unreadable';
    const at = Date.now();
    if (this.listed && this.listed.key === key && this.listed.expiresAt > at) {
      return this.listed.value;
    }
    const value = this.loadListed();
    const slot = { key, expiresAt: at + PUBLIC_TOOLSETS_CACHE_MS, value };
    this.listed = slot;
    value.catch(() => {
      if (this.listed === slot) this.listed = null;
    });
    return value;
  }

  private async loadListed(): Promise<ListedRow[]> {
    const rows = (await this.dataSource.query(
      `SELECT t.id, t.owner_org_id AS "ownerOrgId", t.publisher_kind AS "publisherKind",
                t.slug, t.category, t.tags, t.first_shared_at AS "firstSharedAt",
                t.created_at AS "createdAt", t.last_shared_version AS version,
                t.visibility, t.listing_status AS "listingStatus", t.removed_at AS "removedAt",
                t.deleted_at AS "deletedAt",
                COALESCE(o.handle, $1) AS handle,
                v.name, v.description, v.icon, v.tool_ids AS "toolIds", v.entries,
                v.published_at AS "publishedAt", v.changelog
           FROM toolsets t
           LEFT JOIN organizations o ON o.id = t.owner_org_id
           JOIN toolset_versions v ON v.toolset_id = t.id AND v.version = t.last_shared_version
          WHERE t.visibility = 'PUBLIC' AND t.listing_status = 'LISTED'
            AND t.removed_at IS NULL AND t.deleted_at IS NULL
            AND (t.owner_org_id IS NULL OR (o.handle IS NOT NULL AND o.handle_status = 'ACTIVE'))`,
      [OFFICIAL_HANDLE],
    )) as (Omit<
      ListedRow,
      'entries' | 'popularScore' | 'trendingScore' | 'figures' | 'weekStart'
    > & {
      entries: unknown;
      visibility: string;
      listingStatus: string;
      removedAt: Date | null;
      deletedAt: Date | null;
    })[];
    // The query already filters; the state machine has the last word.
    const listed = rows.filter((row) =>
      listedInCatalogue(sharingStateOf(row as unknown as ToolsetEntity)),
    );
    const stats = await this.stats.latestFor(listed.map((row) => row.id));
    return listed.map((row) => {
      const published = stats.get(row.id);
      return {
        id: row.id,
        ownerOrgId: row.ownerOrgId,
        publisherKind: row.publisherKind,
        slug: row.slug,
        category: row.category,
        tags: row.tags ?? [],
        firstSharedAt: row.firstSharedAt,
        createdAt: row.createdAt,
        version: Number(row.version),
        handle: row.handle,
        name: row.name,
        description: row.description,
        icon: row.icon,
        toolIds: row.toolIds,
        entries: readSnapshotEntries(row.entries),
        publishedAt: row.publishedAt,
        changelog: row.changelog,
        popularScore: published?.popularScore ?? 0,
        trendingScore: published?.trendingScore ?? 0,
        figures: published?.figures ?? null,
        weekStart: published?.weekStart ?? null,
      };
    });
  }

  private card(row: ListedRow): PublicToolsetCardDto {
    const latest = `${this.host.mcpPublicUrl}/@${row.handle}/${row.slug}`;
    const pinned = `${latest}@${row.version}`;
    const badge = badgeOf(row);
    return {
      handle: row.handle,
      slug: row.slug,
      name: row.name,
      description: row.description,
      category: row.category,
      tags: [...row.tags],
      icon: row.icon,
      badge,
      version: row.version,
      toolCount: row.toolIds.length,
      toolIds: [...row.toolIds],
      activeUsers: figureOf(row.figures?.activeUsers),
      // Official sets follow their latest; anyone else's is pinned, so a
      // publisher cannot silently add a paid tool to other people's agents.
      mcpUrls: { latest, pinned, recommended: badge === 'OFFICIAL' ? latest : pinned },
    };
  }

  private async removedTools(toolIds: readonly string[]): Promise<Set<string>> {
    if (toolIds.length === 0) return new Set();
    const rows = (await this.dataSource.query(
      `SELECT id FROM tools WHERE id = ANY($1::uuid[]) AND status IN ('REMOVED', 'RETIRED')`,
      [[...toolIds]],
    )) as { id: string }[];
    const known = (await this.dataSource.query(`SELECT id FROM tools WHERE id = ANY($1::uuid[])`, [
      [...toolIds],
    ])) as { id: string }[];
    const present = new Set(known.map((row) => row.id));
    return new Set([...rows.map((row) => row.id), ...toolIds.filter((id) => !present.has(id))]);
  }

  /** The source of a copy, named only when the source is itself listed. */
  private async forkedFromOf(toolsetId: string) {
    const toolset = await this.toolsets.findAnyById(toolsetId);
    if (!toolset?.forkedFromId) return null;
    const source = (await this.listedRows()).find((row) => row.id === toolset.forkedFromId);
    if (!source) return null;
    return { handle: source.handle, slug: source.slug, version: toolset.forkedFromVersion };
  }
}

function badgeOf(row: { ownerOrgId: string | null; publisherKind: string }): string {
  if (row.ownerOrgId === null) return 'OFFICIAL';
  return row.publisherKind === 'PROVIDER' ? 'PROVIDER' : 'COMMUNITY';
}

function startedAt(row: ListedRow): number {
  return new Date(row.firstSharedAt ?? row.createdAt).getTime();
}

function figureOf(value: unknown): PublicFigureDto | null {
  if (!value || typeof value !== 'object') return null;
  const figure = value as { value?: unknown; display?: unknown };
  if (typeof figure.display !== 'string') return null;
  return { value: typeof figure.value === 'number' ? figure.value : null, display: figure.display };
}

/** The published figures, copied key by key: nothing else in the row reaches a visitor. */
function statsOf(
  figures: Record<string, unknown> | null,
  weekStart: string | null,
): PublicToolsetStatsDto {
  return {
    weekStart,
    activeUsers: figureOf(figures?.activeUsers),
    agents: figureOf(figures?.agents),
    calls30d: figureOf(figures?.calls30d),
    copies: figureOf(figures?.copies),
    trend: typeof figures?.trend === 'string' ? figures.trend : null,
    onLatestVersionPercent:
      typeof figures?.onLatestVersionPercent === 'number' ? figures.onLatestVersionPercent : null,
  };
}
