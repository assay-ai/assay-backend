import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AccountErrors } from '@modules/account/errors/account.errors';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { PricingMode, categoryOf } from '@modules/tool/ports/tool.types';
import { ToolQuote } from '@modules/tool/services/provider-router.service';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { McpPathKind } from '@modules/toolset/domain/mcp-url';
import { attributionOf } from '@modules/toolset/domain/attribution';
import {
  DiscoveryMode,
  ParsedMcpUrl,
  defaultDiscoveryFor,
  staticDiscoveryDefault,
  viewFilterRecord,
  withoutDefaultDiscovery,
} from '@modules/toolset/domain/mcp-url';
import { selectViewTools, servesPricingMode } from '@modules/toolset/domain/view';
import { AccessResolver } from '@modules/toolset/services/access.resolver';
import { ConnectUrlsService } from '@modules/toolset/services/connect-urls.service';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { BaseError } from '@shared/errors/base.error';

import {
  McpUrlPreviewDto,
  NoFitReason,
  PreviewToolDto,
  PreviewWarningDto,
  ServerInUseDto,
  ServersInUseDto,
} from '../dto/mcp-urls.dto';
import { McpErrorCode } from '../errors/mcp.errors';
import { McpScope, rulesFor, scopeAllows } from '../ports/mcp-scope';
import { McpCatalogueService } from './mcp-catalogue.service';
import { McpDiscoveryService } from './mcp-discovery.service';

/** "Over budget": servers that show every tool, adding up to more than this (§7.10). */
export const SHOW_ALL_TOOL_BUDGET = 25;

/** Roughly four characters per token for JSON tool definitions. */
const CHARS_PER_TOKEN = 4;

/**
 * `POST /mcp-urls/preview` and Servers in use (design spec §7.9–§7.11).
 *
 * A preview **parses** the URL — it accepts only this host's MCP URLs and
 * never makes a request to one — then computes exactly what `tools/list`
 * would return there for the agent: the URL's view, intersected with the
 * agent's access, priced from the quote index under the merged rules.
 */
