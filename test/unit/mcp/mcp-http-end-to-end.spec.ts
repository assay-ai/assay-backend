import { INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  Client as ModernClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { MCP_SESSION_SOURCE } from '@modules/mcp/ports/mcp-session.port';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import { MCP_HOST_CONFIG } from '@modules/toolset/config/mcp-host.config';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import { EndpointKind, ParsedMcpUrl } from '@modules/toolset/domain/mcp-url';
import { AccessResolver } from '@modules/toolset/services/access.resolver';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import { ScriptedInvoker, buildBinding, buildProvider, ok } from '../tool/helpers/routing-fixtures';
import { SESSION, buildMcpHarness } from './helpers/mcp-harness';

const TOKEN = 'end-to-end-agent-token';
const TOOL_NAME = 'Search the web';

/**
 * An agent's whole discovery flow over real HTTP, through the real controller,
 * transport bridge, server factory, discovery service and call pipeline (the
 * ledger, intents and provider are the MCP harness's fakes): `tools/list` on
 * `/` (SEARCH), `search_tools`, `get_tool`, then `call_tool` — once with a
 * protocol 2026-07-28 client, once with a 2025-era one.
 */
describe('discovery end to end over HTTP', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  let app: INestApplication;
  let url: URL;
  let harness: ReturnType<typeof buildMcpHarness>;

  beforeAll(async () => {
    harness = buildMcpHarness({
      bindings: [buildBinding('p1')],
      providers: [buildProvider('p1')],
      invoker: new ScriptedInvoker({ 'binding-p1': async () => ok('forty-two') }),
    });

    @Module({
      controllers: [McpController],
      providers: [
        {
          provide: MCP_SESSION_SOURCE,
          useValue: {
            resolve: async (token: string | null) => {
              if (token !== TOKEN) throw McpErrors.credentialInvalid();
              return SESSION;
            },
          },
        },
        {
          provide: McpServerFactory,
          useValue: new McpServerFactory(harness.catalogue, harness.calls),
        },
        {
          provide: McpEndpointResolver,
          useValue: {
            resolve: async (_org: string, parsed: ParsedMcpUrl) => ({
              canonicalUrl: 'https://mcp.example.com/',
              path: parsed.path,
              kind: EndpointKind.ROOT,
              filter: parsed.filter,
              toolset: null,
              handle: null,
              baseToolIds: null,
              entryRules: new Map(),
            }),
          },
        },
        {
          provide: AccessResolver,
          useValue: {
            resolve: async () => ({
              agentId: SESSION.agentId,
              agent: ALLOW_ALL,
              key: null,
              rules: null,
              pinnedTools: [],
              policyVersion: 1,
            }),
          },
        },
        {
          provide: MCP_HOST_CONFIG,
          useValue: {
            mcpPublicUrl: 'https://mcp.example.com',
            webAppUrl: 'https://app.example.com',
          },
        },
      ],
    })
    class EndToEndModule {}

    const moduleRef = await Test.createTestingModule({ imports: [EndToEndModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    url = new URL(`${await app.getUrl()}/`);
  });

  afterAll(async () => app.close());

  const headers = { Authorization: `Bearer ${TOKEN}` };

  it('a 2026-07-28 client: list (with ttlMs), search, get, then call', async () => {
    const client = new ModernClient(
      { name: 'modern-agent', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'search_tools',
      'get_tool',
      'call_tool',
    ]);
    expect((listed as { ttlMs?: number }).ttlMs).toBe(60_000);

    const found = await client.callTool({ name: 'search_tools', arguments: { query: 'web' } });
    expect(found.structuredContent).toMatchObject({
      results: [{ name: TOOL_NAME, price: '$0.05' }],
      total: 1,
      nextCursor: null,
    });

    const described = await client.callTool({ name: 'get_tool', arguments: { name: TOOL_NAME } });
    expect(described.structuredContent).toMatchObject({ name: TOOL_NAME, version: '1.0.0' });

    const called = await client.callTool({
      name: 'call_tool',
      arguments: { name: TOOL_NAME, arguments: { query: 'moon landing' } },
    });
    expect(called.isError).toBeFalsy();
    expect(called.structuredContent).toEqual({ answer: 'forty-two' });
    expect(called._meta?.['assay/receipt']).toMatchObject({ providerId: 'p1' });
    await client.close();
  });

  it('a 2025-era client gets the same tools and results, with no ttlMs', async () => {
    const client = new LegacyClient({ name: 'older-agent', version: '1.0.0' });
    await client.connect(new LegacyTransport(url, { requestInit: { headers } }));

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'search_tools',
      'get_tool',
      'call_tool',
    ]);
    expect((listed as { ttlMs?: number }).ttlMs).toBeUndefined();
    expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: false } });

    const found = await client.callTool({ name: 'search_tools', arguments: { query: 'web' } });
    expect(found.structuredContent).toMatchObject({ results: [{ name: TOOL_NAME }] });

    const called = await client.callTool({
      name: 'call_tool',
      arguments: { name: TOOL_NAME, arguments: { query: 'moon landing' } },
    });
    expect(called.structuredContent).toEqual({ answer: 'forty-two' });
    await client.close();
  });
});
