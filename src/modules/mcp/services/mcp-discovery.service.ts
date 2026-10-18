import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  JsonObject,
  JsonSchema,
  MappingDirection,
  MappingFault,
  validateAgainstSchema,
} from '@modules/tool/domain/mapping';
import { ToolAccessErrors } from '@modules/tool/errors/tool-access.errors';
import { ToolErrors } from '@modules/tool/errors/tool.errors';
import { Tool, ToolKind, categoryOf, isNotReviewed } from '@modules/tool/ports/tool.types';
import { DiscoveryMode } from '@modules/toolset/domain/mcp-url';

import {
  MCP_DISCOVERY_CONFIG,
  McpDiscoveryConfig,
  loadMcpDiscoveryConfig,
} from '../config/mcp-discovery.config';
import { X402_PRICE } from '../constants/mcp.constants';
import { SearchDocument, rankBm25 } from '../domain/bm25';
import {
  GET_TOOL,
  GET_TOOL_INPUT,
  MetaToolDefinition,
  SEARCH_CATEGORY_MAX_LENGTH,
  SEARCH_QUERY_MAX_BYTES,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_RESPONSE_MAX_BYTES,
  SEARCH_TOOLS,
  SEARCH_TOOLS_INPUT,
  argumentText,
  effectiveMode,
  limitFor,
  metaToolDefinitions,
  pinnedNames,
  pinnedWithin,
} from '../domain/discovery';
import { versionOf } from '@modules/tool/domain/contract/contract-versions';
import {
  CursorBinding,
  SearchCursorCodec,
  SearchDetail,
  SearchPosition,
} from '../domain/search-cursor';
import { McpScope } from '../ports/mcp-scope';
import { McpSession } from '../ports/mcp-session.port';
import {
  ASSAY_NO_PROVIDER_FITS,
  McpCatalogueService,
  McpCatalogueViewer,
  McpPriceAnnotation,
  McpToolDescriptor,
  contractMetaOf,
} from './mcp-catalogue.service';
import {
  MCP_RATE_CLOCK,
  MCP_RATE_LIMITS,
  McpRateLimiter,
  getToolKey,
  searchKey,
} from './mcp-rate-limiter.service';

/** What `tools/list` returns for one URL and caller. */
export interface DiscoveryListing {
  readonly mode: DiscoveryMode.FULL | DiscoveryMode.SEARCH;
  readonly tools: ReadonlyArray<McpToolDescriptor | MetaToolDefinition>;
}

/** One `search_tools` result. Fields beyond `name` and `score` depend on `detail`. */
export interface SearchResult {
  readonly name: string;
  readonly summary?: string;
  /** The contract version a call would use (`1.2.0`). */
  readonly version?: string;
  readonly kind?: string;
  readonly price?: string | null;
  readonly freeCallsLeftToday?: number | null;
  readonly score: number;
  readonly inputSchema?: Record<string, unknown>;
  /** `detail: full` only: the schema did not fit the 256 KB cap; `get_tool` has it. */
  readonly inputSchemaOmitted?: boolean;
  readonly note?: string;
  /** A provider tool no operator has reviewed (§7.6): shown before anyone pays for it. */
  readonly notReviewed?: boolean;
}

/** `search_tools`'s output (design spec §7.4). */
export interface SearchOutput {
  readonly results: readonly SearchResult[];
  readonly categories: readonly string[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly limitApplied: number;
}

/**
 * `tools/list` by discovery mode, `search_tools` and `get_tool` (design spec
 * §7.4, FR-12).
 *
 * **Every answer is drawn from view ∩ access** — `McpCatalogueService`'s
 * `scopedTools`, priced by the same `listTools` that FULL mode returns. A
 * tool outside the URL's view, outside the agent's (or the key's) access, or
 * served only by another URL, never scores, never pages and never resolves
 * in `get_tool`; a name that exists elsewhere is the same `TOOL_NOT_IN_TOOLSET`
 * as one that exists nowhere. Each page and each `get_tool` scopes again, so a
 * cursor or a cached name never outlives a change of access.
 */
@Injectable()
export class McpDiscoveryService {
  private codec: SearchCursorCodec | null = null;

