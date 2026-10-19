import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { FreeQuotaLimitKind } from '@modules/free-tier/services/free-quota.service';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { X402_ERROR, X402_PRICE, X402_RECEIPT } from '@modules/mcp/constants/mcp.constants';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { ASSAY_NO_PROVIDER_FITS } from '@modules/mcp/services/mcp-catalogue.service';
import { McpCallRecorder } from '@modules/mcp/services/mcp-call-recorder.service';
import { MCP_RATE_LIMITS, McpRateLimiter } from '@modules/mcp/services/mcp-rate-limiter.service';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import {
  ASSAY_IGNORED_TOOLS,
  MCP_RATE_LIMITED_ERROR_CODE,
  McpServerFactory,
} from '@modules/mcp/services/mcp-server.factory';
import { ProviderTier } from '@modules/provider/ports/provider.types';
import { OnEmpty, ProviderMode, RoutingRules } from '@modules/tool/domain/routing';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { RefusalLayer, attributionOf } from '@modules/toolset/domain/attribution';
import { ALLOW_ALL, AccessMode, ResolvedAccess, buildGrant } from '@modules/toolset/domain/access';
import { EndpointKind, McpPathKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { McpEndpointView } from '@modules/toolset/domain/view';

import {
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  ok,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import { SESSION, buildMcpHarness } from './helpers/mcp-harness';

const TOOL_NAME = 'Search the web';
const ARGS = { query: 'Paris' };
const TOOLSET_ID = '0b9a7f7e-2d55-4c1e-9a52-6f0c3f9d1e01';

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
    notice: null,
  };
}

function toolsetView(toolIds: string[], entry: RoutingRules['entry'] = null): McpEndpointView {
  const parsed = parseMcpUrl('/my/research')!;
  return {
    canonicalUrl: 'https://mcp.example.com/my/research',
    path: { kind: McpPathKind.MY_TOOLSET, slug: 'research', version: null },
    kind: EndpointKind.TOOLSET,
    filter: parsed.filter,
    toolset: { id: TOOLSET_ID, slug: 'research', name: 'Research', version: null, latest: false },
    handle: null,
    baseToolIds: toolIds,
    entryRules: entry ? new Map([[TOOL_ID, entry]]) : new Map(),
    notice: null,
  };
}

function access(over: Partial<ResolvedAccess> = {}): ResolvedAccess {
  return {
    agentId: SESSION.agentId,
    agent: ALLOW_ALL,
    key: null,
    rules: null,
    pinnedTools: [],
    policyVersion: 1,
    ...over,
  };
}

function scopeOf(view: McpEndpointView, accessOver: Partial<ResolvedAccess> = {}): McpScope {
  return { view, access: access(accessOver), attribution: attributionOf(view) };
}

/**
 * A call through an MCP URL (design spec §7.3): the URL's view, the caller's
 * access, and the entry's and the agent's rules — checked on the server for
 * every call, refused before anything is charged.
 */
