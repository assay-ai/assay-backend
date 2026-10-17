import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { AccountId } from '@modules/chains/ports/caip.types';
import {
  X402_ERROR,
  X402_IDEMPOTENCY_KEY,
  X402_PAYMENT_REQUIRED,
  X402_RAIL,
  X402_RECEIPT,
  X402_REPLAYED,
  X402_VOUCHER,
} from '@modules/mcp/constants/mcp.constants';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import { VoucherRequirement } from '@modules/mcp/services/mcp-tool-call.service';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { ALLOW_ALL, AccessMode, ResolvedAccess, buildGrant } from '@modules/toolset/domain/access';
import { EndpointKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { McpEndpointView } from '@modules/toolset/domain/view';

import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import { ScriptedInvoker, buildBinding, buildProvider, ok } from '../tool/helpers/routing-fixtures';
import { CHAIN_ID, SESSION, buildMcpHarness, fakeVoucherSignature } from './helpers/mcp-harness';

const TOOL_NAME = 'Search the web';
const ARGS = { query: 'moon landing' };
const AGENT: AccountId = `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId;

function rootView(): McpEndpointView {
  const parsed = parseMcpUrl('/')!;
  return {
    canonicalUrl: 'https://mcp.example.com/',
    path: parsed.path,
    kind: EndpointKind.ROOT,
    filter: parsed.filter,
    toolset: null,
    handle: null,
    baseToolIds: null,
    entryRules: new Map(),
  };
}

function scopeOf(over: Partial<ResolvedAccess> = {}): McpScope {
  const view = rootView();
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

async function connect(
  scope: McpScope = scopeOf(),
  session: McpSession = SESSION,
  harness = build(),
) {
  const servers = new McpServerFactory(harness.catalogue, harness.calls);
  const server = servers.create(session, scope);
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...harness, client };
}

function build() {
  const invoker = new ScriptedInvoker({ 'binding-p1': async () => ok('forty-two') });
  const built = buildMcpHarness({
    bindings: [buildBinding('p1')],
    providers: [buildProvider('p1')],
    invoker,
  });
  return { ...built, invoker };
}

type Via = 'tools/call' | 'call_tool';

/** The same call, made directly or through `call_tool`. */
async function callVia(
  client: Client,
  via: Via,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<CallToolResult> {
  const request =
    via === 'tools/call'
      ? { name, arguments: args, ...(meta ? { _meta: meta } : {}) }
      : {
          name: 'call_tool',
          arguments: { name, arguments: args },
          ...(meta ? { _meta: meta } : {}),
        };
  return (await client.callTool(request)) as CallToolResult;
}

/** A result with its per-call ids blanked, so two runs compare equal. */
function normalised(result: CallToolResult): unknown {
  return JSON.parse(
    JSON.stringify(result)
      .replace(/"intentId":"[^"]+"/g, '"intentId":"*"')
      .replace(/"callId":"[^"]+"/g, '"callId":"*"'),
  );
}

/**
 * `call_tool` is a door to the `tools/call` pipeline, not a way around it
 * (design spec §7.4): the same view, access, rules, payment, idempotency key
 * and attribution, the request's `_meta` in, the inner result's out.
 */
describe('call_tool runs exactly the tools/call pipeline', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('serves and charges exactly like tools/call, and returns the inner result unchanged', async () => {
    const results: Record<Via, unknown> = {} as Record<Via, unknown>;
    const ledgers: Record<Via, unknown> = {} as Record<Via, unknown>;
    for (const via of ['tools/call', 'call_tool'] as const) {
      const h = await connect();
      const result = await callVia(h.client, via, TOOL_NAME, ARGS);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ answer: 'forty-two' });
      expect(result._meta?.[X402_RECEIPT]).toMatchObject({ held: { display: '$0.05' } });
      expect(h.invoker.invocations).toHaveLength(1);
      results[via] = normalised(result);
      ledgers[via] = JSON.parse(
        JSON.stringify(h.ledger.events).replace(/"intentId":"[^"]+"/g, '"intentId":"*"'),
      );
    }
    expect(results.call_tool).toEqual(results['tools/call']);
    expect(ledgers.call_tool).toEqual(ledgers['tools/call']);
  });

  it.each([
    ['an unknown tool', ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET, 'no_such_tool', scopeOf()],
    [
      'a tool access refuses',
      ToolAccessErrorCode.TOOL_NOT_ALLOWED,
      TOOL_NAME,
      scopeOf({ agent: buildGrant(AccessMode.RESTRICTED, [], [], () => []) }),
    ],
    [
      'a key narrowing',
      ToolAccessErrorCode.TOOL_NOT_ALLOWED,
      TOOL_NAME,
      scopeOf({ key: buildGrant(AccessMode.RESTRICTED, [], [], () => []) }),
    ],
    [
      'rules that leave no provider',
      ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
      TOOL_NAME,
      scopeOf({
        rules: { excludeProviderIds: ['p1'], maxPrice: null, minTier: null, minQuality: null },
      }),
    ],
  ])('refuses %s with the same code and result, charging nothing', async (_, code, name, scope) => {
    const answers: unknown[] = [];
    for (const via of ['tools/call', 'call_tool'] as const) {
      const h = await connect(scope);
      const result = await callVia(h.client, via, name, ARGS);
      expect((result._meta?.[X402_ERROR] as { code: string }).code).toBe(code);
      expect(h.intents.rows.size).toBe(0);
      expect(h.ledger.events).toHaveLength(0);
      expect(h.invoker.invocations).toHaveLength(0);
      answers.push(normalised(result));
    }
    expect(answers[1]).toEqual(answers[0]);
  });

  it('refuses invalid inner arguments with the same schema error', async () => {
    const answers: unknown[] = [];
    for (const via of ['tools/call', 'call_tool'] as const) {
      const h = await connect();
      const result = await callVia(h.client, via, TOOL_NAME, { query: 42 });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result._meta)).toContain('/query');
      expect(h.ledger.events).toHaveLength(0);
      answers.push(normalised(result));
    }
    expect(answers[1]).toEqual(answers[0]);
  });

  it('honours the idempotency key in its _meta: one charge, the retry replayed', async () => {
    const h = await connect();
    const meta = { [X402_IDEMPOTENCY_KEY]: 'retry-key-0001' };
    const first = await callVia(h.client, 'call_tool', TOOL_NAME, ARGS, meta);
    const again = await callVia(h.client, 'call_tool', TOOL_NAME, ARGS, meta);
    expect(first._meta?.[X402_REPLAYED]).toBeUndefined();
    expect(again._meta?.[X402_REPLAYED]).toBe(true);
    expect(again.structuredContent).toEqual(first.structuredContent);
    expect(h.invoker.invocations).toHaveLength(1);
    expect(h.ledger.events.filter((event) => event.kind === 'HOLD_CREATE')).toHaveLength(1);

    // The key space is the pipeline's: the same key through tools/call replays too.
    const direct = await callVia(h.client, 'tools/call', TOOL_NAME, ARGS, meta);
    expect(direct._meta?.[X402_REPLAYED]).toBe(true);
    expect(h.invoker.invocations).toHaveLength(1);
  });

  it('never runs a meta tool as its inner call', async () => {
    const h = await connect();
    for (const inner of ['call_tool', 'search_tools', 'get_tool']) {
      const result = await callVia(h.client, 'call_tool', inner, {});
      expect((result._meta?.[X402_ERROR] as { code: string }).code).toBe(
        ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET,
      );
    }
    expect(h.invoker.invocations).toHaveLength(0);
  });

  it('refuses its own arguments with the schema path when the name is missing', async () => {
    const h = await connect();
    const result = (await h.client.callTool({
      name: 'call_tool',
      arguments: { arguments: ARGS },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result._meta)).toContain('name');
    expect(h.invoker.invocations).toHaveLength(0);
  });
});

describe('call_tool on rail B: the voucher handshake in _meta (§8.2 H)', () => {
  offerSolanaRailsInThisSuite('B');

  const RAIL_B_SESSION: McpSession = { ...SESSION, agentAccount: AGENT };

  function voucherMeta(requirement: VoucherRequirement): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const voucher = {
      payer: requirement.payer,
      payTo: requirement.payTo,
      provider: requirement.provider,
      amount: requirement.amount,
      resource: requirement.resource,
      requestHash: requirement.requestHash,
      seq: requirement.seq,
      issuedAt: now,
      expiresAt: now + 120,
    };
    return {
      [X402_VOUCHER]: {
        voucher,
        signature: fakeVoucherSignature(voucher.payer),
        providerId: requirement.providerId,
      },
    };
  }

  it('returns x402/paymentRequired at the top level, then serves on the voucher', async () => {
    const h = await connect(scopeOf(), RAIL_B_SESSION);
    const asked = await callVia(h.client, 'call_tool', TOOL_NAME, ARGS, { [X402_RAIL]: 'B' });
    expect(asked.isError).toBe(true);
    const requirement = asked._meta?.[X402_PAYMENT_REQUIRED] as VoucherRequirement;
    expect(requirement).toMatchObject({ providerId: 'p1' });

    const paid = await callVia(h.client, 'call_tool', TOOL_NAME, ARGS, voucherMeta(requirement));
    expect(paid.isError).toBeFalsy();
    expect(paid.structuredContent).toEqual({ answer: 'forty-two' });
    expect(paid._meta?.[X402_RECEIPT]).toMatchObject({ providerId: 'p1' });
    expect(h.invoker.invocations).toHaveLength(1);
  });

  it('asks for the same payment as tools/call would', async () => {
    const asks: unknown[] = [];
    for (const via of ['tools/call', 'call_tool'] as const) {
      const h = await connect(scopeOf(), RAIL_B_SESSION);
      const asked = await callVia(h.client, via, TOOL_NAME, ARGS, { [X402_RAIL]: 'B' });
      const requirement = { ...(asked._meta?.[X402_PAYMENT_REQUIRED] as object) };
      delete (requirement as Record<string, unknown>).intentId;
      asks.push(requirement);
    }
    expect(asks[1]).toEqual(asks[0]);
  });
});
