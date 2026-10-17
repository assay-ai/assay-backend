import { Inject, Injectable } from '@nestjs/common';

import {
  ToolsetEntryRepository,
  ToolsetRepository,
} from '@database/postgres/repositories/toolset.repository';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { EntryRoutingRules } from '@modules/tool/domain/routing';

import { MCP_HOST_CONFIG, McpHostConfig } from '../config/mcp-host.config';
import {
  DiscoveryMode,
  McpPath,
  McpPathKind,
  ParsedMcpUrl,
  canonicalUrl,
  endpointKindOf,
  withoutDefaultDiscovery,
} from '../domain/mcp-url';
import { McpEndpointView, entryRulesOf } from '../domain/view';
import { AccessEpochService } from './access-epoch.service';
import { ACCESS_CACHE_TTL_MS } from './access.resolver';

interface CachedView {
  readonly epoch: string;
  readonly at: number;
  readonly view: McpEndpointView;
}

/**
 * A parsed MCP URL → what it serves, for the organization asking
 * (design spec §7.4, "Resolution rules").
 *
 * T1 serves `/` and `/my/{slug}` (the live Draft). The other forms parse —
 * so their canonical URLs and browser redirects are already final — and
 * answer the same 404 here until the phase that serves them:
 *
 * ```text
 * /my/{slug}@n          T2  published versions
 * /c/{category}         T2
 * /@{handle}/{slug}[@n] T2  PUBLIC toolsets
 * /u/{token}[@n]        T2  UNLISTED toolsets
 * /@{handle}            T4  provider tools
 * ```
 *
 * Each is one `case` in {@link resolvePath}. A toolset of another
 * organization is the same 404 as a missing one.
 *
 * Cached per organization and canonical URL, against the organization's
 * access epoch, which a Draft edit bumps.
 */
@Injectable()
export class McpEndpointResolver {
  private readonly cache = new Map<string, CachedView>();

  constructor(
    private readonly toolsets: ToolsetRepository,
    private readonly entries: ToolsetEntryRepository,
    private readonly epochs: AccessEpochService,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
  ) {}

  /** The view `parsed` serves to `organizationId`, or `MCP_URL_NOT_FOUND`. */
  async resolve(organizationId: string, parsed: ParsedMcpUrl): Promise<McpEndpointView> {
    if (parsed.path.kind === McpPathKind.ROOT) return this.rootView(parsed);

    const key = `${organizationId}:${canonicalUrl(this.host.mcpPublicUrl, parsed)}`;
    const epoch = await this.epochs.current(organizationId);
    const cached = this.cache.get(key);
    if (epoch !== null && cached?.epoch === epoch && Date.now() - cached.at < ACCESS_CACHE_TTL_MS) {
      return cached.view;
    }

    const view = await this.resolvePath(organizationId, parsed.path, parsed);
    if (epoch !== null) this.cache.set(key, { epoch, at: Date.now(), view });
    return view;
  }

  private rootView(parsed: ParsedMcpUrl): McpEndpointView {
    return {
      canonicalUrl: canonicalUrl(this.host.mcpPublicUrl, parsed),
      path: parsed.path,
      kind: endpointKindOf(parsed.path),
      filter: parsed.filter,
      toolset: null,
      handle: null,
      baseToolIds: null,
      entryRules: new Map(),
    };
  }

  private async resolvePath(
    organizationId: string,
    path: McpPath,
    parsed: ParsedMcpUrl,
  ): Promise<McpEndpointView> {
    switch (path.kind) {
      case McpPathKind.MY_TOOLSET:
        // A published version is T2: no version exists yet, so a pin is a 404.
        if (path.version !== null) throw McpErrors.urlNotFound();
        return this.myToolsetView(organizationId, path.slug, parsed);
      case McpPathKind.CATEGORY:
      case McpPathKind.HANDLE:
      case McpPathKind.PUBLIC_TOOLSET:
      case McpPathKind.UNLISTED_TOOLSET:
      default:
        throw McpErrors.urlNotFound();
    }
  }

  private async myToolsetView(
    organizationId: string,
    slug: string,
    parsed: ParsedMcpUrl,
  ): Promise<McpEndpointView> {
    const toolset = await this.toolsets.findOwnedBySlug(organizationId, slug);
    if (!toolset) throw McpErrors.urlNotFound();

    const rows = await this.entries.findByToolsets([toolset.id]);
    const entryRules = new Map<string, EntryRoutingRules>();
    for (const row of rows) {
      const rules = entryRulesOf(row);
      if (rules) entryRules.set(row.toolId, rules);
    }

    // `discovery=` equal to the toolset's own mode is its default, and drops
    // out of the canonical URL.
    const own = toolset.discovery.toLowerCase() as DiscoveryMode;
    const canonical = { ...parsed, filter: withoutDefaultDiscovery(parsed.filter, own) };

    return {
      canonicalUrl: canonicalUrl(this.host.mcpPublicUrl, canonical),
      path: parsed.path,
      kind: endpointKindOf(parsed.path),
      filter: canonical.filter,
      toolset: { id: toolset.id, slug: toolset.slug, name: toolset.name, version: null },
      handle: null,
      baseToolIds: rows.map((row) => row.toolId),
      entryRules,
    };
  }
}
