import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

import {
  X402_FREE_QUOTA,
  X402_PAID_ALTERNATIVE,
  X402_PRICING_MODE,
} from '@modules/mcp/constants/mcp.constants';
import { PricingMode } from '@modules/tool/ports/tool.types';

import { buildBinding, buildProvider, buildTool } from '../tool/helpers/routing-fixtures';
import { buildMcpHarness } from './helpers/mcp-harness';

/**
 * The free-tier annotations, read through the **reference MCP client**
 * extending `mcp-protocol.spec.ts`'s own approach: the SDK
 * validates and **strips** any `annotations` key it does not recognise
 * (`ToolSchema.annotations` is `$strip`), so only a client-side read proves
 * `x402/pricingMode`, `x402/freeQuota` and `x402/paidAlternative` actually
 * reach an agent rather than merely existing in the server's own object.
 *
 * This wires `ListToolsRequestSchema` straight to
 * `McpCatalogueService.listTools(viewer)` rather than through
 * `McpServerFactory` (which `tools/call`'s protocol tests use): the factory's
 * `ListToolsRequestSchema` handler does not thread a viewer through today —
 * see `McpCatalogueService.listTools`'s own doc comment and this branch's
 * final report for the one-line change that needs making there. Until that
 * lands, this is the same mechanism (`Server` + `Client` + `InMemoryTransport`,
 * the exact construction `McpServerFactory.create` uses) proving the same
 * claim about `McpCatalogueService` itself.
 */
describe('free-tier annotations, through the reference MCP client', () => {
  async function connectWithViewer(viewer?: { organizationId: string; agentId: string }) {
    const tool = buildTool({ name: 'search_web' });
    const harness = buildMcpHarness({
      tool,
      bindings: [buildBinding('provider-a', { pricingMode: PricingMode.FREEMIUM })],
      providers: [buildProvider('provider-a')],
      invoker: { invoke: () => Promise.reject(new Error('not called in this suite')) } as never,
    });

    harness.freeQuota.setRemaining(tool.id, {
      remaining: 42,
      limit: 100,
      resetsAt: new Date('2026-08-11T00:00:00.000Z'),
    });

    const server = new Server(
      { name: 'x402-payment-platform', version: '0.0.0-test' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await harness.catalogue.listTools(viewer),
    }));

    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return client;
  }

  it('carries x402/pricingMode and x402/paidAlternative in _meta after SDK validation', async () => {
    const client = await connectWithViewer();

    const result: ListToolsResult = await client.listTools();
    const [tool] = result.tools;

    expect(tool._meta?.[X402_PRICING_MODE]).toBe(PricingMode.FREEMIUM);
    expect(tool._meta?.[X402_PAID_ALTERNATIVE]).toBe('search_web');
    // Not a behavioural hint the MCP spec recognises, so `annotations` itself is
    // stripped clean of it — proving the duplication is what saves it, not a
    // coincidence of this particular SDK version.
    expect(tool.annotations).not.toHaveProperty(X402_PRICING_MODE);
  });

  it('carries this agent’s own x402/freeQuota in _meta when a viewer connects', async () => {
    const client = await connectWithViewer({ organizationId: 'org-1', agentId: 'agent-1' });

    const result: ListToolsResult = await client.listTools();
    const [tool] = result.tools;

    expect(tool._meta?.[X402_FREE_QUOTA]).toEqual({
      remaining: 42,
      limit: 100,
      resetsAt: '2026-08-11T00:00:00.000Z',
    });
  });

  it('omits x402/freeQuota when nobody is asking on an agent’s behalf', async () => {
    const client = await connectWithViewer(undefined);

    const result: ListToolsResult = await client.listTools();
    const [tool] = result.tools;

    expect(tool._meta).not.toHaveProperty(X402_FREE_QUOTA);
  });
});
