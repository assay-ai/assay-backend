import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import { ASSAY_ERROR, ASSAY_PRICE } from '@modules/mcp/constants/mcp.constants';
import { SEARCH_RESPONSE_MAX_BYTES } from '@modules/mcp/domain/discovery';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { McpCatalogueService, reviewNote } from '@modules/mcp/services/mcp-catalogue.service';
import { McpDiscoveryService } from '@modules/mcp/services/mcp-discovery.service';
import { MCP_RATE_LIMITS, McpRateLimiter } from '@modules/mcp/services/mcp-rate-limiter.service';
import { McpServerFactory, errorResult } from '@modules/mcp/services/mcp-server.factory';
import { McpToolCallService } from '@modules/mcp/services/mcp-tool-call.service';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import {
  PricingMode,
  Tool,
  ToolKind,
  ToolTier,
  ToolVisibility,
} from '@modules/tool/ports/tool.types';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { ToolQuote } from '@modules/tool/services/provider-router.service';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { ALLOW_ALL, AccessMode, ResolvedAccess, buildGrant } from '@modules/toolset/domain/access';
import {
  DiscoveryMode,
  EndpointKind,
  McpPathKind,
  parseMcpUrl,
} from '@modules/toolset/domain/mcp-url';
import { McpEndpointView, ViewDiscovery } from '@modules/toolset/domain/view';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import { usdc } from '../tool/helpers/routing-fixtures';
import { CHAIN_ID, SESSION } from './helpers/mcp-harness';

const SECRET = 'meta-tools-test-secret-0123456789abcdef';
const TOOLSET_ID = '0b9a7f7e-2d55-4c1e-9a52-6f0c3f9d1e01';

function tool(
  name: string,
  category: string,
  tags: string[],
  description: string,
  argument = 'query',
): Tool {
  return {
    id: `tool-${name}`,
    name,
    description,
    category,
    tags,
    inputSchema: {
      type: 'object',
      properties: { [argument]: { type: 'string', description: `The ${argument}.` } },
      required: [argument],
    },
    outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
  };
}

const CATALOGUE: Tool[] = [
  tool('get_weather', 'weather', ['temperature'], 'Current temperature at a point.', 'latitude'),
  tool('get_forecast', 'weather', ['rain'], 'Rain and temperature for the next days.', 'latitude'),
  tool('geocode_place', 'maps', ['coordinates'], 'Resolve a place name to coordinates.', 'place'),
  tool('get_token_market', 'crypto', ['token', 'price'], 'Token price and market cap.', 'symbol'),
  tool('get_usd_eur_rate', 'finance', ['currency'], 'The latest USD to EUR exchange rate.'),
  tool('search_wikipedia', 'knowledge', ['encyclopedia'], 'Search Wikipedia articles.'),
];
const FREEMIUM = 'get_usd_eur_rate';
/**
 * Served by two providers, $0.01 and $0.05, with a third at $0.10 that was at
 * its ceiling when the listing was priced: the listed price is the dearest that
 * can serve now, `maxAmount` the dearest a live call could be offered. A
 * `maxAmount` taken from the cheapest, or from the listed price, fails here.
 */
const MULTI = 'get_forecast';

function quoteOf(t: Tool): ToolQuote {
  const freemium = t.name === FREEMIUM;
  const multi = t.name === MULTI;
  return {
    tool: t,
    price: multi ? usdc('0.05') : usdc('0.01'),
    cheapestPrice: usdc('0.01'),
    maxPrice: multi ? usdc('0.10') : usdc('0.01'),
    pricingMode: freemium ? PricingMode.FREEMIUM : PricingMode.PAID,
    routableBindings: multi ? 2 : 1,
    paidBindings: multi ? 2 : 1,
    freeBindings: [],
    settlementChains: [CHAIN_ID],
    p95LatencyMs: null,
    qualityRate: null,
    unroutableReason: null,
  } as ToolQuote;
}

