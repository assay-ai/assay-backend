import http from 'node:http';

import { INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  Client as ModernClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { mcpCorsOptions } from '@bootstrap/mcp/mcp-cors';
import { AuthErrors } from '@modules/auth/errors/auth.errors';
import { BlockSubjectKind, BlockedRole } from '@modules/blocklist/domain/account-block';
import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { MCP_SESSION_SOURCE } from '@modules/mcp/ports/mcp-session.port';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import { OAuthDiscoveryModule } from '@modules/oauth/oauth-discovery.module';
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
const SUSPENDED_TOKEN = 'suspended-agent-token';
const BLOCKED_TOKEN = 'blocked-agent-token';
const MCP = 'https://mcp.example.com';
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
              if (token === SUSPENDED_TOKEN) throw AuthErrors.agentSuspended();
              if (token === BLOCKED_TOKEN) {
                return {
                  ...SESSION,
                  blocked: { role: BlockedRole.PAYER, subjectKind: BlockSubjectKind.WALLET },
                };
              }
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
            mcpPublicUrl: MCP,
            webAppUrl: 'https://app.example.com',
          },
        },
      ],
    })
    class EndToEndModule {}

    // `OAuthDiscoveryModule` first, as in `AppMcpModule`, so the discovery routes
    // answer for real in the CORS tests below.
    const moduleRef = await Test.createTestingModule({
      imports: [OAuthDiscoveryModule, EndToEndModule],
    })
      .overrideProvider(MCP_HOST_CONFIG)
      .useValue({ mcpPublicUrl: MCP, webAppUrl: 'https://app.example.com' })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    // The MCP bootstrap's CORS (`bootstrap/mcp/main.ts`), so the exposed
    // headers below are the ones production sends.
    app.enableCors(mcpCorsOptions);
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
    expect(called._meta?.['x402/receipt']).toMatchObject({ providerId: 'p1' });
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

  /**
   * The 401 challenge (spec §6.3.3, R-OA-3): every `MCP_CREDENTIAL_INVALID`
   * from the catch-all names the path's protected resource metadata, so an
   * OAuth client can start the flow from the URL alone.
   */
  describe('the 401 challenge', () => {
    const post = (path: string, extra: Record<string, string> = {}) =>
      fetch(new URL(path, url), {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...extra,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });

    it('no token on /c/weather → 401 with WWW-Authenticate naming the path PRM', async () => {
      const response = await post('/c/weather');
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource/c/weather", scope="assay:agent"`,
      );
      // Body unchanged: the platform's ordinary error response.
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'MCP_CREDENTIAL_INVALID', statusCode: 401 },
      });
    });

    it('bad token → the same challenge plus error="invalid_token"', async () => {
      const response = await post('/c/weather', { Authorization: 'Bearer not-a-real-token' });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource/c/weather", scope="assay:agent", error="invalid_token"`,
      );
    });

    it('an Authorization header that is not a bearer token counts as no token', async () => {
      const response = await post('/c/weather', { Authorization: 'Basic dXNlcjpwYXNz' });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).not.toContain('error=');
    });

    it('suspended agent → AUTH_AGENT_SUSPENDED and no header', async () => {
      const response = await post('/c/weather', { Authorization: `Bearer ${SUSPENDED_TOKEN}` });
      expect(response.status).toBe(403);
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: 'AUTH_AGENT_SUSPENDED' } });
    });

    it('a blocked session keeps its refusal and gets no header', async () => {
      const response = await post('/c/weather', { Authorization: `Bearer ${BLOCKED_TOKEN}` });
      expect(response.status).toBe(403);
      expect(response.headers.get('www-authenticate')).toBeNull();
    });

    it('an unknown path stays a 404 with no header', async () => {
      const response = await post('/no/such/thing');
      expect(response.status).toBe(404);
      expect(response.headers.get('www-authenticate')).toBeNull();
    });

    it('/?tools=… → resource_metadata for / (the path PRM, no query)', async () => {
      const response = await post('/?tools=get_weather&free=1');
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource", scope="assay:agent"`,
      );
    });

    it('keeps the path as the client sent it, so a strict client finds its own resource', async () => {
      const response = await post('/%40acme/kit?free=1');
      expect(response.headers.get('www-authenticate')).toContain(
        `resource_metadata="${MCP}/.well-known/oauth-protected-resource/%40acme/kit"`,
      );
    });

    it.each(['bearer', 'BEARER', 'BeArEr'])(
      'the scheme is case-insensitive: "%s <valid token>" is served (RFC 7235 §2.1)',
      async (scheme) => {
        const response = await post('/', { Authorization: `${scheme} ${TOKEN}` });
        expect(response.status).toBe(200);
        expect(response.headers.get('www-authenticate')).toBeNull();
      },
    );

    it.each(['bearer', 'BEARER'])(
      '"%s <bad token>" counts as a presented token: error="invalid_token"',
      async (scheme) => {
        const response = await post('/c/weather', { Authorization: `${scheme} not-a-real-token` });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
      },
    );

    it('"Bearer" with no token counts as no token', async () => {
      const response = await post('/c/weather', { Authorization: 'Bearer    ' });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).not.toContain('error=');
    });

    it('a valid token gets no challenge', async () => {
      const response = await post('/', { Authorization: `Bearer ${TOKEN}` });
      expect(response.status).toBe(200);
      expect(response.headers.get('www-authenticate')).toBeNull();
    });
  });

  /** CORS (spec §6.3): the catch-all exposes the challenge; OAuth routes get their own policy. */
  describe('CORS', () => {
    const ORIGIN = 'https://agent.example.org';

    const preflight = (path: string, requestHeaders = 'content-type') =>
      fetch(new URL(path, url), {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': requestHeaders,
        },
      });

    it('CORS preflight exposes www-authenticate', async () => {
      const response = await preflight('/c/weather', 'authorization,content-type');
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
      expect(response.headers.get('access-control-expose-headers')).toContain('www-authenticate');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('the 401 itself exposes www-authenticate to a browser client', async () => {
      const response = await fetch(new URL('/c/weather', url), {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('access-control-expose-headers')?.split(',')).toEqual(
        expect.arrayContaining(['mcp-session-id', 'mcp-protocol-version', 'www-authenticate']),
      );
    });

    it.each([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/c/weather',
      '/.well-known/oauth-authorization-server',
      '/.WELL-KNOWN/oauth-authorization-server/',
    ])(
      '%s: any origin, GET/POST/OPTIONS, Content-Type and MCP-Protocol-Version, no credentials',
      async (path) => {
        const response = await preflight(path, 'content-type,mcp-protocol-version');
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
        expect(response.headers.get('access-control-allow-headers')).toBe(
          'Content-Type,MCP-Protocol-Version',
        );
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
        expect(response.headers.get('access-control-expose-headers')).toBeNull();
      },
    );

    it.each(['/oauth/token', '/oauth/revoke', '/OAuth/Token/'])(
      '%s: any origin, GET/POST/OPTIONS, Content-Type only, no credentials',
      async (path) => {
        const response = await preflight(path);
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
        expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type');
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
        expect(response.headers.get('access-control-expose-headers')).toBeNull();
      },
    );

    it('a plain cross-origin GET of the AS metadata carries the CORS headers on the 200', async () => {
      // A simple request: no preflight, so the 200 itself must allow the origin.
      const response = await fetch(new URL('/.well-known/oauth-authorization-server', url), {
        headers: { Origin: ORIGIN, Accept: 'application/json' },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).issuer).toBe(MCP);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('a plain cross-origin GET of a path PRM carries the CORS headers on the 200', async () => {
      const response = await fetch(
        new URL('/.well-known/oauth-protected-resource/c/weather', url),
        { headers: { Origin: ORIGIN } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('a plain cross-origin POST to /oauth/register carries no CORS header', async () => {
      const response = await fetch(new URL('/oauth/register', url), {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it.each([
      `http://mcp.example.com/oauth/register`,
      `HTTP://MCP.EXAMPLE.COM/OAuth/Register/`,
      `http://mcp.example.com/oauth/authorize?client_id=x`,
    ])('an absolute-form target %s is matched on its pathname: no CORS', async (target) => {
      const response = await rawRequest(
        'OPTIONS',
        target,
        {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
        },
        url,
      );
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
    });

    it('an absolute-form target for /oauth/token gets the token policy', async () => {
      const response = await rawRequest(
        'OPTIONS',
        'http://mcp.example.com/oauth/token',
        {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
        },
        url,
      );
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-headers']).toBe('Content-Type');
    });

    it.each([
      '/oauth/register',
      '/OAuth/Register/',
      '/oauth/authorize',
      '/oauth/authorize/continue',
      '/oauth/clients/assay-mcp',
      '/oauth',
    ])('%s: no CORS at all', async (path) => {
      const response = await preflight(path);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-methods')).toBeNull();
    });
  });
});

/** A request with a raw target (`http.request` passes `path` verbatim), e.g. absolute-form. */
function rawRequest(
  method: string,
  target: string,
  headers: Record<string, string>,
  base: URL,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const call = http.request(
      { host: base.hostname, port: base.port, method, path: target, headers },
      (response) => {
        response.resume();
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    call.on('error', reject);
    call.end();
  });
}