@Injectable()
export class McpUrlPreviewService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly connectUrls: ConnectUrlsService,
    private readonly endpoints: McpEndpointResolver,
    private readonly access: AccessResolver,
    private readonly catalogue: McpCatalogueService,
    @Inject(TOOL_CATALOGUE) private readonly tools: ToolCataloguePort,
    private readonly quotes: QuoteIndexService,
    private readonly config: ConfigService,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
    private readonly discovery: McpDiscoveryService,
  ) {}

  async preview(organizationId: string, url: string, agentId: string): Promise<McpUrlPreviewDto> {
    const agent = await this.requireAgent(organizationId, agentId);
    const { parsed } = this.connectUrls.canonicalise(url);
    return this.describe(organizationId, agentId, this.chainOf(agent.chainId), parsed);
  }

  async recordConnectUrl(
    organizationId: string,
    agentId: string,
    input: { url: string; serverName?: string; client?: string },
  ): Promise<ServerInUseDto> {
    await this.requireAgent(organizationId, agentId);
    const canonical = await this.connectUrls.record(organizationId, agentId, {
      url: input.url,
      serverName: input.serverName ?? null,
      client: input.client ?? null,
    });
    const { servers } = await this.serversInUse(organizationId, agentId);
    return servers.find((server) => server.canonicalUrl === canonical) as ServerInUseDto;
  }

  async serversInUse(organizationId: string, agentId: string): Promise<ServersInUseDto> {
    const agent = await this.requireAgent(organizationId, agentId);
    const chainId = this.chainOf(agent.chainId);
    const rows = await this.connectUrls.serversInUse(organizationId, agentId);

    const servers = await Promise.all(
      rows.map(async (row): Promise<ServerInUseDto> => {
        const preview = await this.describe(organizationId, agentId, chainId, row.parsed).catch(
          (error: unknown) => {
            if (error instanceof BaseError && error.errorCode === McpErrorCode.MCP_URL_NOT_FOUND) {
              return null;
            }
            throw error;
          },
        );
        const discovery = preview?.discovery ?? 'FULL';
        // Only for a URL that serves now, on the path the URL itself names.
        const update = preview
          ? await this.connectUrls.updateFor(organizationId, row.parsed)
          : null;
        return {
          canonicalUrl: row.canonicalUrl,
          endpointKind: row.endpointKind,
          // Only what the URL serves to this organization now — never the id
          // behind a URL that stopped serving (or never served) it, unless the
          // toolset is the organization's own.
          toolsetId:
            preview?.toolsetId ??
            (row.parsed.path.kind === McpPathKind.MY_TOOLSET ? row.toolsetId : null),
          name: preview?.toolsetName ?? row.serverName ?? 'assay',
          serverName: row.serverName,
          client: row.client,
          toolCount: preview?.listedCount ?? null,
          estimatedTokens: preview?.estimatedTokens ?? null,
          discovery,
          searchUrl:
            preview && discovery === 'FULL'
              ? await this.searchUrlOf(organizationId, row.parsed)
              : null,
          lastCallAt: row.lastCallAt?.toISOString() ?? null,
          handedOutAt: row.handedOutAt ? new Date(row.handedOutAt).toISOString() : null,
          firstCallAt: row.firstCallAt ? new Date(row.firstCallAt).toISOString() : null,
          waitingForFirstCall: row.handedOutAt !== null && !row.firstCallAt && !row.lastCallAt,
          available: preview !== null,
          updateAvailable: update !== null,
          latestVersion: update?.latestVersion ?? null,
          latestUrl: update?.latestUrl ?? null,
        };
      }),
    );

    const shownInFull = servers
      .filter((server) => server.discovery === 'FULL')
      .reduce((sum, server) => sum + (server.toolCount ?? 0), 0);
    return { servers, overBudget: shownInFull > SHOW_ALL_TOOL_BUDGET };
  }

  private async describe(
    organizationId: string,
    agentId: string,
    chainId: ChainId,
    parsed: ParsedMcpUrl,
  ): Promise<McpUrlPreviewDto> {
    const view = await this.endpoints.resolve(organizationId, parsed);
    const scope: McpScope = {
      view,
      access: await this.access.resolveFor(organizationId, agentId, null),
      attribution: attributionOf(view),
    };

    const catalogue = await this.tools.listTools();
    const { tools: inView, ignoredTools } = selectViewTools(view, catalogue);
    const context = {
      payerChains: this.enabledChains,
      withdrawingChains: [],
      defaultChainId: chainId,
      enabledChains: this.enabledChains,
    };
    const viewer = { organizationId, agentId, chainId };
    const [quotes, listed, listing] = await Promise.all([
      this.quotes.quoteMany(
        inView.map((tool) => tool.id),
        (toolId) => ({ ...context, rules: rulesFor(scope, toolId) }),
      ),
      this.catalogue.listTools(viewer, scope),
      // Exactly what `tools/list` returns here: every tool, or (SEARCH) the
      // pinned tools and the three meta tools.
      this.discovery.list(viewer, scope),
    ]);
    const listedNames = new Set(listed.map((descriptor) => descriptor.name));

    const tools: PreviewToolDto[] = inView
      .map((tool) => {
        const quote = quotes.get(tool.id) ?? null;
        return {
          toolId: tool.id,
          name: tool.name,
          category: categoryOf(tool),
          listed: listedNames.has(tool.name),
          allowed: scopeAllows(scope, tool.id),
          pricingMode: quote?.pricingMode ?? null,
          price: displayOf(listed.find((descriptor) => descriptor.name === tool.name)?._meta),
          providerCount: quote?.routableBindings ?? 0,
          noProviderFits: Boolean(quote && !quote.price && quote.ruleRejections?.length),
          noFitReason: noFitReasonOf(quote, chainId),
        };
      })
      // `?free=1` serves only what can be free; a paid tool is not in its view.
      .filter((tool) => servesPricingMode(view.filter, tool.pricingMode));

    return {
      canonicalUrl: view.canonicalUrl,
      endpointKind: view.kind,
      toolsetId: view.toolset?.id ?? null,
      toolsetName: view.toolset?.name ?? null,
      viewFilter: viewFilterRecord(view.filter),
      // T1 lists every tool on every URL; search mode is T2.
      discovery: listing.mode === DiscoveryMode.SEARCH ? 'SEARCH' : 'FULL',
      listedCount: listing.tools.length,
      reachableCount: listed.length,
      listedTools: listing.tools.map((tool) => tool.name),
      estimatedTokens: Math.ceil(JSON.stringify(listing.tools).length / CHARS_PER_TOKEN),
      freeOnly: view.filter.free,
      tools,
      ignoredTools: [...ignoredTools],
      warnings: warningsOf(tools, ignoredTools),
    };
  }

  /** The URL with `discovery=search` (dropped again when search is its default). */
  private async searchUrlOf(organizationId: string, parsed: ParsedMcpUrl): Promise<string> {
    const searching = { ...parsed.filter, discovery: DiscoveryMode.SEARCH };
    const filter = withoutDefaultDiscovery(
      searching,
      defaultDiscoveryFor(searching, staticDiscoveryDefault(parsed.path)),
    );
    const view = await this.endpoints.resolve(organizationId, { ...parsed, filter });
    return view.canonicalUrl;
  }

  private async requireAgent(organizationId: string, agentId: string) {
    const agent = await this.agents.findById(agentId);
    if (!agent || agent.organizationId !== organizationId) {
      throw AccountErrors.agentNotFound({ agentId });
    }
    return agent;
  }

  private chainOf(chainId: string | null): ChainId {
    return (chainId ||
      this.config.get<string>('auth.privy.defaultChainId') ||
      this.enabledChains[0]) as ChainId;
  }
}