function catalogueOf(tools: Tool[]): McpCatalogueService {
  const quotes = {
    quoteMany: async (ids: readonly string[]) =>
      new Map(
        ids.map((id) => {
          const t = tools.find((candidate) => candidate.id === id)!;
          return [id, quoteOf(t)];
        }),
      ),
  } as unknown as QuoteIndexService;
  const freeQuota = {
    remainingForTool: async () => ({ remaining: 7, limit: 10, resetsAt: new Date(0) }),
    dailyAllowance: () => 10,
  } as unknown as FreeQuotaService;
  return new McpCatalogueService(
    new InMemoryToolCatalogue({ tools, bindings: [] }),
    undefined as never,
    freeQuota,
    [CHAIN_ID],
    quotes,
  );
}

function limiter() {
  const counters = new Map<string, number>();
  const redis = {
    incr: async (key: string) => {
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return counters.get(key);
    },
    pexpire: async () => 1,
    get: async (key: string) => (counters.has(key) ? String(counters.get(key)) : null),
  };
  return new McpRateLimiter({ getRedisClient: () => redis } as unknown as CacheService, () => 0);
}

function view(url: string, over: Partial<McpEndpointView> = {}): McpEndpointView {
  const parsed = parseMcpUrl(url)!;
  return {
    canonicalUrl: `https://mcp.example.com${url}`,
    path: parsed.path,
    kind: EndpointKind.ROOT,
    filter: parsed.filter,
    toolset: null,
    handle: null,
    baseToolIds: null,
    entryRules: new Map(),
    ...over,
  };
}

function toolsetView(toolIds: string[], discovery: ViewDiscovery): McpEndpointView {
  return view('/my/kit', {
    path: { kind: McpPathKind.MY_TOOLSET, slug: 'kit', version: null },
    kind: EndpointKind.TOOLSET,
    toolset: { id: TOOLSET_ID, slug: 'kit', name: 'Kit', version: null, latest: false },
    baseToolIds: toolIds,
    discovery,
  });
}

function scopeOf(v: McpEndpointView, over: Partial<ResolvedAccess> = {}): McpScope {
  const access: ResolvedAccess = {
    agentId: SESSION.agentId,
    agent: ALLOW_ALL,
    key: null,
    rules: null,
    pinnedTools: [],
    policyVersion: 1,
    ...over,
  };
  return { view: v, access, attribution: attributionOf(v) };
}

interface Connected {
  readonly client: Client;
  readonly now: { value: number };
}

async function connect(
  scope: McpScope,
  options: { tools?: Tool[]; session?: typeof SESSION; rate?: McpRateLimiter } = {},
): Promise<Connected> {
  const catalogue = catalogueOf(options.tools ?? CATALOGUE);
  const now = { value: Date.UTC(2026, 9, 17, 12) };
  const discovery = new McpDiscoveryService(
    catalogue,
    options.rate,
    { cursorSecret: SECRET },
    () => now.value,
  );
  const servers = new McpServerFactory(
    catalogue,
    {} as McpToolCallService,
    undefined,
    options.rate,
    discovery,
  );
  const server = servers.create(options.session ?? SESSION, scope);
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, now };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function output<T = Record<string, any>>(result: CallToolResult): T {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as T;
}

function errorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return (result._meta?.[ASSAY_ERROR] as { code: string }).code;
}

