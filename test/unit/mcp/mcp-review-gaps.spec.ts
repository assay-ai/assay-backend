import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import {
  isLocalDeployment,
  loadMcpDiscoveryConfig,
} from '@modules/mcp/config/mcp-discovery.config';
import { X402_ERROR } from '@modules/mcp/constants/mcp.constants';
import { SearchCursorCodec } from '@modules/mcp/domain/search-cursor';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { McpCallRecorder } from '@modules/mcp/services/mcp-call-recorder.service';
import { MCP_RATE_LIMITS, McpRateLimiter } from '@modules/mcp/services/mcp-rate-limiter.service';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { loadToolCatalogue } from '@modules/tool/services/catalogue-seed';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { ToolVisibility } from '@modules/tool/ports/tool.types';
import { RefusalLayer, attributionOf } from '@modules/toolset/domain/attribution';
import { ALLOW_ALL, AccessMode, ResolvedAccess, buildGrant } from '@modules/toolset/domain/access';
import { EndpointKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { McpEndpointView, selectViewTools } from '@modules/toolset/domain/view';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import {
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildTool,
  ok,
} from '../tool/helpers/routing-fixtures';
import { SESSION, buildMcpHarness } from './helpers/mcp-harness';

const TOOL_NAME = 'Search the web';
const ARGS = { query: 'moon landing' };
const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };

function rootView(query = ''): McpEndpointView {
  const parsed = parseMcpUrl(`/${query}`)!;
  return {
    canonicalUrl: `https://mcp.example.com/${query}`,
    path: parsed.path,
    kind: EndpointKind.ROOT,
    filter: parsed.filter,
    toolset: null,
    handle: null,
    baseToolIds: null,
    entryRules: new Map(),
  };
}

function scopeOf(view: McpEndpointView, over: Partial<ResolvedAccess> = {}): McpScope {
  return {
    view,
    access: {
      agentId: SESSION.agentId,
      agent: ALLOW_ALL,
      key: null,
      rules: null,
      pinnedTools: [],
      policyVersion: 1,
      ...over,
    },
    attribution: attributionOf(view),
  };
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

async function connect(scope: McpScope) {
  const h = buildMcpHarness({
    bindings: [buildBinding('p1')],
    providers: [buildProvider('p1')],
    invoker: new ScriptedInvoker({ 'binding-p1': async () => ok() }),
  });
  const writes: Array<Record<string, unknown>> = [];
  const firstCalls: string[] = [];
  const rate = limiter();
  const recorder = new McpCallRecorder(
    {
      writeRefusal: async (input: Record<string, unknown>) => writes.push(input),
    } as unknown as ToolCallRecordWriter,
    {
      markFirstCall: async (_org: string, _agent: string, url: string) => firstCalls.push(url),
    } as never,
    HOST,
    undefined,
    undefined,
    rate,
  );
  const servers = new McpServerFactory(h.catalogue, h.calls, recorder, rate);
  const server = servers.create(SESSION, scope);
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...h, client, writes, firstCalls };
}

const callTool = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'call_tool', arguments: args }) as Promise<CallToolResult>;
const codeOf = (result: CallToolResult) => (result._meta?.[X402_ERROR] as { code: string }).code;

