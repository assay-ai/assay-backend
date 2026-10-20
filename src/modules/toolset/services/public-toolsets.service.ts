import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ToolsetVersionEntity } from '@database/postgres/entities/toolset-version.entity';
import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import {
  ToolsetStatsRepository,
  ToolsetVersionRepository,
} from '@database/postgres/repositories/toolset-sharing.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import { OFFICIAL_HANDLE } from '../domain/handle';
import {
  listedInCatalogue,
  servesUnlistedPath,
  sharingEndsAt,
  versionServes,
} from '../domain/sharing';
import { ServingBinding, routesToPublisher } from '../domain/self-routing';
import { SnapshotEntry, diffSnapshots, readSnapshotEntries } from '../domain/snapshot';
import {
  ListPublicToolsetsQueryDto,
  PublicCategoryListDto,
  PublicFigureDto,
  PublicHandleProfileDto,
  PublicHandleToolDto,
  PublicToolsetCardDto,
  PublicToolsetDiffDto,
  PublicToolsetEntryDto,
  PublicToolsetListDto,
  PublicToolsetPageDto,
  PublicToolsetStatsDto,
  PublicToolsetVersionDetailDto,
  PublicToolsetVersionListDto,
} from '../dto/public-toolsets.dto';
import { ToolsetErrors } from '../errors/toolset.errors';
import { AccessEpochService } from './access-epoch.service';
import { HandlesService } from './handles.service';
import { sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';
import { snapshotOfVersion } from './version-mapping';

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
  readonly routesToPublisher: boolean;
}