describe('discovery modes over MCP (design spec §7.4)', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('the root lists the three meta tools in SEARCH mode, not the catalogue', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['search_tools', 'get_tool', 'call_tool']);
    expect(tools[0].description).toContain('Search the 6 tools');
    expect(tools[0].description).toContain('Categories: crypto, finance, knowledge');
    expect(tools[2].outputSchema).toBeUndefined();
  });

  it('?discovery=full on the root lists every tool in view ∩ access', async () => {
    const { client } = await connect(scopeOf(view('/?discovery=full')));
    expect((await client.listTools()).tools).toHaveLength(CATALOGUE.length);
  });

  it('pinned tools are listed directly in SEARCH: the URL pins, then the agent pins, at most 5', async () => {
    const v = view('/', {
      discovery: {
        mode: DiscoveryMode.SEARCH,
        searchThreshold: 25,
        pinnedTools: ['get_weather', 'not_a_tool'],
      },
    });
    const { client } = await connect(
      scopeOf(v, {
        pinnedTools: [
          'geocode_place',
          'get_weather',
          'get_forecast',
          'get_token_market',
          'search_wikipedia',
          'get_usd_eur_rate',
        ],
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([
      'get_weather',
      'geocode_place',
      'get_forecast',
      'get_token_market',
      'search_wikipedia',
      'search_tools',
      'get_tool',
      'call_tool',
    ]);
  });

  it('a pinned tool outside access is not listed', async () => {
    const onlyWeather = buildGrant(AccessMode.RESTRICTED, ['tool-get_weather'], [], () => []);
    const { client } = await connect(
      scopeOf(view('/'), { agent: onlyWeather, pinnedTools: ['geocode_place', 'get_weather'] }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['get_weather', 'search_tools', 'get_tool', 'call_tool']);
  });

  it('AUTO lists FULL up to the threshold and SEARCH above it, counted on view ∩ access', async () => {
    const ids = CATALOGUE.map((t) => t.id);
    const auto = (threshold: number) =>
      toolsetView(ids, { mode: DiscoveryMode.AUTO, searchThreshold: threshold, pinnedTools: [] });

    const full = await connect(scopeOf(auto(6)));
    expect((await full.client.listTools()).tools).toHaveLength(6);

    const search = await connect(scopeOf(auto(5)));
    expect((await search.client.listTools()).tools.map((t) => t.name)).toEqual([
      'search_tools',
      'get_tool',
      'call_tool',
    ]);

    // Access narrows view ∩ access to 2, under the threshold of 5: FULL again.
    const two = buildGrant(
      AccessMode.RESTRICTED,
      ['tool-get_weather', 'tool-geocode_place'],
      [],
      () => [],
    );
    const narrowed = await connect(scopeOf(auto(5), { agent: two }));
    expect((await narrowed.client.listTools()).tools.map((t) => t.name)).toEqual([
      'get_weather',
      'geocode_place',
    ]);
  });

  it('the meta tools still answer on a FULL URL (a cached SEARCH list keeps working)', async () => {
    const { client } = await connect(scopeOf(view('/?discovery=full')));
    const found = output(await call(client, 'search_tools', { query: 'weather' }));
    expect(found.results.length).toBeGreaterThan(0);
  });
});

describe('search_tools', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('ranks by BM25 within the view and returns the spec output', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const found = output(await call(client, 'search_tools', { query: 'token price' }));
    expect(found.results[0]).toMatchObject({
      name: 'get_token_market',
      summary: 'Token price and market cap.',
      kind: 'STANDARD',
      price: '$0.01',
      freeCallsLeftToday: null,
    });
    expect(found.results[0].score).toBeGreaterThan(0);
    expect(found.results[0].inputSchema).toBeUndefined();
    expect(found).toMatchObject({ limitApplied: 5, nextCursor: null });
    expect(found.categories).toEqual(['crypto', 'finance', 'knowledge', 'maps', 'weather']);
    expect(found.total).toBe(found.results.length);
  });

  it('matches argument names, tags and category', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const byArg = output(
      await call(client, 'search_tools', { query: 'latitude', detail: 'names' }),
    );
    expect(byArg.results.map((r: { name: string }) => r.name).sort()).toEqual([
      'get_forecast',
      'get_weather',
    ]);
    const byTag = output(await call(client, 'search_tools', { query: 'encyclopedia' }));
    expect(byTag.results[0].name).toBe('search_wikipedia');
    const byCategory = output(await call(client, 'search_tools', { query: 'maps' }));
    expect(byCategory.results[0].name).toBe('geocode_place');
  });

  it('carries the whole assay/price object beside the display price, as get_tool does (G3)', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const found = output(await call(client, 'search_tools', { query: 'token price' }));
    expect(found.results[0]).toMatchObject({
      name: 'get_token_market',
      price: '$0.01',
      assayPrice: {
        amount: '10000',
        maxAmount: '10000',
        asset: usdc('0.01').asset,
        display: '$0.01',
      },
    });
    const described = output(await call(client, 'get_tool', { name: 'get_token_market' }));
    expect(found.results[0].assayPrice).toEqual(described.price);
  });

  it('a multi-provider tool: maxAmount is the dearest a call could be offered, not the cheapest', async () => {
    const { client } = await connect(scopeOf(view('/')));
    for (const detail of ['summary', 'full']) {
      const found = output(await call(client, 'search_tools', { query: 'rain', detail }));
      expect(found.results[0]).toMatchObject({
        name: MULTI,
        price: 'up to $0.05',
        assayPrice: { amount: '50000', maxAmount: '100000', asset: usdc('0.01').asset },
      });
    }
    const names = output(await call(client, 'search_tools', { query: 'rain', detail: 'names' }));
    expect(names.results[0].assayPrice).toBeUndefined();
  });

  it('reports this agent’s free calls left on a FREEMIUM tool', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const found = output(await call(client, 'search_tools', { query: 'exchange rate' }));
    expect(found.results[0]).toMatchObject({ name: FREEMIUM, freeCallsLeftToday: 7 });
  });

  it('detail: names is name and score only; full adds the input schema', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const names = output(await call(client, 'search_tools', { query: 'weather', detail: 'names' }));
    expect(Object.keys(names.results[0]).sort()).toEqual(['name', 'score']);
    expect(names.limitApplied).toBe(10);
    const full = output(await call(client, 'search_tools', { query: 'weather', detail: 'full' }));
    expect(full.results[0].inputSchema).toMatchObject({ type: 'object' });
    expect(full.limitApplied).toBe(3);
  });

  it('limit: above 50 is lowered to 50, below 1 is the default', async () => {
    const { client } = await connect(scopeOf(view('/')));
    expect(
      output(await call(client, 'search_tools', { query: 'a', limit: 500 })).limitApplied,
    ).toBe(50);
    expect(output(await call(client, 'search_tools', { query: 'a', limit: 0 })).limitApplied).toBe(
      5,
    );
  });

  it('no match is an empty list with the categories, not an error', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const found = output(await call(client, 'search_tools', { query: 'zebra' }));
    expect(found).toMatchObject({ results: [], total: 0, nextCursor: null });
    expect(found.categories).toHaveLength(5);
  });

  it('category narrows the search; an empty query browses it', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const found = output(await call(client, 'search_tools', { query: '', category: 'weather' }));
    expect(found.results.map((r: { name: string }) => r.name)).toEqual([
      'get_forecast',
      'get_weather',
    ]);
  });

  it('never reaches a tool outside access, or another URL’s view', async () => {
    const onlyMaps = buildGrant(AccessMode.RESTRICTED, ['tool-geocode_place'], [], () => []);
    const restricted = await connect(scopeOf(view('/'), { agent: onlyMaps }));
    const found = output(
      await call(restricted.client, 'search_tools', {
        query: 'weather temperature',
        detail: 'names',
      }),
    );
    expect(found.results).toEqual([]);
    expect(found.categories).toEqual(['maps']);

    const viaUrl = buildGrant(
      AccessMode.RESTRICTED,
      [],
      [{ toolsetId: TOOLSET_ID, version: null, viaUrlOnly: true }],
      () => ['tool-get_weather'],
    );
    const root = await connect(scopeOf(view('/'), { agent: viaUrl }));
    expect(output(await call(root.client, 'search_tools', { query: 'weather' })).total).toBe(0);

    const kit = await connect(
      scopeOf(
        toolsetView(['tool-get_weather'], {
          mode: DiscoveryMode.SEARCH,
          searchThreshold: 25,
          pinnedTools: [],
        }),
        { agent: viaUrl },
      ),
    );
    expect(output(await call(kit.client, 'search_tools', { query: 'weather' })).total).toBe(1);

    const keyNarrowed = await connect(
      scopeOf(view('/'), { key: buildGrant(AccessMode.RESTRICTED, [], [], () => []) }),
    );
    expect(output(await call(keyNarrowed.client, 'search_tools', { query: 'weather' })).total).toBe(
      0,
    );

    const filtered = await connect(scopeOf(view('/?category=maps&discovery=search')));
    expect(output(await call(filtered.client, 'search_tools', { query: 'weather' })).total).toBe(0);
  });

  it('pages with a cursor: same search, next offset, then null at the end', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const first = output(
      await call(client, 'search_tools', { query: '', detail: 'names', limit: 4 }),
    );
    expect(first.results).toHaveLength(4);
    expect(first.total).toBe(6);
    expect(typeof first.nextCursor).toBe('string');

    const second = output(await call(client, 'search_tools', { cursor: first.nextCursor }));
    expect(second.results.map((r: { name: string }) => r.name)).toEqual([
      'get_weather',
      'search_wikipedia',
    ]);
    expect(second.limitApplied).toBe(4);
    expect(second.nextCursor).toBeNull();
  });

  it('stops issuing cursors after 10 pages', async () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      tool(`tool_${String(n).padStart(2, '0')}`, 'misc', [], 'Misc.'),
    );
    const { client } = await connect(scopeOf(view('/')), { tools: many });
    let page = output(await call(client, 'search_tools', { query: '', detail: 'names', limit: 1 }));
    let pages = 1;
    while (page.nextCursor) {
      page = output(await call(client, 'search_tools', { cursor: page.nextCursor }));
      pages += 1;
    }
    expect(pages).toBe(10);
  });

  it('INVALID_CURSOR for a tampered, expired, or another key’s cursor', async () => {
    const { client, now } = await connect(scopeOf(view('/')));
    const first = output(
      await call(client, 'search_tools', { query: '', detail: 'names', limit: 2 }),
    );
    const cursor = first.nextCursor as string;

    expect(errorCode(await call(client, 'search_tools', { cursor: `${cursor}x` }))).toBe(
      ToolAccessErrorCode.INVALID_CURSOR,
    );
    const invalid = await call(client, 'search_tools', { cursor: 'garbage' });
    expect(invalid.content).toEqual([{ type: 'text', text: 'This search expired. Search again.' }]);

    const other = await connect(scopeOf(view('/')), {
      session: { ...SESSION, credentialId: 'another-credential' },
    });
    expect(errorCode(await call(other.client, 'search_tools', { cursor }))).toBe(
      ToolAccessErrorCode.INVALID_CURSOR,
    );

    now.value += 10 * 60_000 + 1;
    expect(errorCode(await call(client, 'search_tools', { cursor }))).toBe(
      ToolAccessErrorCode.INVALID_CURSOR,
    );
  });

  it('a cursor never outlives access: the next page is scoped again', async () => {
    const catalogueScope = scopeOf(view('/'));
    const { client } = await connect(catalogueScope);
    const first = output(
      await call(client, 'search_tools', { query: '', detail: 'names', limit: 2 }),
    );
    // Same credential and URL, access since narrowed to nothing.
    const narrowed = await connect(
      scopeOf(view('/'), { agent: buildGrant(AccessMode.RESTRICTED, [], [], () => []) }),
    );
    const next = output(await call(narrowed.client, 'search_tools', { cursor: first.nextCursor }));
    expect(next).toMatchObject({ results: [], total: 0, nextCursor: null });
  });

  it('caps one response at 256 KB, returning fewer results with a cursor', async () => {
    const huge = Array.from({ length: 8 }, (_, n) => {
      const t = tool(`big_${n}`, 'misc', [], 'Big.');
      return {
        ...t,
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'x'.repeat(60_000) } },
        },
      } as Tool;
    });
    const { client } = await connect(scopeOf(view('/')), { tools: huge });
    const result = await call(client, 'search_tools', { query: 'big', detail: 'full', limit: 8 });
    const found = output(result);
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.length).toBeLessThan(8);
    expect(found.nextCursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      SEARCH_RESPONSE_MAX_BYTES,
    );
  });

  it('holds the 256 KB cap with a single huge full result: the schema is dropped, get_tool has it', async () => {
    const giant = {
      ...tool('giant_tool', 'misc', [], 'Giant.'),
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'x'.repeat(400_000) } },
      },
    } as Tool;
    const { client } = await connect(scopeOf(view('/')), { tools: [giant] });
    const result = await call(client, 'search_tools', { query: 'giant', detail: 'full', limit: 1 });
    const found = output(result);
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({
      name: 'giant_tool',
      inputSchemaOmitted: true,
      note: expect.stringContaining('get_tool'),
    });
    expect(found.results[0].inputSchema).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      SEARCH_RESPONSE_MAX_BYTES,
    );
  });

  it('a maximal query pages: control characters become spaces and the cursor reads back', async () => {
    const many = Array.from({ length: 3 }, (_, n) => tool(`misc_${n}`, 'misc', [], 'Misc.'));
    const { client } = await connect(scopeOf(view('/')), { tools: many });
    for (const filler of ['\u0001', '"', '\\', '語']) {
      const query = `misc ${filler.repeat(495)}`;
      const first = output(
        await call(client, 'search_tools', { query, detail: 'names', limit: 1 }),
      );
      expect(first.total).toBe(3);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = output(await call(client, 'search_tools', { cursor: first.nextCursor }));
      expect(second.results).toHaveLength(1);
    }
    expect(
      errorCode(
        await call(client, 'search_tools', { query: 'q'.repeat(400) + '\u0001'.repeat(101) }),
      ),
    ).toBe('TOOL_ARGUMENTS_INVALID');
  });

  it('refuses a query over 500 characters, and a search with neither query nor cursor', async () => {
    const { client } = await connect(scopeOf(view('/')));
    expect(errorCode(await call(client, 'search_tools', { query: 'q'.repeat(501) }))).toBe(
      'TOOL_ARGUMENTS_INVALID',
    );
    expect(errorCode(await call(client, 'search_tools', {}))).toBe('TOOL_ARGUMENTS_INVALID');
    const typed = await call(client, 'search_tools', { query: 'a', limit: 'many' });
    expect(typed.isError).toBe(true);
    expect(JSON.stringify(typed._meta)).toContain('/limit');
  });

  it(`answers RATE_LIMITED beyond ${MCP_RATE_LIMITS.searchesPerMinute} searches a minute per agent`, async () => {
    const rate = limiter();
    const { client } = await connect(scopeOf(view('/')), { rate });
    for (let n = 0; n < MCP_RATE_LIMITS.searchesPerMinute; n += 1) {
      expect((await call(client, 'search_tools', { query: 'weather' })).isError).toBeFalsy();
    }
    const limited = await call(client, 'search_tools', { query: 'weather' });
    expect(errorCode(limited)).toBe(ToolAccessErrorCode.RATE_LIMITED);
    expect((limited._meta?.[ASSAY_ERROR] as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(
      0,
    );
    // The same agent on another URL shares the limit.
    const elsewhere = await connect(scopeOf(view('/c/weather', { baseCategory: 'weather' })), {
      rate,
    });
    expect(errorCode(await call(elsewhere.client, 'search_tools', { query: 'weather' }))).toBe(
      ToolAccessErrorCode.RATE_LIMITED,
    );
  });
});