/**
 * Why this agent cannot run a tool here, or null when it can (display only:
 * counts and routing are unchanged).
 *
 * - `RULES`: the rules (the agent's, or the tool set's entry) removed every
 *   provider.
 * - `OTHER_CHAIN`: the tool has a paid price, but none of its providers settles
 *   on the agent's own chain, so a paid call from this agent is refused (a
 *   call pays on `[session.chainId]`). The quote itself counts every enabled
 *   chain, so this is read from `settlementChains` (review 2026-10-18 F-P1:
 *   a Solana-only provider and an EVM buyer, both chains enabled).
 */
export function noFitReasonOf(quote: ToolQuote | null, agentChain: ChainId): NoFitReason | null {
  if (!quote) return null;
  if (!quote.price) return quote.ruleRejections?.length ? 'RULES' : null;
  if (quote.pricingMode === PricingMode.FREE) return null;
  return quote.settlementChains.includes(agentChain) ? null : 'OTHER_CHAIN';
}

function displayOf(meta: Record<string, unknown> | undefined): string | null {
  const price = meta?.['assay/price'] as { display?: string } | undefined;
  return price?.display ?? null;
}

export function warningsOf(
  tools: readonly PreviewToolDto[],
  ignored: readonly string[],
): PreviewWarningDto[] {
  const warnings: PreviewWarningDto[] = [];
  const add = (code: string, about: PreviewWarningDto['tools']) => {
    if (about.length > 0) warnings.push({ code, tools: about });
  };
  const ref = (tool: PreviewToolDto) => ({ toolId: tool.toolId, name: tool.name });
  add(
    'NO_BACKUP_PROVIDER',
    tools.filter((tool) => tool.listed && tool.providerCount === 1).map(ref),
  );
  add('BLOCKED_BY_ACCESS', tools.filter((tool) => !tool.allowed).map(ref));
  add('NO_PROVIDER_FITS', tools.filter((tool) => tool.allowed && tool.noProviderFits).map(ref));
  if (tools.length > 0 && !tools.some((tool) => tool.allowed)) {
    warnings.push({ code: 'NOTHING_ALLOWED', tools: [] });
  }
  // An ignored `?tools=` name matches no tool this URL serves, so it has no id.
  add(
    'IGNORED_TOOLS',
    ignored.map((name) => ({ toolId: null, name })),
  );
  return warnings;
}
