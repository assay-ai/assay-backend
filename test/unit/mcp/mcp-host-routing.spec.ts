import { INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { MCP_SESSION_SOURCE, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import { MCP_HOST_CONFIG } from '@modules/toolset/config/mcp-host.config';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import { McpPathKind } from '@modules/toolset/domain/mcp-url';
import { AccessResolver } from '@modules/toolset/services/access.resolver';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { HealthcheckController } from '@shared/controllers/healthcheck.controller';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

import { SESSION } from './helpers/mcp-harness';

const TOKEN = 'test-agent-token';
const WEB = 'https://app.example.com';
const HOST = 'https://mcp.example.com';

/**
 * The MCP host (design spec §7.4): every path at the root is a server, the
 * browser check runs before authentication, an unknown path is a 404 before
 * a token is even read, and `/health` is not shadowed by the catch-all.
 */
describe('the MCP host — routing', () => {
  let app: INestApplication;
  const created: Array<{ session: McpSession; scope: McpScope }> = [];
  const resolve = jest.fn();

  beforeAll(async () => {
    @Module({
      controllers: [HealthcheckController, McpController],
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
          useValue: {
            create: (session: McpSession, scope: McpScope) => {
              created.push({ session, scope });
              const server = new Server(
                { name: 'assay', version: '0.1.0' },
                { capabilities: { tools: {} } },
              );
              server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
              return server;
            },
          },
        },
        { provide: McpEndpointResolver, useValue: { resolve } },
        {
          provide: AccessResolver,
          useValue: { resolve: async () => ({ agent: ALLOW_ALL, key: null }) },
        },
        { provide: MCP_HOST_CONFIG, useValue: { mcpPublicUrl: HOST, webAppUrl: WEB } },
      ],
    })
    class HostModule {}

    const moduleRef = await Test.createTestingModule({ imports: [HostModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    created.length = 0;
    resolve.mockReset();
    resolve.mockImplementation(async (_org: string, parsed: { path: { kind: McpPathKind } }) => {
      if (parsed.path.kind !== McpPathKind.ROOT) throw McpErrors.urlNotFound();
      return {
        canonicalUrl: `${HOST}/`,
        path: parsed.path,
        kind: 'ROOT',
        filter: { tools: null, categories: null, free: false, discovery: null },
        toolset: null,
        handle: null,
        baseToolIds: null,
        entryRules: new Map(),
      };
    });
  });

  const listTools = (path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

  it('serves MCP at the root of the host, with no /mcp prefix', async () => {
    const response = await listTools('/');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    expect(created[0].scope.view.canonicalUrl).toBe(`${HOST}/`);
    expect(created[0].scope.attribution).toMatchObject({ endpointKind: 'ROOT' });
  });

  it('the old /mcp path is gone', async () => {
    expect((await listTools('/mcp')).status).toBe(404);
  });

  it('keeps /health answering', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true });
  });

  it('redirects a browser to the web page, before authentication', async () => {
    const response = await request(app.getHttpServer())
      .get('/my/research?free=1')
      .set('Accept', 'text/html,application/xhtml+xml');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${WEB}/toolsets/mine?slug=research&free=1`);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('redirects a browser on an unknown path to the not-found page', async () => {
    const response = await request(app.getHttpServer())
      .get('/no/such/thing')
      .set('Accept', 'text/html');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${WEB}/catalogue/not-found`);
  });

  it('never redirects an MCP client: it sends text/event-stream on GET', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Accept', 'text/html, text/event-stream');
    expect(response.status).toBe(401);
  });

  it('answers 404 for a path that is not a form of the host, before reading a token', async () => {
    // An HTTP client resolves `%2e%2e` itself; the parser's own suite covers it.
    for (const path of ['/my/../etc', '//my/research', '/t/held', '/my/a%2Fb']) {
      const response = await request(app.getHttpServer()).post(path).send({});
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });

  it('answers 401 with no token, then 404 for a toolset this organization does not own', async () => {
    const anonymous = await request(app.getHttpServer()).post('/my/research').send({});
    expect(anonymous.status).toBe(401);

    const response = await listTools('/my/research');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'MCP_URL_NOT_FOUND' } });
    expect(created).toHaveLength(0);
  });

  it('normalises an encoded @ before resolving', async () => {
    await listTools('/%40acme/kit');
    expect(resolve).toHaveBeenCalledWith(
      SESSION.organizationId,
      expect.objectContaining({
        path: { kind: McpPathKind.PUBLIC_TOOLSET, handle: 'acme', slug: 'kit', version: null },
      }),
    );
  });
});