describe('get_tool', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('returns the full description, schemas, price and version of a tool in view ∩ access', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const described = output(await call(client, 'get_tool', { name: 'get_weather' }));
    expect(described).toMatchObject({
      name: 'get_weather',
      kind: 'STANDARD',
      category: 'weather',
      description: 'Current temperature at a point.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      version: '1.0.0',
      examples: [],
      price: { display: '$0.01' },
      freeCallsLeftToday: null,
    });
    expect(described.annotations[ASSAY_PRICE]).toBeDefined();
  });

  it('get_tool returns maxAmount: the most a call can be charged, in atomic units (G3)', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const described = output(await call(client, 'get_tool', { name: 'get_weather' }));
    expect(described.price).toEqual({
      amount: '10000',
      maxAmount: '10000',
      asset: usdc('0.01').asset,
      display: '$0.01',
    });
    expect(described.annotations[ASSAY_PRICE]).toEqual(described.price);

    const multi = output(await call(client, 'get_tool', { name: MULTI }));
    expect(multi.price).toEqual({
      amount: '50000',
      maxAmount: '100000',
      asset: usdc('0.01').asset,
      display: 'up to $0.05',
    });
  });

  it('answers TOOL_NOT_IN_TOOLSET alike for an unknown name, one outside access and one outside the view', async () => {
    const onlyMaps = buildGrant(AccessMode.RESTRICTED, ['tool-geocode_place'], [], () => []);
    const { client } = await connect(
      scopeOf(view('/?category=maps&discovery=search'), { agent: onlyMaps }),
    );
    const answers = await Promise.all(
      ['no_such_tool', 'get_weather', 'get_token_market'].map((name) =>
        call(client, 'get_tool', { name }),
      ),
    );
    for (const answer of answers) {
      expect(errorCode(answer)).toBe(ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET);
      expect(answer.content).toEqual([{ type: 'text', text: 'Not part of this server.' }]);
    }
    expect(output(await call(client, 'get_tool', { name: 'geocode_place' })).name).toBe(
      'geocode_place',
    );
  });

  it(`answers RATE_LIMITED beyond ${MCP_RATE_LIMITS.getToolsPerMinute} a minute per agent`, async () => {
    const rate = limiter();
    const { client } = await connect(scopeOf(view('/')), { rate });
    for (let n = 0; n < MCP_RATE_LIMITS.getToolsPerMinute; n += 1) {
      await call(client, 'get_tool', { name: 'get_weather' });
    }
    expect(errorCode(await call(client, 'get_tool', { name: 'get_weather' }))).toBe(
      ToolAccessErrorCode.RATE_LIMITED,
    );
    // Searching has its own budget.
    expect((await call(client, 'search_tools', { query: 'weather' })).isError).toBeFalsy();
  });

  it('refuses a missing name with the schema path', async () => {
    const { client } = await connect(scopeOf(view('/')));
    const refused = await call(client, 'get_tool', {});
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused._meta)).toContain('name');
  });
});

