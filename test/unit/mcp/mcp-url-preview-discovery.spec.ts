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

function preview(overrides: Record<string, Record<string, unknown>> = {}): McpUrlPreviewService {
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
            ...overrides[id],
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
      updateFor: async (_org: string, parsed: { filter: { discovery?: string | null } }) =>
        parsed.filter.discovery === 'full'
          ? { latestVersion: 4, latestUrl: `${HOST}/my/kit@4` }
          : null,
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

  it('Servers in use fills latestVersion and latestUrl only with an update available', async () => {
    const { servers } = await preview().serversInUse(ORG, AGENT);
    expect(
      servers.map((server) => [server.updateAvailable, server.latestVersion, server.latestUrl]),
    ).toEqual([
      [false, null, null],
      [true, 4, `${HOST}/my/kit@4`],
      [false, null, null],
    ]);
  });
});

describe('the Connect preview — why a tool cannot run for this agent (review 2026-10-18 F-P1)', () => {
  offerSolanaRailsInThisSuite('A', 'B');
  // The agent pays on CHAIN_ID (Solana devnet here); this provider settles only on EVM.
  const OTHER_CHAIN = 'eip155:46630';

  it('names the rules, and a paid tool none of whose providers settles on the agent chain', async () => {
    const result = await preview({
      // Rule-emptied: no price, and the rules' rejections.
      'tool-geocode_place': {
        price: null,
        cheapestPrice: null,
        pricingMode: null,
        routableBindings: 0,
        settlementChains: [],
        unroutableReason: '1 EXCLUDED_BY_AGENT',
        ruleRejections: [
          { providerId: 'p1', reason: 'EXCLUDED_BY_AGENT', source: 'AGENT', detail: '' },
        ],
      },
      // Priced (every enabled chain counts), but only on a chain this agent does not pay on.
      'tool-get_token_market': { settlementChains: [OTHER_CHAIN] },
    }).preview(ORG, `${HOST}/?discovery=full`, AGENT);
    const reasons = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.noFitReason]));
    expect(reasons).toEqual({
      get_weather: null,
      geocode_place: 'RULES',
      get_token_market: 'OTHER_CHAIN',
    });
    // Display only: the chain-gated tool keeps its price and provider count.
    const market = result.tools.find((tool) => tool.name === 'get_token_market')!;
    expect(market).toMatchObject({ providerCount: 1, noProviderFits: false });
  });

  it('never flags a FREE tool for the chain: free calls do not pay on any chain', async () => {
    const result = await preview({
      'tool-get_token_market': { pricingMode: PricingMode.FREE, settlementChains: [OTHER_CHAIN] },
    }).preview(ORG, `${HOST}/?discovery=full`, AGENT);
    expect(result.tools.find((tool) => tool.name === 'get_token_market')!.noFitReason).toBeNull();
  });
});