  constructor(
    private readonly catalogue: McpCatalogueService,
    @Optional() private readonly limiter?: McpRateLimiter,
    // Read from the environment on first use when not injected, so a process
    // that never pages (the API, which imports this module for its
    // catalogue) needs no cursor secret. The MCP process checks it at boot.
    @Optional() @Inject(MCP_DISCOVERY_CONFIG) private readonly config?: McpDiscoveryConfig,
    @Optional() @Inject(MCP_RATE_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  private get cursors(): SearchCursorCodec {
    this.codec ??= new SearchCursorCodec((this.config ?? loadMcpDiscoveryConfig()).cursorSecret);
    return this.codec;
  }

  /** `tools/list`: every tool (FULL), or the pinned tools and the three meta tools (SEARCH). */
  async list(viewer: McpCatalogueViewer, scope: McpScope): Promise<DiscoveryListing> {
    const scoped = await this.catalogue.scopedTools(scope);
    const mode = effectiveMode(scope.view, scoped.length);
    if (mode === DiscoveryMode.FULL) {
      return { mode, tools: await this.catalogue.listTools(viewer, scope) };
    }

    const pinned = pinnedWithin(pinnedNames(scope.view, scope.access.pinnedTools), scoped);
    const priced =
      pinned.length === 0
        ? []
        : await this.catalogue.listTools(viewer, scope, {
            onlyToolIds: new Set(pinned.map((tool) => tool.id)),
          });
    const order = new Map(pinned.map((tool, index) => [tool.name, index]));
    const pinnedDescriptors = [...priced].sort(
      (a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0),
    );
    return {
      mode,
      tools: [...pinnedDescriptors, ...metaToolDefinitions(scoped.length, categoriesOf(scoped))],
    };
  }

  /** `search_tools`. Free; 30 a minute per agent. */
  async search(session: McpSession, scope: McpScope, args: JsonObject): Promise<SearchOutput> {
    validateMetaArguments(SEARCH_TOOLS, SEARCH_TOOLS_INPUT, args);
    await this.limit(searchKey(session.agentId), MCP_RATE_LIMITS.searchesPerMinute);

    const binding: CursorBinding = {
      credentialId: session.credentialId,
      canonicalUrl: scope.view.canonicalUrl,
    };
    const position = this.positionOf(args, binding);
    const { request } = position;
    const viewer = viewerOf(session);

    // Each tool at the contract version a call would use: its stored
    // summary, its schemas (T3).
    const entries: Entry[] = await this.catalogue.listQuoted(viewer, scope, { freeQuota: false });

    const categories = categoriesOf(entries.map((entry) => entry.tool));
    const candidates = request.category
      ? entries.filter((entry) => categoryOf(entry.tool) === request.category)
      : entries;
    const ranked = rankBm25(request.query, candidates.map(documentOf));

    const page: SearchResult[] = [];
    for (const hit of ranked.slice(position.offset, position.offset + request.limit)) {
      page.push(await this.resultOf(hit.item, hit.score, request.detail, viewer));
    }

    const assemble = (results: SearchResult[]): SearchOutput => {
      const nextOffset = position.offset + results.length;
      return {
        results,
        categories,
        total: ranked.length,
        nextCursor:
          results.length > 0 && nextOffset < ranked.length
            ? this.cursors.next(binding, position, nextOffset)
            : null,
        limitApplied: request.limit,
      };
    };

    // The 256 KB cap is hard and measured on the real output, cursor
    // included: fewer results first (paging goes on from the cursor), and a
    // single result that is still too large loses its input schema, which
    // get_tool returns on its own.
    let output = assemble(page);
    while (responseBytes(output) > SEARCH_RESPONSE_MAX_BYTES && page.length > 1) {
      page.pop();
      output = assemble(page);
    }
    if (responseBytes(output) > SEARCH_RESPONSE_MAX_BYTES && page[0]?.inputSchema) {
      const slim: Record<string, unknown> = { ...page[0] };
      delete slim.inputSchema;
      page[0] = {
        ...(slim as unknown as SearchResult),
        inputSchemaOmitted: true,
        note: SCHEMA_OMITTED_NOTE,
      };
      output = assemble(page);
    }
    return output;
  }

  /** `get_tool`. Free; 120 a minute per agent. Only a tool in view ∩ access. */
  async getTool(
    session: McpSession,
    scope: McpScope,
    args: JsonObject,
  ): Promise<Record<string, unknown>> {
    validateMetaArguments(GET_TOOL, GET_TOOL_INPUT, args);
    await this.limit(getToolKey(session.agentId), MCP_RATE_LIMITS.getToolsPerMinute);

    const name = args.name as string;
    const scoped = (await this.catalogue.scopedTools(scope)).find(
      (candidate) => candidate.name === name,
    );
    const viewer = viewerOf(session);
    const [entry] = scoped
      ? await this.catalogue.listQuoted(viewer, scope, { onlyToolIds: new Set([scoped.id]) })
      : [];
    // Not served here, not allowed, unknown, or listed nowhere for want of a
    // provider: one answer for all, so nothing outside view ∩ access leaks.
    if (!scoped || !entry) throw ToolAccessErrors.notInToolset({ details: { name } });

    // The tool at the contract version a call through this URL would use now.
    const { tool, descriptor } = entry;
    const version = versionOf(tool);
    const price = (descriptor.annotations[X402_PRICE] as McpPriceAnnotation | undefined) ?? null;
    return {
      name: tool.name,
      kind: kindOf(tool),
      ...(isNotReviewed(tool) ? { notReviewed: true } : {}),
      category: categoryOf(tool),
      tags: [...(tool.tags ?? [])],
      summary: version.summary,
      description: version.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      optionalInputFields: [...version.optionalInputFields],
      optionalOutputFields: [...version.optionalOutputFields],
      examples: version.examples.map((example) => ({ ...example })),
      version: version.semver,
      ...(version.changelog ? { changelog: version.changelog } : {}),
      ...contractMetaOf(tool),
      tier: String(tool.tier).toLowerCase(),
      price,
      noProviderFits: descriptor.annotations[ASSAY_NO_PROVIDER_FITS] === true,
      freeCallsLeftToday: await this.freeCallsLeft(viewer, tool, descriptor),
      annotations: descriptor.annotations,
    };
  }

  private positionOf(args: JsonObject, binding: CursorBinding): SearchPosition {
    if (typeof args.cursor === 'string') {
      const position = this.cursors.read(args.cursor, binding, this.now());
      if (!position) throw ToolAccessErrors.invalidCursor();
      return position;
    }
    if (typeof args.query !== 'string') {
      throw ToolErrors.argumentsInvalid({ detail: '/query is required without a cursor' });
    }
    const query = withoutControlCharacters(args.query);
    if (query.length > SEARCH_QUERY_MAX_LENGTH || byteLength(query) > SEARCH_QUERY_MAX_BYTES) {
      throw ToolErrors.argumentsInvalid({
        detail:
          `/query is longer than ${SEARCH_QUERY_MAX_LENGTH} characters ` +
          `or ${SEARCH_QUERY_MAX_BYTES} UTF-8 bytes`,
      });
    }
    const category =
      typeof args.category === 'string'
        ? withoutControlCharacters(args.category).toLowerCase()
        : null;
    if (category !== null && category.length > SEARCH_CATEGORY_MAX_LENGTH) {
      throw ToolErrors.argumentsInvalid({
        detail: `/category is longer than ${SEARCH_CATEGORY_MAX_LENGTH} characters`,
      });
    }
    const detail = (args.detail as SearchDetail | undefined) ?? 'summary';
    return {
      request: {
        query,
        category,
        detail,
        limit: limitFor(detail, args.limit as number | undefined),
      },
      offset: 0,
      page: 1,
      startedAt: this.now(),
    };
  }

  private async resultOf(
    entry: Entry,
    score: number,
    detail: SearchDetail,
    viewer: McpCatalogueViewer,
  ): Promise<SearchResult> {
    const reviewFlag = isNotReviewed(entry.tool) ? { notReviewed: true } : {};
    if (detail === 'names') return { name: entry.tool.name, score, ...reviewFlag };
    const result: SearchResult = {
      ...reviewFlag,
      name: entry.tool.name,
      summary: versionOf(entry.tool).summary,
      version: versionOf(entry.tool).semver,
      kind: kindOf(entry.tool),
      price: priceText(entry.descriptor),
      freeCallsLeftToday: await this.freeCallsLeft(viewer, entry.tool, entry.descriptor),
      score,
    };
    return detail === 'full'
      ? { ...result, inputSchema: entry.tool.inputSchema as unknown as Record<string, unknown> }
      : result;
  }

  private async freeCallsLeft(
    viewer: McpCatalogueViewer,
    tool: Tool,
    descriptor: McpToolDescriptor,
  ): Promise<number | null> {
    const mode = descriptor.annotations['x402/pricingMode'];
    if (mode !== 'FREE' && mode !== 'FREEMIUM') return null;
    return this.catalogue.freeCallsLeft(viewer, tool.id);
  }

  private async limit(key: string, perMinute: number): Promise<void> {
    if (!this.limiter) return;
    const rate = await this.limiter.take(key, perMinute);
    if (!rate.allowed) throw ToolAccessErrors.rateLimited({ retryAfterMs: rate.retryAfterMs });
  }
}

interface Entry {
  readonly tool: Tool;
  readonly descriptor: McpToolDescriptor;
}

/** Name, summary, description, arguments, tags and category, weighted. */
function documentOf(entry: Entry): SearchDocument<Entry> {
  const { tool } = entry;
  return {
    item: entry,
    key: tool.name,
    fields: [
      { text: tool.name, weight: 3 },
      { text: versionOf(tool).summary, weight: 2 },
      { text: tool.description, weight: 1 },
      { text: argumentText(tool.inputSchema), weight: 1 },
      { text: (tool.tags ?? []).join(' '), weight: 2 },
      { text: categoryOf(tool), weight: 2 },
    ],
  };
}

function categoriesOf(tools: readonly Tool[]): string[] {
  return [...new Set(tools.map(categoryOf))].sort();
}

function kindOf(tool: Tool): string {
  return (tool as Tool & { kind?: ToolKind }).kind ?? ToolKind.STANDARD;
}

function priceText(descriptor: McpToolDescriptor): string | null {
  if (descriptor.annotations[ASSAY_NO_PROVIDER_FITS] === true)
    return 'No provider fits your limits';
  const price = descriptor.annotations[X402_PRICE] as McpPriceAnnotation | undefined;
  return price?.display ?? null;
}

function viewerOf(session: McpSession): McpCatalogueViewer {
  return {
    organizationId: session.organizationId,
    agentId: session.agentId,
    chainId: session.chainId,
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
}

/** The CallToolResult around `output`: its JSON twice (text and structured), plus the envelope. */
function responseBytes(output: SearchOutput): number {
  return 2 * byteLength(output) + RESPONSE_ENVELOPE_BYTES;
}

/** JSON-RPC envelope, content wrapper and `_meta` around a search result, generously. */
const RESPONSE_ENVELOPE_BYTES = 2_048;

const SCHEMA_OMITTED_NOTE =
  'The input schema is too large for one search response; read it with get_tool.';

/** Control characters say nothing to a search and only bloat a cursor: each becomes a space. */
function withoutControlCharacters(text: string): string {
  return text.replace(/\p{Cc}/gu, ' ');
}

/** A meta tool's arguments against its schema: the same error a tool's own arguments get. */
function validateMetaArguments(name: string, schema: JsonSchema, args: JsonObject): void {
  validateAgainstSchema(args, schema, {
    direction: MappingDirection.REQUEST,
    fault: MappingFault.AGENT,
    context: { toolId: name },
  });
}