/** What the public pages say about the tools of a snapshot. */
interface ToolFlags {
  /** Removed, retired or gone: "Removed". */
  readonly removed: ReadonlySet<string>;
  /** Not reviewed for the catalogue: "Not reviewed". */
  readonly notReviewed: ReadonlySet<string>;
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
    const entries = entriesOf(row.entries, await this.toolFlags(row.entries));
    return {
      ...this.card(row),
      changelog: row.changelog,
      publishedAt: new Date(row.publishedAt).toISOString(),
      entries,
      notReviewed: entries.some((entry) => entry.notReviewed),
      diff: null,
      stats: statsOf(row.figures, row.weekStart),
      forkedFrom: await this.forkedFromOf(row.id),
      sharingEndsAt: null,
    };
  }

  async versionsOf(handle: string, slug: string): Promise<PublicToolsetVersionListDto> {
    const row = await this.findListed(handle, slug);
    // Only what `/@…` serves: versions published as PUBLIC, none past the newest.
    const versions = (await this.versions.listVersions(row.id)).filter(
      (version) => version.version <= row.version && versionServes(version.sharedAs, 'PUBLIC'),
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

  /**
   * One version a listed toolset's `/@…` URLs serve, with its snapshot, and
   * the diff from `diffFrom` when asked. A version `/@…` does not serve
   * (published PRIVATE or UNLISTED, or past the newest) is the same 404 as a
   * missing one, as `diffFrom` is.
   */
  async versionOf(
    handle: string,
    slug: string,
    v: number,
    diffFrom: number | undefined,
  ): Promise<PublicToolsetVersionDetailDto> {
    const row = await this.findListed(handle, slug);
    const served = async (version: number) => {
      const found =
        version <= row.version ? await this.versions.findVersion(row.id, version) : null;
      if (!found || !versionServes(found.sharedAs, 'PUBLIC')) {
        throw ToolsetErrors.versionNotFound();
      }
      return found;
    };
    const version = await served(v);
    const from = diffFrom === undefined ? null : await served(diffFrom);
    const snapshot = readSnapshotEntries(version.entries);
    const entries = entriesOf(snapshot, await this.toolFlags(snapshot));
    return {
      version: version.version,
      publishedAt: new Date(version.publishedAt).toISOString(),
      changelog: version.changelog,
      toolCount: version.toolIds.length,
      name: version.name,
      description: version.description,
      icon: version.icon,
      toolIds: [...version.toolIds],
      entries,
      notReviewed: entries.some((entry) => entry.notReviewed),
      routesToPublisher: routesToPublisher(
        snapshot,
        row.ownerOrgId,
        await this.servingBindings(snapshot.map((entry) => entry.toolId)),
      ),
      diff: from ? diffOf(from, version) : null,
    };
  }

  /** A link-only toolset's page; the token is the permission. */
  async byToken(
    token: string,
    v: number | undefined,
    diffFrom?: number,
  ): Promise<PublicToolsetPageDto> {
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
    // Only versions the link serves: published UNLISTED or PUBLIC, none past its newest.
    const served = async (n: number) => {
      const found = n <= newest ? await this.versions.findVersion(toolset.id, n) : null;
      if (!found || !versionServes(found.sharedAs, 'UNLISTED')) {
        throw ToolsetErrors.versionNotFound();
      }
      return found;
    };
    const row = await served(version);
    const from = diffFrom === undefined ? null : await served(diffFrom);

    const snapshot = readSnapshotEntries(row.entries);
    const entries = entriesOf(snapshot, await this.toolFlags(snapshot));
    const base = `${this.host.mcpPublicUrl}/u/${token}`;
    const stats = (await this.stats.latestFor([toolset.id])).get(toolset.id);
    const ends = sharingEndsAt(state, 'UNLISTED');
    return {
      // The caller holds the link, so it may name the toolset by id.
      id: toolset.id,
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
      routesToPublisher: routesToPublisher(
        snapshot,
        toolset.ownerOrgId,
        await this.servingBindings(snapshot.map((entry) => entry.toolId)),
      ),
      changelog: row.changelog,
      publishedAt: new Date(row.publishedAt).toISOString(),
      entries,
      notReviewed: entries.some((entry) => entry.notReviewed),
      diff: from ? diffOf(from, row) : null,
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
    const tools = owner.kind === 'ORG' ? await this.listedProviderTools(owner.organizationId) : [];
    return {
      handle: current,
      renamedTo: owner.kind === 'ORG' ? owner.renamedTo : null,
      toolsets: rows.map((row) => this.card(row)),
      tools,
      mcpUrl: tools.length > 0 ? `${this.host.mcpPublicUrl}/@${current}` : null,
    };
  }

  /**
   * One maker's LISTED provider tools, at the version an unpinned call is
   * served (§7.4 `/@{handle}`). UNLISTED and PRIVATE ones never appear: a
   * public page is no way to learn that a link-only tool exists.
   */
  private async listedProviderTools(organizationId: string): Promise<PublicHandleToolDto[]> {
    const rows = (await this.dataSource.query(
      `SELECT t.id, t.name, t.category, t.tags, v.summary, v.semver, v.tier,
              r.name AS "replacementName"
         FROM tools t
         JOIN tool_versions v ON v.tool_id = t.id AND v.version = t.current_version
         LEFT JOIN tools r ON r.id = t.replacement_tool_id AND r.visibility = 'LISTED'
         JOIN organizations o ON o.id = t.owner_org_id AND o.handle_status = 'ACTIVE'
                             AND left(t.name, length(o.handle) + 2) = o.handle || '__'
        WHERE t.kind = 'PROVIDER' AND t.owner_org_id = $1 AND t.visibility = 'LISTED'
          AND t.approved_version IS NOT NULL
          AND t.status IN ('ACTIVE', 'DEPRECATED')
        ORDER BY t.name`,
      [organizationId],
    )) as {
      id: string;
      name: string;
      category: string;
      tags: string[];
      summary: string;
      semver: string | null;
      tier: string | null;
      replacementName: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      summary: row.summary,
      category: row.category,
      tags: [...(row.tags ?? [])],
      // Never GUARANTEED, whatever a row says (§7.6).
      tier: row.tier === 'GUARANTEED' ? 'VERIFIED' : (row.tier ?? 'UNVERIFIED'),
      version: row.semver,
      kind: 'PROVIDER' as const,
      reviewed: true,
      replacementName: row.replacementName,
    }));
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
                t.created_at AS "createdAt", t.last_public_version AS version,
                t.visibility, t.listing_status AS "listingStatus", t.removed_at AS "removedAt",
                t.deleted_at AS "deletedAt",
                COALESCE(o.handle, $1) AS handle,
                v.name, v.description, v.icon, v.tool_ids AS "toolIds", v.entries,
                v.published_at AS "publishedAt", v.changelog
           FROM toolsets t
           LEFT JOIN organizations o ON o.id = t.owner_org_id
           JOIN toolset_versions v ON v.toolset_id = t.id AND v.version = t.last_public_version
                                AND v.shared_as = 'PUBLIC'
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
    const snapshots = new Map(listed.map((row) => [row.id, readSnapshotEntries(row.entries)]));
    const bindings = await this.servingBindings(
      [...snapshots.values()].flatMap((entries) => entries.map((entry) => entry.toolId)),
    );
    return listed.map((row) => {
      const published = stats.get(row.id);
      const entries = snapshots.get(row.id) ?? [];
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
        entries,
        publishedAt: row.publishedAt,
        changelog: row.changelog,
        popularScore: published?.popularScore ?? 0,
        trendingScore: published?.trendingScore ?? 0,
        figures: published?.figures ?? null,
        weekStart: published?.weekStart ?? null,
        routesToPublisher: routesToPublisher(entries, row.ownerOrgId, bindings),
      };
    });
  }

  private card(row: ListedRow): PublicToolsetCardDto {
    const latest = `${this.host.mcpPublicUrl}/@${row.handle}/${row.slug}`;
    const pinned = `${latest}@${row.version}`;
    const badge = badgeOf(row);
    return {
      // Listed: served on `/@…`, so naming it by id reveals nothing more.
      id: row.id,
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
      routesToPublisher: row.routesToPublisher,
    };
  }

  /**
   * Removed (or gone) and not-reviewed tools of a snapshot. "Not reviewed" is
   * a provider tool with no approved version (§7.6) — read from its review
   * state, so a LISTED tool is reviewed and an UNLISTED one is not.
   */
  private async toolFlags(entries: readonly SnapshotEntry[]): Promise<ToolFlags> {
    const toolIds = [...new Set(entries.map((entry) => entry.toolId))];
    if (toolIds.length === 0) return { removed: new Set(), notReviewed: new Set() };
    const rows = (await this.dataSource.query(
      `SELECT id, status, kind, approved_version AS "approvedVersion"
         FROM tools WHERE id = ANY($1::uuid[])`,
      [toolIds],
    )) as { id: string; status: string; kind: string; approvedVersion: number | null }[];
    const found = new Map(rows.map((row) => [row.id, row]));
    const removed = new Set<string>();
    const notReviewed = new Set<string>();
    for (const id of toolIds) {
      const tool = found.get(id);
      if (!tool || tool.status === 'REMOVED' || tool.status === 'RETIRED') removed.add(id);
      // From the review state, not the visibility (§7.6): a provider tool
      // nobody approved yet.
      else if (tool.kind === 'PROVIDER' && tool.approvedVersion === null) notReviewed.add(id);
    }
    return { removed, notReviewed };
  }

  /** The bindings serving these tools now, for the self-routing disclosure. */
  private async servingBindings(toolIds: readonly string[]): Promise<ServingBinding[]> {
    const ids = [...new Set(toolIds)];
    if (ids.length === 0) return [];
    const rows = (await this.dataSource.query(
      `SELECT tool_id AS "toolId", organization_id AS "providerId",
              price_amount::text AS "priceAmount", asset_id AS "assetId"
         FROM tool_bindings
        WHERE tool_id = ANY($1::uuid[]) AND status = 'ACTIVE'`,
      [ids],
    )) as ServingBinding[];
    return rows;
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

function entriesOf(entries: readonly SnapshotEntry[], flags: ToolFlags): PublicToolsetEntryDto[] {
  return entries.map((entry) => ({
    toolId: entry.toolId,
    toolName: entry.toolName,
    providerMode: entry.providerMode,
    providerCount: entry.providerIds.length,
    minTier: entry.minTier,
    onEmpty: entry.onEmpty,
    removed: flags.removed.has(entry.toolId),
    notReviewed: flags.notReviewed.has(entry.toolId),
    toolVersionRange: entry.toolVersionRange ?? null,
    requireOutputFields: [...entry.requireOutputFields],
  }));
}

/** The diff between two served versions, field by field. */
function diffOf(from: ToolsetVersionEntity, to: ToolsetVersionEntity): PublicToolsetDiffDto {
  const diff = diffSnapshots(snapshotOfVersion(from), snapshotOfVersion(to));
  return {
    from: from.version,
    to: to.version,
    added: [...diff.added],
    removed: [...diff.removed],
    rulesChanged: [...diff.rulesChanged],
    settingsChanged: [...diff.settingsChanged],
  };
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
