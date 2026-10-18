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
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { categoryOf, isListedTool, isProviderTool } from '@modules/tool/ports/tool.types';

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
  defaultDiscoveryFor,
  endpointKindOf,
  withoutDefaultDiscovery,
} from '../domain/mcp-url';
import {
  SharedPathKind,
  newestServed,
  servesPublicPath,
  servesUnlistedPath,
  sharingEndsAt,
  versionServes,
} from '../domain/sharing';
import { readSnapshotEntries } from '../domain/snapshot';
import {
  DEFAULT_SEARCH_THRESHOLD,
  McpEndpointView,
  EntryContract,
  StoredEntryRule,
  entryContractOf,
  ViewNotice,
  entryRulesOf,
} from '../domain/view';
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
 * /c/{category}           every LISTED tool of one topic; a topic no tool has is a 404
 * /@{handle}              every LISTED provider tool of one maker; a maker with none is a 404
 * ```
 *
 * Every view carries its discovery settings (`view.discovery`): the root's
 * SEARCH with its pinned tools, a topic's AUTO, the Draft's own on
 * `/my/{slug}`, and the published snapshot's on every versioned path.
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
    // The catalogue a `/c/{category}` path is checked against. Optional so a
    // hand-built resolver needs none; without it any well-formed topic resolves.
    @Optional() @Inject(TOOL_CATALOGUE) private readonly catalogue?: ToolCataloguePort,
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
        discovery: {
          mode: DiscoveryMode.SEARCH,
          searchThreshold: DEFAULT_SEARCH_THRESHOLD,
          pinnedTools: this.host.rootPinnedTools ?? [],
        },
        notice: null,
        defaultDiscovery: null,
      };
    }

    const shared =
      path.kind === McpPathKind.PUBLIC_TOOLSET ||
      path.kind === McpPathKind.UNLISTED_TOOLSET ||
      path.kind === McpPathKind.HANDLE;
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
    const canonical = withoutDefaultDiscovery(
      filter,
      defaultDiscoveryFor(filter, defaultDiscovery),
    );
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
        return this.categoryView(path);
      case McpPathKind.HANDLE:
        return this.handleView(path);
      default:
        throw McpErrors.urlNotFound();
    }
  }

  /**
   * `/@{handle}`: every LISTED provider tool of one maker (§7.4). A handle
   * that names nobody, a frozen one, the Official handle and a maker with no
   * LISTED provider tool are all the same 404: an UNLISTED or PRIVATE tool
   * never makes the URL exist.
   */
  private async handleView(
    path: Extract<McpPath, { kind: McpPathKind.HANDLE }>,
  ): Promise<BaseView> {
    const owner = await this.handles.resolve(path.handle);
    if (!owner || owner.kind !== 'ORG') throw McpErrors.urlNotFound();
    if (this.catalogue) {
      const tools = await this.catalogue.listTools();
      const served = tools.some(
        (tool) =>
          isListedTool(tool) && isProviderTool(tool) && tool.ownerOrgId === owner.organizationId,
      );
      if (!served) throw McpErrors.urlNotFound();
    }
    return {
      path,
      kind: endpointKindOf(path),
      toolset: null,
      handle: path.handle,
      baseToolIds: null,
      baseOwnerOrgId: owner.organizationId,
      entryRules: new Map(),
      discovery: {
        mode: DiscoveryMode.AUTO,
        searchThreshold: DEFAULT_SEARCH_THRESHOLD,
        pinnedTools: [],
      },
      notice: noticeOf(null, owner.renamedTo, owner.aliasUntil),
      defaultDiscovery: null,
    };
  }

  /** `/c/{category}`: every LISTED tool in one topic; a topic no tool has is a 404. */
  private async categoryView(
    path: Extract<McpPath, { kind: McpPathKind.CATEGORY }>,
  ): Promise<BaseView> {
    if (this.catalogue) {
      const tools = await this.catalogue.listTools();
      // Only the LISTED catalogue: a topic held by unlisted tools alone is
      // the same 404 as one no tool has, so it reveals nothing.
      const listed = tools.filter(isListedTool);
      if (!listed.some((tool) => categoryOf(tool) === path.category)) throw McpErrors.urlNotFound();
    }
    return {
      path,
      kind: endpointKindOf(path),
      toolset: null,
      handle: null,
      baseToolIds: null,
      baseCategory: path.category,
      entryRules: new Map(),
      discovery: {
        mode: DiscoveryMode.AUTO,
        searchThreshold: DEFAULT_SEARCH_THRESHOLD,
        pinnedTools: [],
      },
      notice: null,
      // `staticDiscoveryDefault` already dropped `discovery=auto` while parsing.
      defaultDiscovery: null,
    };
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
    const entryContracts = new Map<string, EntryContract>();
    for (const row of rows) {
      const rules = entryRulesOf(row);
      if (rules) entryRules.set(row.toolId, rules);
      const contract = entryContractOf(row);
      if (contract) entryContracts.set(row.toolId, contract);
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
        ownerOrgId: toolset.ownerOrgId,
      },
      handle: null,
      baseToolIds: rows.map((row) => row.toolId),
      entryRules,
      entryContracts,
      discovery: {
        mode: toolset.discovery.toLowerCase() as DiscoveryMode,
        searchThreshold: toolset.searchThreshold,
        pinnedTools: toolset.pinnedTools ?? [],
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

    const version = path.version ?? toolset.lastPublicVersion;
    if (!version) throw McpErrors.urlNotFound();
    return this.versionView(path, toolset, await this.requireVersion(toolset, version, 'PUBLIC'), {
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
    return this.versionView(
      path,
      toolset,
      await this.requireVersion(toolset, version, 'UNLISTED'),
      {
        handle: null,
        latest: path.version === null,
        notice: noticeOf(sharingEndsAt(state, 'UNLISTED'), null, null),
      },
    );
  }

  /**
   * The version row, or 404. `shared`: a shared URL kind, which serves only
   * versions published that way (`shared_as`) and never past its newest — a
   * version published PRIVATE, or UNLISTED during a PUBLIC grace period, never
   * reaches a URL that was not shared that way.
   */
  private async requireVersion(
    toolset: ToolsetEntity,
    version: number,
    shared: SharedPathKind | null = null,
  ): Promise<ToolsetVersionEntity> {
    const newest = shared ? newestServed(toolset, shared) : toolset.latestVersion;
    if (newest === null || version > newest) throw McpErrors.urlNotFound();
    const row = await this.versions.findVersion(toolset.id, version);
    if (!row) throw McpErrors.urlNotFound();
    if (shared && !versionServes(row.sharedAs, shared)) throw McpErrors.urlNotFound();
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
    const entryContracts = new Map<string, EntryContract>();
    for (const entry of snapshot) {
      const contract = entryContractOf(entry);
      if (contract) entryContracts.set(entry.toolId, contract);
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
        ownerOrgId: toolset.ownerOrgId,
      },
      handle: options.handle,
      baseToolIds: snapshot.map((entry) => entry.toolId),
      entryRules,
      entryContracts,
      // The snapshot's own discovery settings: a published version serves
      // the mode, threshold and pinned tools it was published with.
      discovery: {
        mode: row.discovery.toLowerCase() as DiscoveryMode,
        searchThreshold: row.searchThreshold,
        pinnedTools: row.pinnedTools ?? [],
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