describe('contract versions in discovery (T3)', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  const sunset = new Date('2027-02-01T00:00:00Z');
  const base = tool(
    'get_weather',
    'weather',
    ['temperature'],
    'A long description. '.repeat(20),
    'latitude',
  );
  const deprecatedV1 = {
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: 'Temperature now (stored summary).',
    description: 'The full v1 documentation.',
    inputSchema: base.inputSchema,
    outputSchema: base.outputSchema,
    optionalInputFields: [],
    optionalOutputFields: ['uvIndex'],
    examples: [{ title: 'Lisbon', arguments: { latitude: 38.7 } }],
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    status: 'DEPRECATED' as never,
    sunsetAt: sunset,
    changelog: 'First version.',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const v2 = {
    ...deprecatedV1,
    version: 2,
    semver: '2.0.0',
    major: 2,
    status: 'ACTIVE' as never,
    sunsetAt: null,
    summary: 'Temperature now, v2.',
  };
  // The tool as a pinned `@1` URL's quote resolves it: at the deprecated version.
  const pinned: Tool = {
    ...base,
    description: deprecatedV1.description,
    versions: [v2, deprecatedV1],
    currentVersion: 2,
    version: deprecatedV1,
  };

  it('tools/list sends the stored summary, never the description, and marks a deprecated version', async () => {
    const { client } = await connect(scopeOf(view('/?discovery=full')), { tools: [pinned] });
    const [listed] = (await client.listTools()).tools;
    expect(listed.description?.startsWith('Temperature now (stored summary).\n\n')).toBe(true);
    expect(listed.description).not.toContain('A long description');
    expect(listed._meta?.['assay/deprecated']).toEqual({
      sunsetAt: sunset.toISOString(),
      replacement: 'get_weather@2 (v2.0.0)',
    });
  });

  it('get_tool serves the stored summary, description, examples, optional fields and version', async () => {
    const { client } = await connect(scopeOf(view('/')), { tools: [pinned] });
    expect(output(await call(client, 'get_tool', { name: 'get_weather' }))).toMatchObject({
      summary: 'Temperature now (stored summary).',
      description: 'The full v1 documentation.',
      version: '1.0.0',
      changelog: 'First version.',
      examples: [{ title: 'Lisbon', arguments: { latitude: 38.7 } }],
      optionalOutputFields: ['uvIndex'],
      'assay/deprecated': { sunsetAt: sunset.toISOString() },
    });
  });

  it('search_tools ranks on and returns the stored summary and version', async () => {
    const { client } = await connect(scopeOf(view('/')), { tools: [pinned] });
    const found = output(await call(client, 'search_tools', { query: 'stored summary' }));
    expect(found.results[0]).toMatchObject({
      name: 'get_weather',
      summary: 'Temperature now (stored summary).',
      version: '1.0.0',
    });
  });
});

