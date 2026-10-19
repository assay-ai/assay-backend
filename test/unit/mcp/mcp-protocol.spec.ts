import { offerSolanaRailAInThisSuite } from '../helpers/solana-rail-b';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

import { ASSAY_ERROR, ASSAY_PRICE, ASSAY_RECEIPT } from '@modules/mcp/constants/mcp.constants';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import {
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  ok,
  status,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { SESSION, buildMcpHarness } from './helpers/mcp-harness';

/**
 * The protocol surface, driven by the **reference MCP client**.
 *
 * Everything else in this directory tests the platform's own services. This
 * file tests the thing an agent actually experiences: a real
 * `@modelcontextprotocol/sdk` `Client`, over a real transport, parsing every
 * response through the specification's own schemas.
 *
 * That distinction is the reason the file exists. The SDK validates what it
 * receives and **discards** anything the specification does not describe — so a
 * server can publish a perfectly good price that no client ever sees. Only a
 * test that reads the result *through the client* can catch that, and it is
 * exactly what caught it here.
 */
describe('MCP protocol surface, through the reference client', () => {
  // Solana has no paid rail by default (review 2026-10-15, C1); these cases
  // pin the rail-A code that is kept for when it is switched back on.
  offerSolanaRailAInThisSuite();

  const ARGS = { query: 'moon landing' };

  async function connect(script: Record<string, () => Promise<never>>, overrides = {}) {
    const harness = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker: new ScriptedInvoker(script as never),
      ...overrides,
    });

    const server = harness.servers.create(SESSION);
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return { ...harness, client };
  }

  it('lists a tool whose price survives the schema validation of the client', async () => {
    const { client } = await connect({});

    const result: ListToolsResult = await client.listTools();
    const [tool] = result.tools;

    expect(tool.name).toBe('Search the web');
    // The point of the whole exercise: after the SDK has parsed the response,
    // the price is still there. It is read from `_meta` because `annotations`
    // is a closed schema and the SDK strips unknown keys out of it.
    expect(tool._meta?.[ASSAY_PRICE]).toEqual({
      amount: usdc('0.05').amount,
      maxAmount: usdc('0.05').amount,
      asset: usdc('0.05').asset,
      display: '$0.05',
    });
  });

  it('returns the result as both text and structured content, with a receipt', async () => {
    const { client } = await connect({
      'binding-provider-a': () => Promise.resolve(ok('forty-two')) as never,
    });

    const result = (await client.callTool({
      name: 'Search the web',
      arguments: ARGS,
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ answer: 'forty-two' });
    expect(result.content).toEqual([{ type: 'text', text: '{"answer":"forty-two"}' }]);

    const receipt = result._meta?.[ASSAY_RECEIPT] as Record<string, unknown>;
    // Durably handed to the verification worker, not judged yet — the
    // receipt says `VERIFYING`, which is the truth.
    expect(receipt.status).toBe(PaymentIntentStatus.VERIFYING);
    expect(receipt.providerId).toBe('provider-a');
    // Held, not charged: nothing is charged until the verdict settles it.
    expect(receipt.charged).toEqual({
      amount: '0',
      asset: usdc('0.05').asset,
      display: '$0',
    });
    expect(receipt.held).toEqual({
      amount: usdc('0.05').amount,
      asset: usdc('0.05').asset,
      // The same string `tools/list` quoted, not a second rendering of it.
      display: '$0.05',
    });
  });

  /**
   * A tool call that fails is a **result**, not a JSON-RPC error.
   *
   * The specification draws the line between "the protocol failed" and "the
   * tool did not succeed", and a model only ever gets to read the second. A
   * server that raised a protocol error for an unknown tool would make the
   * failure invisible to the thing that has to react to it.
   */
  it('reports an unknown tool as an error result the model can read', async () => {
    const { client } = await connect({});

    const result = (await client.callTool({ name: 'no_such_tool' })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result._meta?.[ASSAY_ERROR]).toMatchObject({
      code: 'MCP_TOOL_NOT_FOUND',
      retryable: false,
    });
  });

  it('reports a missing required argument as an error result', async () => {
    const { client } = await connect({});

    const result = (await client.callTool({
      name: 'Search the web',
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result._meta?.[ASSAY_ERROR]).toMatchObject({
      code: 'TOOL_MAPPING_REQUIRED_FIELD_MISSING',
      retryable: false,
    });
  });

  it('reports an unaffordable call with the price and the balance', async () => {
    const { client } = await connect(
      {
        'binding-provider-a': () => {
          throw new Error('the provider must never be called');
        },
      },
      { balance: usdc('0.01') },
    );

    const result = (await client.callTool({
      name: 'Search the web',
      arguments: ARGS,
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result._meta?.[ASSAY_ERROR]).toMatchObject({
      code: 'PAYMENT_INSUFFICIENT_FUNDS',
      retryable: false,
      price: usdc('0.05').amount,
      available: usdc('0.01').amount,
    });
  });

  it('marks an exhausted provider pool retryable and a rejected request not', async () => {
    const outage = await connect({
      'binding-provider-a': () => Promise.resolve(status(503)) as never,
    });
    const rejected = await connect({
      'binding-provider-a': () => Promise.resolve(status(400, { error: 'bad' })) as never,
    });

    const outageResult = (await outage.client.callTool({
      name: 'Search the web',
      arguments: ARGS,
    })) as CallToolResult;
    const rejectedResult = (await rejected.client.callTool({
      name: 'Search the web',
      arguments: ARGS,
    })) as CallToolResult;

    expect(outageResult._meta?.[ASSAY_ERROR]).toMatchObject({
      code: 'TOOL_ALL_BINDINGS_FAILED',
      retryable: true,
      // So the agent can open the receipt of the voided call.
      intentId: expect.any(String),
    });
    expect(rejectedResult._meta?.[ASSAY_ERROR]).toMatchObject({
      code: 'PROVIDER_REQUEST_ERROR',
      retryable: false,
    });
  });
});