describe('call_tool refusals go through the refused-call pipeline', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('an inner refusal writes the refused-call row, attributed, under the inner name', async () => {
    const restricted = buildGrant(AccessMode.RESTRICTED, [], [], () => []);
    const { client, writes, firstCalls } = await connect(
      scopeOf(rootView(), { agent: restricted }),
    );
    const result = await callTool(client, { name: TOOL_NAME, arguments: ARGS });
    expect(codeOf(result)).toBe(ToolAccessErrorCode.TOOL_NOT_ALLOWED);
    expect(writes).toEqual([
      expect.objectContaining({
        refusalCode: 'TOOL_NOT_ALLOWED',
        refusalLayer: RefusalLayer.AGENT_LIMITS,
        toolId: TOOL_ID,
        toolName: TOOL_NAME,
        attribution: expect.objectContaining({ endpointKind: 'ROOT' }),
      }),
    ]);
    // The first-call stamp too, matched by the URL's canonical form.
    expect(firstCalls).toEqual(['https://mcp.example.com/']);
  });

  it('a meta tool as the inner call is a recorded TOOL_NOT_IN_TOOLSET under that name', async () => {
    const { client, writes } = await connect(scopeOf(rootView()));
    expect(codeOf(await callTool(client, { name: 'search_tools', arguments: {} }))).toBe(
      ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET,
    );
    expect(writes).toEqual([
      expect.objectContaining({ refusalCode: 'TOOL_NOT_IN_TOOLSET', toolName: 'search_tools' }),
    ]);
  });

  it('a served call through call_tool stamps the first call', async () => {
    const { client, firstCalls } = await connect(scopeOf(rootView()));
    expect((await callTool(client, { name: TOOL_NAME, arguments: ARGS })).isError).toBeFalsy();
    expect(firstCalls).toEqual(['https://mcp.example.com/']);
  });

  it(`its refusals count toward the ${MCP_RATE_LIMITS.refusalsPerMinute}-a-minute limit, for itself and for tools/call`, async () => {
    const { client } = await connect(scopeOf(rootView()));
    for (let n = 0; n < MCP_RATE_LIMITS.refusalsPerMinute; n += 1) {
      await callTool(client, { name: 'get_tool', arguments: {} });
    }
    // call_tool's own malformed request is now behind the limit as well.
    const ownFailure = await callTool(client, { arguments: ARGS });
    expect(codeOf(ownFailure)).toBe(ToolAccessErrorCode.RATE_LIMITED);
    const direct = (await client.callTool({ name: TOOL_NAME, arguments: ARGS })) as CallToolResult;
    expect(codeOf(direct)).toBe(ToolAccessErrorCode.RATE_LIMITED);
  });

  it('refuses arguments that are not an object', async () => {
    const { client, ledger, intents } = await connect(scopeOf(rootView()));
    const result = await callTool(client, { name: TOOL_NAME, arguments: 'nope' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result._meta)).toContain('/arguments');
    expect(ledger.events).toHaveLength(0);
    expect(intents.rows.size).toBe(0);
  });
});

