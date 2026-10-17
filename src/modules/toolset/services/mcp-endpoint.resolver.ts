import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  ToolsetEntryRepository,
  ToolsetRepository,
} from '@database/postgres/repositories/toolset.repository';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { EntryRoutingRules } from '@modules/tool/domain/routing';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { categoryOf } from '@modules/tool/ports/tool.types';

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
import { DEFAULT_SEARCH_THRESHOLD, McpEndpointView, entryRulesOf } from '../domain/view';
import { AccessEpochService } from './access-epoch.service';
import { ACCESS_CACHE_TTL_MS } from './access.resolver';

/** What a path serves, before any view filter. */
type BaseView = Omit<McpEndpointView, 'canonicalUrl' | 'filter'> & {
  /** The discovery mode a `discovery=` equal to is the default, and drops out. */
  readonly defaultDiscovery: DiscoveryMode | null;
};

interface CachedView {
  readonly epoch: string;
  readonly view: BaseView;
}

/** Base views kept per process: organizations × the toolsets they serve. */
export const ENDPOINT_CACHE_MAX_ENTRIES = 10_000;

/**
 * A parsed MCP URL → what it serves, for the organization asking
 * (design spec §7.4, "Resolution rules").
 *
 * Served: `/` (the whole catalogue, SEARCH by default), `/c/{category}` (one
 * topic, AUTO) and `/my/{slug}` (the live Draft, the toolset's own discovery
 * settings). The other forms parse — so their canonical URLs and browser
 * redirects are already final — and answer the same 404 here until the phase
 * that serves them:
 *
 * ```text
 * /my/{slug}@n          T2  published versions
 * /@{handle}/{slug}[@n] T2  PUBLIC toolsets
 * /u/{token}[@n]        T2  UNLISTED toolsets
 * /@{handle}            T4  provider tools
 * ```
 *
 * Each is one `case` in {@link resolvePath}. A toolset of another
 * organization is the same 404 as a missing one.
 *
 * The base view (what the path serves, before any filter) is cached per
 * organization and canonical path, against the organization's access epoch,
 * which a Draft edit bumps, in a bounded LRU. The view filters are applied
 * after the lookup, so `?tools=` variants an agent invents never multiply the
 * entries.
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
    // The catalogue a `/c/{category}` path is checked against. Optional so a
    // hand-built resolver needs none; without it any well-formed topic resolves.
    @Optional() @Inject(TOOL_CATALOGUE) private readonly catalogue?: ToolCataloguePort,
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
        defaultDiscovery: null,
      };
    }

    const key = `${organizationId}:${canonicalPath(path)}`;
    const epoch = await this.epochs.current(organizationId);
    const cached = this.cache.get(key);
    if (epoch !== null && cached?.epoch === epoch) return cached.view;

    const view = await this.resolvePath(organizationId, path);
    if (epoch !== null) this.cache.set(key, { epoch, view });
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
        // A published version is T2: no version exists yet, so a pin is a 404.
        if (path.version !== null) throw McpErrors.urlNotFound();
        return this.myToolsetView(organizationId, path);
      case McpPathKind.CATEGORY:
        return this.categoryView(path);
      case McpPathKind.HANDLE:
      case McpPathKind.PUBLIC_TOOLSET:
      case McpPathKind.UNLISTED_TOOLSET:
      default:
        throw McpErrors.urlNotFound();
    }
  }

  /** `/c/{category}`: every LISTED tool in one topic; a topic no tool has is a 404. */
  private async categoryView(
    path: Extract<McpPath, { kind: McpPathKind.CATEGORY }>,
  ): Promise<BaseView> {
    if (this.catalogue) {
      const tools = await this.catalogue.listTools();
      if (!tools.some((tool) => categoryOf(tool) === path.category)) throw McpErrors.urlNotFound();
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

    const rows = await this.entries.findByToolsets([toolset.id]);
    const entryRules = new Map<string, EntryRoutingRules>();
    for (const row of rows) {
      const rules = entryRulesOf(row);
      if (rules) entryRules.set(row.toolId, rules);
    }

    return {
      path,
      kind: endpointKindOf(path),
      toolset: { id: toolset.id, slug: toolset.slug, name: toolset.name, version: null },
      handle: null,
      baseToolIds: rows.map((row) => row.toolId),
      entryRules,
      discovery: {
        mode: toolset.discovery.toLowerCase() as DiscoveryMode,
        searchThreshold: toolset.searchThreshold,
        pinnedTools: toolset.pinnedTools ?? [],
      },
      defaultDiscovery: toolset.discovery.toLowerCase() as DiscoveryMode,
    };
  }
}
