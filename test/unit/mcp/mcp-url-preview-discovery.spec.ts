import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import { McpCatalogueService } from '@modules/mcp/services/mcp-catalogue.service';
import { McpDiscoveryService } from '@modules/mcp/services/mcp-discovery.service';
import { McpUrlPreviewService } from '@modules/mcp/services/mcp-url-preview.service';
import { PricingMode, Tool, ToolTier } from '@modules/tool/ports/tool.types';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import {
  EndpointKind,
  ParsedMcpUrl,
  canonicalUrl,
  endpointKindOf,
  parseMcpUrl,
} from '@modules/toolset/domain/mcp-url';

import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import { usdc } from '../tool/helpers/routing-fixtures';
import { CHAIN_ID } from './helpers/mcp-harness';

const ORG = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const HOST = 'https://mcp.example.com';

const TOOLS: Tool[] = ['get_weather', 'geocode_place', 'get_token_market'].map((name) => ({
  id: `tool-${name}`,
  name,
  description: `${name}.`,
  category: 'misc',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
}));

function preview(): McpUrlPreviewService {
  const quotes = {
    quoteMany: async (ids: readonly string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            tool: TOOLS.find((t) => t.id === id),
            price: usdc('0.01'),
            cheapestPrice: usdc('0.01'),
            pricingMode: PricingMode.PAID,
            routableBindings: 1,
            paidBindings: 1,
            settlementChains: [CHAIN_ID],
            p95LatencyMs: null,
            qualityRate: null,
            unroutableReason: null,
          },
        ]),
      ),
  } as unknown as QuoteIndexService;
  const tools = new InMemoryToolCatalogue({ tools: TOOLS, bindings: [] });
  const catalogue = new McpCatalogueService(
    tools,
    undefined as never,
    {
      remainingForTool: async () => null,
      dailyAllowance: () => null,
    } as unknown as FreeQuotaService,
    [CHAIN_ID],
    quotes,
  );
  const resolve = async (_org: string, parsed: ParsedMcpUrl) => ({
    canonicalUrl: canonicalUrl(HOST, parsed),
    path: parsed.path,
    kind: endpointKindOf(parsed.path),
    filter: parsed.filter,
    toolset: null,
    handle: null,
    baseToolIds: null,
    entryRules: new Map(),
  });
  const rows = [
    `${HOST}/`,
    `${HOST}/?discovery=full`,
    `${HOST}/?tools=geocode_place,get_weather`,
  ].map((url) => ({
    canonicalUrl: url,
    parsed: parseMcpUrl(url.slice(HOST.length))!,
    endpointKind: EndpointKind.ROOT,
    toolsetId: null,
    serverName: null,
    client: null,
    lastCallAt: new Date(0),
    handedOutAt: null,
    firstCallAt: null,
  }));
  return new McpUrlPreviewService(
    { findById: async () => ({ id: AGENT, organizationId: ORG, chainId: CHAIN_ID }) } as never,
    {
      canonicalise: (url: string) => ({ parsed: parseMcpUrl(url.slice(HOST.length))! }),
      serversInUse: async () => rows,
    } as never,
    { resolve } as never,
    {
      resolveFor: async () => ({
        agentId: AGENT,
        agent: ALLOW_ALL,
        key: null,
        rules: null,
        pinnedTools: ['geocode_place'],
        policyVersion: 1,
      }),
    } as never,
    catalogue,
    tools,
    quotes,
    { get: () => undefined } as never,
    [CHAIN_ID],
    new McpDiscoveryService(catalogue, undefined, { cursorSecret: 'x'.repeat(32) }),
  );
}

/** The Connect preview says what `tools/list` will return, mode included (§7.11). */
describe('the Connect preview and Servers in use — discovery', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('the root previews as SEARCH: the pinned tools and the meta tools, the rest reachable', async () => {
    const result = await preview().preview(ORG, `${HOST}/`, AGENT);
    expect(result).toMatchObject({
      discovery: 'SEARCH',
      listedTools: ['geocode_place', 'search_tools', 'get_tool', 'call_tool'],
      listedCount: 4,
      reachableCount: 3,
    });
  });

  it('?discovery=full and a ?tools= selection preview as FULL', async () => {
    const full = await preview().preview(ORG, `${HOST}/?discovery=full`, AGENT);
    expect(full).toMatchObject({ discovery: 'FULL', listedCount: 3 });
    const picked = await preview().preview(ORG, `${HOST}/?tools=get_weather,geocode_place`, AGENT);
    expect(picked).toMatchObject({
      discovery: 'FULL',
      listedTools: ['get_weather', 'geocode_place'],
    });
  });

  it('Servers in use counts only FULL servers toward the budget, and offers each a search URL', async () => {
    const { servers } = await preview().serversInUse(ORG, AGENT);
    expect(
      servers.map((server) => [server.canonicalUrl, server.discovery, server.searchUrl]),
    ).toEqual([
      [`${HOST}/`, 'SEARCH', null],
      [`${HOST}/?discovery=full`, 'FULL', `${HOST}/`],
      [
        `${HOST}/?tools=geocode_place,get_weather`,
        'FULL',
        `${HOST}/?tools=geocode_place,get_weather&discovery=search`,
      ],
    ]);
  });
});