describe('the meta tool names are reserved', () => {
  it.each(['search_tools', 'get_tool', 'call_tool'])('a catalogue cannot hold "%s"', (name) => {
    expect(() => new InMemoryToolCatalogue({ tools: [buildTool({ name })], bindings: [] })).toThrow(
      /reserved/,
    );
    const seed = JSON.stringify({
      tools: [{ ...buildTool({ name }), category: 'misc' }],
      bindings: [],
    });
    expect(() => loadToolCatalogue(undefined, seed)).toThrow(/reserved/);
  });

  it('the tools upsert refuses one before writing anything', async () => {
    const query = jest.fn();
    const repository = Object.assign(Object.create(ToolRepository.prototype), { query });
    await expect(
      repository.upsertSeeded([{ id: TOOL_ID, name: 'call_tool', category: 'misc', tags: [] }]),
    ).rejects.toThrow(/reserved/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('search cursors at the limits', () => {
  const codec = new SearchCursorCodec('c'.repeat(40));
  const binding = { credentialId: 'cred-1', canonicalUrl: 'https://mcp.example.com/' };

  it.each([
    ['500 quotes (each escaped)', '"'.repeat(500)],
    ['500 backslashes', '\\'.repeat(500)],
    ['500 three-byte characters', '語'.repeat(500)],
    ['250 astral characters', '😀'.repeat(250)],
  ])('a maximal query of %s gives a cursor that reads back', (_, query) => {
    const position = {
      request: { query, category: 'c'.repeat(64), detail: 'full' as const, limit: 50 },
      offset: 0,
      page: 1,
      startedAt: 1_000,
    };
    const cursor = codec.next(binding, position, 50)!;
    expect(codec.read(cursor, binding, 2_000)).toMatchObject({ request: position.request });
  });
});

describe('the cursor secret outside a local run', () => {
  it('is required on a shared development host, and optional locally', () => {
    expect(() =>
      loadMcpDiscoveryConfig({
        NODE_ENV: 'development',
        MCP_PUBLIC_URL: 'https://mcp.dev.example.com',
      }),
    ).toThrow(/MCP_SEARCH_CURSOR_SECRET/);
    expect(isLocalDeployment({ NODE_ENV: 'development' })).toBe(true);
    expect(
      isLocalDeployment({ NODE_ENV: 'development', MCP_PUBLIC_URL: 'http://localhost:3200' }),
    ).toBe(true);
    expect(
      isLocalDeployment({ NODE_ENV: 'development', MCP_PUBLIC_URL: 'http://[::1]:3200' }),
    ).toBe(true);
    expect(
      isLocalDeployment({ NODE_ENV: 'local', MCP_PUBLIC_URL: 'https://mcp.example.com' }),
    ).toBe(true);
    expect(isLocalDeployment({ NODE_ENV: 'test' })).toBe(true);
    expect(
      isLocalDeployment({ NODE_ENV: 'production', MCP_PUBLIC_URL: 'http://localhost:3200' }),
    ).toBe(false);
    expect(isLocalDeployment({ NODE_ENV: 'staging', MCP_PUBLIC_URL: 'not a url' })).toBe(false);
  });
});

describe('no existence oracles', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('ignoredTools names a ?tools= tool the caller may not use, like one that does not exist', async () => {
    const restricted = buildGrant(AccessMode.RESTRICTED, [], [], () => []);
    const h = buildMcpHarness({
      bindings: [buildBinding('p1')],
      providers: [buildProvider('p1')],
      invoker: new ScriptedInvoker({ 'binding-p1': async () => ok() }),
      tool: buildTool({ name: 'search_web' }),
    });
    const scope = scopeOf(rootView('?tools=nope_tool,search_web'), { agent: restricted });
    expect(await h.catalogue.ignoredTools(scope)).toEqual(['nope_tool', 'search_web']);
    expect(
      await h.catalogue.ignoredTools(scopeOf(rootView('?tools=nope_tool,search_web'))),
    ).toEqual(['nope_tool']);
  });

  it('catalogue-wide views and /c/{category} see only LISTED tools', async () => {
    const listed = buildTool({ id: 't1', name: 'get_weather', category: 'weather' });
    const unlisted = buildTool({
      id: 't2',
      name: 'acme_tweets',
      category: 'social',
      visibility: ToolVisibility.UNLISTED,
    });
    const view = rootView();
    expect(selectViewTools(view, [listed, unlisted]).tools.map((t) => t.id)).toEqual(['t1']);
    // A toolset that holds it by id serves it only where §7.6 lets it reach:
    // nowhere for a tool that is not a provider's own (T4).
    expect(
      selectViewTools({ ...view, baseToolIds: ['t2'] }, [listed, unlisted]).tools.map((t) => t.id),
    ).toEqual([]);

    const resolver = new McpEndpointResolver(
      {} as never,
      {} as never,
      { current: async () => '1' } as never,
      HOST,
      {} as never,
      {} as never,
      { listTools: async () => [listed, unlisted] } as never,
    );
    await expect(resolver.resolve('org', parseMcpUrl('/c/social')!)).rejects.toMatchObject({
      errorCode: 'MCP_URL_NOT_FOUND',
    });
    await expect(resolver.resolve('org', parseMcpUrl('/c/weather')!)).resolves.toMatchObject({
      baseCategory: 'weather',
    });
  });
});
