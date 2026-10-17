import { Inject, Injectable, Optional } from '@nestjs/common';

import { ToolsetEntity } from '@database/postgres/entities/toolset.entity';
import { ToolsetVersionEntity } from '@database/postgres/entities/toolset-version.entity';
import { ToolsetVersionRepository } from '@database/postgres/repositories/toolset-sharing.repository';
import {
  ToolsetEntryRepository,
  ToolsetRepository,
} from '@database/postgres/repositories/toolset.repository';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { EntryRoutingRules } from '@modules/tool/domain/routing';

import { BoundedTtlCache } from '@shared/utils/bounded-ttl-cache';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import {
  DiscoveryMode,
  McpPath,
  McpPathKind,
  ParsedMcpUrl,
  ViewFilter,
  canonicalPath,
  canonicalUrl,
  endpointKindOf,
  withoutDefaultDiscovery,
} from '../domain/mcp-url';
import { servesPublicPath, servesUnlistedPath, sharingEndsAt } from '../domain/sharing';
import { readSnapshotEntries } from '../domain/snapshot';
import { McpEndpointView, StoredEntryRule, ViewNotice, entryRulesOf } from '../domain/view';
import { AccessEpochService } from './access-epoch.service';
import { ACCESS_CACHE_TTL_MS } from './access.resolver';
import { HandlesService } from './handles.service';
import { sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';

/** What a path serves, before any view filter. */
type BaseView = Omit<McpEndpointView, 'canonicalUrl' | 'filter'> & {
  /** The discovery mode a `discovery=` equal to is the default, and drops out. */
  readonly defaultDiscovery: DiscoveryMode | null;
};

interface CachedView {
  readonly epoch: string;
  readonly view: BaseView;
  /** A grace period or an alias ends: the cached view is stale from then. */
  readonly validUntil: number | null;
}

/** Base views kept per process: organizations × the toolsets they serve. */
export const ENDPOINT_CACHE_MAX_ENTRIES = 10_000;

/**
 * A parsed MCP URL → what it serves, for the organization asking
 * (design spec §7.4, "Resolution rules").
 *
 * ```text
 * /                       the whole LISTED catalogue
 * /my/{slug}              the org's own Draft, live
 * /my/{slug}@n            the org's own published version n
 * /@{handle}/{slug}[@n]   PUBLIC and LISTED, or in its PUBLIC grace period — else 404
 * /u/{token}[@n]          the shared toolset holding this token, or one in grace — else 404
 * /@{handle}              T4 (provider tools): 404
 * /c/{category}           the discovery half of T2
 * ```
 *
 * Every refusal is the **same** 404 as a missing slug: a PRIVATE or UNLISTED
 * toolset behind a guessable `/@handle/slug`, another organization's `/my/`,
 * a removed toolset, a frozen or expired handle, a version that does not
 * exist. A takedown stops every URL but `/my/` at once.
 *
 * Shared URLs serve published versions only, never the Draft; a URL with no
 * `@n` serves the latest. The view of a shared URL is the same for every
 * organization, so it is cached once under the sharing epoch; an own URL is
 * cached per organization under its access epoch.
 */
@Injectable()
export class McpEndpointResolver {
  private readonly cache = new BoundedTtlCache<CachedView>(
    ENDPOINT_CACHE_MAX_ENTRIES,
    ACCESS_CACHE_TTL_MS,
  );

  constructor(
    private readonly toolsets: ToolsetRepository,
    private readonly entries: ToolsetEntryRepository,
    private readonly epochs: AccessEpochService,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
    private readonly versions: ToolsetVersionRepository,
    private readonly handles: HandlesService,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  /** The view `parsed` serves to `organizationId`, or `MCP_URL_NOT_FOUND`. */
  async resolve(organizationId: string, parsed: ParsedMcpUrl): Promise<McpEndpointView> {
    return this.withFilter(await this.baseView(organizationId, parsed.path), parsed.filter);
  }

  private async baseView(organizationId: string, path: McpPath): Promise<BaseView> {
    if (path.kind === McpPathKind.ROOT) {
      return {
        path,
        kind: endpointKindOf(path),
        toolset: null,
        handle: null,
        baseToolIds: null,
        entryRules: new Map(),
        settings: null,
        notice: null,
        defaultDiscovery: null,
      };
    }

    const shared =
      path.kind === McpPathKind.PUBLIC_TOOLSET || path.kind === McpPathKind.UNLISTED_TOOLSET;
    const key = shared
      ? `shared:${canonicalPath(path)}`
      : `${organizationId}:${canonicalPath(path)}`;
    const epoch = shared
      ? await this.epochs.currentShared()
      : await this.epochs.current(organizationId);
    const cached = this.cache.get(key);
    const nowMs = this.now().getTime();
    if (
      epoch !== null &&
      cached?.epoch === epoch &&
      (cached.validUntil === null || cached.validUntil > nowMs)
    ) {
      return cached.view;
    }

    const view = await this.resolvePath(organizationId, path);
    if (epoch !== null) {
      const ends = [view.notice?.sharingEndsAt?.getTime()].filter(
        (value): value is number => typeof value === 'number',
      );
      this.cache.set(key, { epoch, view, validUntil: ends.length ? Math.min(...ends) : null });
    }
    return view;
  }

  private withFilter(base: BaseView, filter: ViewFilter): McpEndpointView {
    const { defaultDiscovery, ...view } = base;
    const canonical = withoutDefaultDiscovery(filter, defaultDiscovery);
    return {
      ...view,
      filter: canonical,
      canonicalUrl: canonicalUrl(this.host.mcpPublicUrl, { path: base.path, filter: canonical }),
    };
  }

  private async resolvePath(organizationId: string, path: McpPath): Promise<BaseView> {
    switch (path.kind) {
      case McpPathKind.MY_TOOLSET:
        return this.myToolsetView(organizationId, path);
      case McpPathKind.PUBLIC_TOOLSET:
        return this.publicToolsetView(path);
      case McpPathKind.UNLISTED_TOOLSET:
        return this.unlistedToolsetView(path);
      case McpPathKind.CATEGORY:
      case McpPathKind.HANDLE:
      default:
        throw McpErrors.urlNotFound();
    }
  }

  private async myToolsetView(
    organizationId: string,
    path: Extract<McpPath, { kind: McpPathKind.MY_TOOLSET }>,
  ): Promise<BaseView> {
    const toolset = await this.toolsets.findOwnedBySlug(organizationId, path.slug);
    if (!toolset) throw McpErrors.urlNotFound();
    if (path.version !== null) {
      // `/my/{slug}@n` serves the owner's published version even after a takedown.
      return this.versionView(path, toolset, await this.requireVersion(toolset, path.version), {
        handle: null,
        latest: false,
        notice: null,
      });
    }

    const rows = await this.entries.findByToolsets([toolset.id]);
    const entryRules = new Map<string, EntryRoutingRules>();
    for (const row of rows) {
      const rules = entryRulesOf(row);
      if (rules) entryRules.set(row.toolId, rules);
    }

    return {
      path,
      kind: endpointKindOf(path),
      toolset: {
        id: toolset.id,
        slug: toolset.slug,
        name: toolset.name,
        version: null,
        latest: false,
      },
      handle: null,
      baseToolIds: rows.map((row) => row.toolId),
      entryRules,
      settings: {
        discovery: toolset.discovery,
        searchThreshold: toolset.searchThreshold,
        pinnedTools: toolset.pinnedTools,
      },
      notice: null,
      defaultDiscovery: toolset.discovery.toLowerCase() as DiscoveryMode,
    };
  }

  private async publicToolsetView(
    path: Extract<McpPath, { kind: McpPathKind.PUBLIC_TOOLSET }>,
  ): Promise<BaseView> {
    const owner = await this.handles.resolve(path.handle);
    if (!owner) throw McpErrors.urlNotFound();
    const toolset = await this.toolsets.findHolderOfSlug(
      owner.kind === 'OFFICIAL' ? null : owner.organizationId,
      path.slug,
    );
    if (!toolset) throw McpErrors.urlNotFound();
    const state = sharingStateOf(toolset);
    if (!servesPublicPath(state, this.now())) throw McpErrors.urlNotFound();

    const version = path.version ?? toolset.lastSharedVersion;
    if (!version) throw McpErrors.urlNotFound();
    return this.versionView(path, toolset, await this.requireVersion(toolset, version, true), {
      handle: path.handle,
      latest: path.version === null,
      notice: noticeOf(
        sharingEndsAt(state, 'PUBLIC'),
        owner.kind === 'ORG' ? owner.renamedTo : null,
        owner.kind === 'ORG' ? owner.aliasUntil : null,
      ),
    });
  }

  private async unlistedToolsetView(
    path: Extract<McpPath, { kind: McpPathKind.UNLISTED_TOOLSET }>,
  ): Promise<BaseView> {
    const toolset = await this.toolsets.findByUnlistedToken(path.token);
    if (!toolset || toolset.unlistedToken !== path.token) throw McpErrors.urlNotFound();
    const state = sharingStateOf(toolset);
    if (!servesUnlistedPath(state, this.now())) throw McpErrors.urlNotFound();
    if (toolset.ownerOrgId !== null) {
      // A frozen handle stops every URL of its organization, links included.
      const handle = (await this.handles.handlesOf([toolset.ownerOrgId])).get(toolset.ownerOrgId);
      if (!handle) throw McpErrors.urlNotFound();
    }

    const version = path.version ?? toolset.lastSharedVersion;
    if (!version) throw McpErrors.urlNotFound();
    return this.versionView(path, toolset, await this.requireVersion(toolset, version, true), {
      handle: null,
      latest: path.version === null,
      notice: noticeOf(sharingEndsAt(state, 'UNLISTED'), null, null),
    });
  }

  /** `shared`: a shared URL, which never serves past the last version published while shared. */
  private async requireVersion(
    toolset: ToolsetEntity,
    version: number,
    shared = false,
  ): Promise<ToolsetVersionEntity> {
    const newest = shared ? toolset.lastSharedVersion : toolset.latestVersion;
    if (newest === null || version > newest) throw McpErrors.urlNotFound();
    const row = await this.versions.findVersion(toolset.id, version);
    if (!row) throw McpErrors.urlNotFound();
    return row;
  }

  private versionView(
    path: McpPath,
    toolset: ToolsetEntity,
    row: ToolsetVersionEntity,
    options: { handle: string | null; latest: boolean; notice: ViewNotice | null },
  ): BaseView {
    const snapshot = readSnapshotEntries(row.entries);
    const entryRules = new Map<string, EntryRoutingRules>();
    for (const entry of snapshot) {
      const stored: StoredEntryRule = {
        providerMode: entry.providerMode,
        providerIds: entry.providerIds,
        minTier: entry.minTier,
        maxPriceAmount: entry.maxPrice?.amount ?? null,
        maxPriceAssetId: entry.maxPrice?.asset ?? null,
        maxPriceDecimals: entry.maxPrice?.decimals ?? null,
        minQuality: entry.minQuality === null ? null : String(entry.minQuality),
        onEmpty: entry.onEmpty,
      };
      const rules = entryRulesOf(stored);
      if (rules) entryRules.set(entry.toolId, rules);
    }
    return {
      path,
      kind: endpointKindOf(path),
      toolset: {
        id: toolset.id,
        slug: toolset.slug,
        name: row.name,
        version: row.version,
        latest: options.latest,
      },
      handle: options.handle,
      baseToolIds: snapshot.map((entry) => entry.toolId),
      entryRules,
      settings: {
        discovery: row.discovery,
        searchThreshold: row.searchThreshold,
        pinnedTools: row.pinnedTools,
      },
      notice: options.notice,
      defaultDiscovery: row.discovery.toLowerCase() as DiscoveryMode,
    };
  }
}

function noticeOf(
  sharingEnds: Date | null,
  renamedTo: string | null,
  aliasUntil: Date | null,
): ViewNotice | null {
  const ends = [sharingEnds, aliasUntil].filter((date): date is Date => date !== null);
  if (ends.length === 0 && renamedTo === null) return null;
  return {
    sharingEndsAt: ends.length ? new Date(Math.min(...ends.map((date) => date.getTime()))) : null,
    renamedTo,
  };
}
