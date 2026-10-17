import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AccountErrors } from '@modules/account/errors/account.errors';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { ChainId } from '@modules/chains/ports/caip.types';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { categoryOf } from '@modules/tool/ports/tool.types';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { ParsedMcpUrl, viewFilterRecord } from '@modules/toolset/domain/mcp-url';
import { selectViewTools, servesPricingMode } from '@modules/toolset/domain/view';
import { AccessResolver } from '@modules/toolset/services/access.resolver';
import { ConnectUrlsService } from '@modules/toolset/services/connect-urls.service';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { BaseError } from '@shared/errors/base.error';

import {
  McpUrlPreviewDto,
  PreviewToolDto,
  PreviewWarningDto,
  ServerInUseDto,
  ServersInUseDto,
} from '../dto/mcp-urls.dto';
import { McpErrorCode } from '../errors/mcp.errors';
import { McpScope, rulesFor, scopeAllows } from '../ports/mcp-scope';
import { McpCatalogueService } from './mcp-catalogue.service';

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
        return {
          canonicalUrl: row.canonicalUrl,
          endpointKind: row.endpointKind,
          toolsetId: preview?.toolsetId ?? row.toolsetId,
          name: preview?.toolsetName ?? row.serverName ?? 'assay',
          serverName: row.serverName,
          client: row.client,
          toolCount: preview?.listedCount ?? null,
          estimatedTokens: preview?.estimatedTokens ?? null,
          discovery: 'FULL',
          lastCallAt: row.lastCallAt?.toISOString() ?? null,
          handedOutAt: row.handedOutAt ? new Date(row.handedOutAt).toISOString() : null,
          firstCallAt: row.firstCallAt ? new Date(row.firstCallAt).toISOString() : null,
          waitingForFirstCall: row.handedOutAt !== null && !row.firstCallAt && !row.lastCallAt,
          available: preview !== null,
          // Versions arrive with publishing (T2).
          updateAvailable: false,
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
    const [quotes, listed] = await Promise.all([
      this.quotes.quoteMany(
        inView.map((tool) => tool.id),
        (toolId) => ({ ...context, rules: rulesFor(scope, toolId) }),
      ),
      this.catalogue.listTools({ organizationId, agentId, chainId }, scope),
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
      discovery: 'FULL',
      listedCount: listed.length,
      estimatedTokens: Math.ceil(JSON.stringify(listed).length / CHARS_PER_TOKEN),
      freeOnly: view.filter.free,
      tools,
      ignoredTools: [...ignoredTools],
      warnings: warningsOf(tools, ignoredTools),
    };
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

function displayOf(meta: Record<string, unknown> | undefined): string | null {
  const price = meta?.['x402/price'] as { display?: string } | undefined;
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