describe('a scoped MCP URL — tools/call', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  function harness() {
    const invoker = new ScriptedInvoker({
      'binding-p1': async () => ok('one'),
      'binding-p2': async () => ok('two'),
    });
    const built = buildMcpHarness({
      bindings: [buildBinding('p1'), buildBinding('p2')],
      providers: [
        buildProvider('p1', { tier: ProviderTier.TRUSTED }),
        buildProvider('p2', { tier: ProviderTier.NEW }),
      ],
      invoker,
    });
    return { ...built, invoker };
  }

  it('TOOL_NOT_IN_TOOLSET for a tool the URL does not serve, and for a name that exists nowhere', async () => {
    const h = harness();
    const scope = scopeOf(toolsetView([]));

    await expect(h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, scope)).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET,
      message: 'Not part of this server.',
    });
    await expect(
      h.calls.call(SESSION, 'no_such_tool', ARGS, undefined, scopeOf(rootView())),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET });
    expect(h.intents.rows.size).toBe(0);
    expect(h.invoker.invocations).toHaveLength(0);
  });

  it('TOOL_NOT_ALLOWED for a tool the view serves and the access refuses', async () => {
    const h = harness();
    const restricted = buildGrant(AccessMode.RESTRICTED, [], [], () => []);

    await expect(
      h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, scopeOf(rootView(), { agent: restricted })),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.TOOL_NOT_ALLOWED,
      message: "This agent isn't allowed to use it.",
    });
    expect(h.intents.rows.size).toBe(0);
  });

  it('a viaUrlOnly toolset grant allows its tools on its own URL and nowhere else', async () => {
    const h = harness();
    const viaUrl = buildGrant(
      AccessMode.RESTRICTED,
      [],
      [{ toolsetId: TOOLSET_ID, version: null, viaUrlOnly: true }],
      () => [TOOL_ID],
    );

    await expect(
      h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, scopeOf(rootView(), { agent: viaUrl })),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_ALLOWED });
    const served = await h.calls.call(
      SESSION,
      TOOL_NAME,
      ARGS,
      undefined,
      scopeOf(toolsetView([TOOL_ID]), { agent: viaUrl }),
    );
    expect(served.kind).toBe('RESULT');
  });

  it('a key narrowing refuses what the agent alone allows', async () => {
    const h = harness();
    const keyNothing = buildGrant(AccessMode.RESTRICTED, [], [], () => []);
    await expect(
      h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, scopeOf(rootView(), { key: keyNothing })),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_ALLOWED });
  });

  it('NO_PROVIDER_MATCHES_RULES before any intent, naming each provider and source', async () => {
    const h = harness();
    const refusal = await h.calls
      .call(
        SESSION,
        TOOL_NAME,
        ARGS,
        undefined,
        scopeOf(
          toolsetView([TOOL_ID], {
            mode: ProviderMode.ONLY,
            providerIds: ['p2'],
            minTier: null,
            maxPrice: null,
            minQuality: null,
            onEmpty: OnEmpty.FAIL,
          }),
          {
            rules: { excludeProviderIds: ['p2'], maxPrice: null, minTier: null, minQuality: null },
          },
        ),
      )
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
    expect(
      (refusal as { context: { details: { providers: unknown[] } } }).context.details.providers,
    ).toEqual([
      expect.objectContaining({
        providerId: 'p1',
        reason: 'NOT_IN_ALLOWED_PROVIDERS',
        source: 'TOOLSET',
      }),
      expect.objectContaining({ providerId: 'p2', reason: 'EXCLUDED_BY_AGENT', source: 'AGENT' }),
    ]);
    expect(h.intents.rows.size).toBe(0);
    expect(h.invoker.invocations).toHaveLength(0);
  });

  it('routes only to the providers the merged rules leave', async () => {
    const h = harness();
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      ARGS,
      undefined,
      scopeOf(
        toolsetView([TOOL_ID], {
          mode: ProviderMode.EXCLUDE,
          providerIds: ['p1'],
          minTier: null,
          maxPrice: null,
          minQuality: null,
          onEmpty: OnEmpty.FAIL,
        }),
      ),
    );
    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.providerId).toBe('p2');
    expect(h.invoker.providerIds).toEqual(['p2']);
  });

  it('FALLBACK_BEST serves through Assay’s pick and says so on the receipt', async () => {
    const h = harness();
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      ARGS,
      undefined,
      scopeOf(
        toolsetView([TOOL_ID], {
          mode: ProviderMode.ONLY,
          providerIds: ['nobody'],
          minTier: null,
          maxPrice: null,
          minQuality: null,
          onEmpty: OnEmpty.FALLBACK_BEST,
        }),
      ),
    );
    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.fellBack).toBe(true);
  });

  it('an agent max price below the quote refuses before the hold', async () => {
    const h = harness();
    await expect(
      h.calls.call(
        SESSION,
        TOOL_NAME,
        ARGS,
        undefined,
        scopeOf(rootView(), {
          rules: {
            excludeProviderIds: [],
            maxPrice: usdc('0.01'),
            minTier: null,
            minQuality: null,
          },
        }),
      ),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
    expect(h.ledger.events).toHaveLength(0);
  });
});