/**
 * A buyer never pays for an unreviewed provider tool without being told
 * (§7.6, review P2-3): tools/list, search_tools, get_tool and the payment
 * request all say "Not reviewed".
 */
describe('"Not reviewed" wherever a provider tool is offered', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  const unreviewed: Tool = {
    ...tool('acme__search_posts', 'social', ['posts'], 'Search public posts by keyword.'),
    kind: ToolKind.PROVIDER,
    ownerOrgId: 'org-acme',
    visibility: ToolVisibility.UNLISTED,
    reviewed: false,
  };
  const ownView = () =>
    view('/my/kit', {
      path: { kind: McpPathKind.MY_TOOLSET, slug: 'kit', version: null },
      kind: EndpointKind.TOOLSET,
      toolset: {
        id: TOOLSET_ID,
        slug: 'kit',
        name: 'Kit',
        version: null,
        latest: false,
        ownerOrgId: 'org-acme',
      },
      baseToolIds: [unreviewed.id],
      discovery: { mode: DiscoveryMode.FULL, searchThreshold: 25, pinnedTools: [] },
    });

  it('tools/list ends the description with it and marks _meta', async () => {
    const { client } = await connect(scopeOf(ownView()), { tools: [...CATALOGUE, unreviewed] });
    const { tools } = await client.listTools();
    const listed = tools.find((t) => t.name === 'acme__search_posts')!;
    expect(listed.description).toMatch(/· Not reviewed$/);
    expect(listed._meta).toMatchObject({ 'assay/kind': 'PROVIDER', 'assay/notReviewed': true });
  });

  it('search_tools and get_tool carry notReviewed, at every detail level', async () => {
    const { client } = await connect(scopeOf(ownView()), { tools: [...CATALOGUE, unreviewed] });
    for (const detail of ['names', 'summary', 'full']) {
      const found = output(await call(client, 'search_tools', { query: 'posts', detail }));
      expect(found.results[0]).toMatchObject({ name: 'acme__search_posts', notReviewed: true });
    }
    expect(output(await call(client, 'get_tool', { name: 'acme__search_posts' }))).toMatchObject({
      notReviewed: true,
    });
  });

  it('a payment request says so beside the voucher, never inside it', () => {
    const result = errorResult('pay', {
      code: 'PAYMENT_REQUIRED',
      paymentRequired: { rail: 'B', seq: 1 },
      notReviewed: true,
    });
    expect(result._meta).toEqual({
      [ASSAY_ERROR]: { code: 'PAYMENT_REQUIRED' },
      'x402/paymentRequired': { rail: 'B', seq: 1 },
      'assay/notReviewed': true,
    });
    // A reviewed tool's request carries no flag.
    expect(
      errorResult('pay', { code: 'PAYMENT_REQUIRED', paymentRequired: { rail: 'B' } })._meta,
    ).not.toHaveProperty('assay/notReviewed');
  });

  it('a standard tool carries none of it', async () => {
    const { client } = await connect(scopeOf(view('/?discovery=full')));
    const { tools } = await client.listTools();
    expect(tools.every((t) => !String(t.description).includes('Not reviewed'))).toBe(true);
    expect(reviewNote(CATALOGUE[0])).toBe('');
    expect(reviewNote(unreviewed)).toBe(' · Not reviewed');
  });
});