describe('a scoped MCP URL — ?free=1 never charges', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  function harness(freeMode: PricingMode) {
    const invoker = new ScriptedInvoker({
      'binding-free': async () => ok('free'),
      'binding-paid': async () => ok('paid'),
    });
    const bindings =
      freeMode === PricingMode.PAID
        ? [buildBinding('paid')]
        : [
            buildBinding('free', {
              pricingMode: PricingMode.FREE,
              priceAmount: '0',
              freeQuotaPerAgent: 10,
            }),
            buildBinding('paid'),
          ];
    const built = buildMcpHarness({
      bindings,
      providers: [buildProvider('free'), buildProvider('paid')],
      invoker,
    });
    return { ...built, invoker };
  }

  const freeScope = () => scopeOf(rootView('?free=1'));

  it('a PAID tool is not part of a free-only URL', async () => {
    const h = harness(PricingMode.PAID);
    await expect(
      h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, freeScope()),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET });
    expect(h.intents.rows.size).toBe(0);
  });

  it('a FREEMIUM tool is served free inside its quota', async () => {
    const h = harness(PricingMode.FREEMIUM);
    const outcome = await h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, freeScope());
    if (outcome.kind !== 'RESULT') throw new Error('expected a RESULT');
    expect(outcome.receipt.charged.amount).toBe('0');
    expect(h.intents.rows.size).toBe(0);
  });

  it('an exhausted quota is the free-quota refusal, never a fall-through to paid', async () => {
    const h = harness(PricingMode.FREEMIUM);
    h.freeQuota.decision = {
      kind: 'REFUSED',
      limit: FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
      resetsAt: new Date('2026-10-18T00:00:00.000Z'),
      fallThroughToPaid: true,
    };

    await expect(
      h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, freeScope()),
    ).rejects.toMatchObject({ errorCode: McpErrorCode.MCP_QUOTA_EXCEEDED });
    expect(h.intents.rows.size).toBe(0);
    expect(h.ledger.events).toHaveLength(0);
    expect(h.invoker.providerIds).not.toContain('paid');
  });

  it('with no free-capable provider able to serve, refuses rather than charging', async () => {
    const h = harness(PricingMode.FREEMIUM);
    h.freeQuota.noRoomFor.add('binding-free');

    await expect(
      h.calls.call(SESSION, TOOL_NAME, ARGS, undefined, freeScope()),
    ).rejects.toBeDefined();
    expect(h.intents.rows.size).toBe(0);
    expect(h.invoker.providerIds).not.toContain('paid');
  });
});

describe('a scoped MCP URL — tools/list and the error shape', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  async function connect(scope: McpScope, recorder?: McpCallRecorder, limiter?: McpRateLimiter) {
    const h = buildMcpHarness({
      bindings: [buildBinding('p1')],
      providers: [buildProvider('p1')],
      invoker: new ScriptedInvoker({ 'binding-p1': async () => ok() }),
    });
    const servers = new McpServerFactory(h.catalogue, h.calls, recorder, limiter);
    const server = servers.create(SESSION, scope);
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { ...h, client };
  }

  it('lists view ∩ access only', async () => {
    const restricted = buildGrant(AccessMode.RESTRICTED, [], [], () => []);
    const { client } = await connect(scopeOf(rootView('?discovery=full'), { agent: restricted }));
    expect((await client.listTools()).tools).toEqual([]);

    const open = await connect(scopeOf(rootView('?discovery=full')));
    const [tool] = (await open.client.listTools()).tools;
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.description).toContain('From $0.05 per call');
  });

  it('reports the ?tools= names it ignored', async () => {
    const { client } = await connect(scopeOf(rootView('?tools=nope_tool')));
    const result = await client.listTools();
    expect(result.tools).toEqual([]);
    expect(result._meta?.[ASSAY_IGNORED_TOOLS]).toEqual(['nope_tool']);
  });

  it('lists a tool the rules leave no provider for as "No provider fits your limits", unpriced', async () => {
    const { client } = await connect(
      scopeOf(rootView('?discovery=full'), {
        rules: { excludeProviderIds: ['p1'], maxPrice: null, minTier: null, minQuality: null },
      }),
    );
    const [tool] = (await client.listTools()).tools;
    expect(tool.description).toContain('No provider fits your limits.');
    expect(tool._meta?.[ASSAY_NO_PROVIDER_FITS]).toBe(true);
    expect(tool._meta?.[X402_PRICE]).toBeUndefined();
  });

  it('a refusal reaches the model as plain text, with code, message, fixUrl and details', async () => {
    const writes: unknown[] = [];
    const recorder = new McpCallRecorder(
      {
        writeRefusal: async (input: unknown) => writes.push(input),
      } as unknown as ToolCallRecordWriter,
      undefined,
      { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' },
    );
    const restricted = buildGrant(AccessMode.RESTRICTED, [], [], () => []);
    const { client } = await connect(scopeOf(rootView(), { agent: restricted }), recorder);

    const result = (await client.callTool({ name: TOOL_NAME, arguments: ARGS })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: "This agent isn't allowed to use it." }]);
    expect(result._meta?.[X402_ERROR]).toMatchObject({
      code: 'TOOL_NOT_ALLOWED',
      message: "This agent isn't allowed to use it.",
      fixUrl: `https://app.example.com/agents?agent=${SESSION.agentId}#access`,
      details: { name: TOOL_NAME, toolId: TOOL_ID },
      retryable: false,
    });
    expect(result._meta?.[X402_RECEIPT]).toBeUndefined();
    expect(writes).toEqual([
      expect.objectContaining({
        refusalCode: 'TOOL_NOT_ALLOWED',
        refusalLayer: RefusalLayer.AGENT_LIMITS,
        toolId: TOOL_ID,
        toolName: TOOL_NAME,
        attribution: expect.objectContaining({ endpointKind: 'ROOT' }),
      }),
    ]);
  });

  it('a rules refusal links to the refused call and is put on the layer of its rules', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const recorder = new McpCallRecorder(
      {
        writeRefusal: async (input: Record<string, unknown>) => writes.push(input),
      } as unknown as ToolCallRecordWriter,
      undefined,
      { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' },
    );
    const { client } = await connect(
      scopeOf(
        toolsetView([TOOL_ID], {
          mode: ProviderMode.EXCLUDE,
          providerIds: ['p1'],
          minTier: null,
          maxPrice: null,
          minQuality: null,
          onEmpty: OnEmpty.FAIL,
        }),
      ),
      recorder,
    );

    const result = (await client.callTool({ name: TOOL_NAME, arguments: ARGS })) as CallToolResult;
    const error = result._meta?.[X402_ERROR] as Record<string, unknown>;

    expect(error.code).toBe('NO_PROVIDER_MATCHES_RULES');
    expect(error.fixUrl).toBe(
      `https://app.example.com/spend/calls?call=${String(writes[0].callId)}`,
    );
    expect(writes[0]).toMatchObject({
      refusalLayer: RefusalLayer.TOOLSET_RULES,
      attribution: { endpointKind: 'TOOLSET', toolsetId: TOOLSET_ID, toolsetVersion: null },
    });
  });

  function limiter() {
    const counters = new Map<string, number>();
    const redis = {
      incr: async (key: string) => {
        counters.set(key, (counters.get(key) ?? 0) + 1);
        return counters.get(key);
      },
      pexpire: async () => 1,
      get: async (key: string) => (counters.has(key) ? String(counters.get(key)) : null),
      expire: async () => 1,
    };
    return new McpRateLimiter({ getRedisClient: () => redis } as unknown as CacheService, () => 0);
  }

  it('?free=1 does not list a paid tool the rules left unpriced', async () => {
    const { client } = await connect(
      scopeOf(rootView('?free=1&discovery=full'), {
        rules: { excludeProviderIds: ['p1'], maxPrice: null, minTier: null, minQuality: null },
      }),
    );
    expect((await client.listTools()).tools).toEqual([]);
  });

  it(`answers RATE_LIMITED beyond ${MCP_RATE_LIMITS.listsPerMinute} lists a minute per credential and URL`, async () => {
    const { client } = await connect(scopeOf(rootView()), undefined, limiter());
    for (let n = 0; n < MCP_RATE_LIMITS.listsPerMinute; n += 1) await client.listTools();
    await expect(client.listTools()).rejects.toMatchObject({
      code: MCP_RATE_LIMITED_ERROR_CODE,
      data: { code: 'RATE_LIMITED', retryAfterMs: expect.any(Number) },
    });
  });

  it(`answers RATE_LIMITED, before anything runs, once an agent has ${MCP_RATE_LIMITS.refusalsPerMinute} refusals in a minute`, async () => {
    const rate = limiter();
    const recorder = new McpCallRecorder(
      { writeRefusal: async () => undefined } as unknown as ToolCallRecordWriter,
      undefined,
      undefined,
      undefined,
      undefined,
      rate,
    );
    const { client } = await connect(scopeOf(rootView('?tools=nope_tool')), recorder, rate);
    for (let n = 0; n < MCP_RATE_LIMITS.refusalsPerMinute; n += 1) {
      await client.callTool({ name: 'nope_tool', arguments: {} });
    }
    const result = (await client.callTool({ name: 'nope_tool', arguments: {} })) as CallToolResult;
    expect(result._meta?.[X402_ERROR]).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: expect.any(Number),
    });
  });
});
