import { INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { Server } from '@modelcontextprotocol/server';

import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpHttpModule } from '@modules/mcp/mcp-http.module';
import { OAuthDiscoveryModule } from '@modules/oauth/oauth-discovery.module';
import { OAuthMcpModule } from '@modules/oauth/oauth-mcp.module';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { MCP_SESSION_SOURCE, McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import { MCP_HOST_CONFIG } from '@modules/toolset/config/mcp-host.config';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import { McpPathKind } from '@modules/toolset/domain/mcp-url';
import { AccessResolver } from '@modules/toolset/services/access.resolver';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { AgentScope } from '@shared/auth/agent-scope';
import { HealthcheckController } from '@shared/controllers/healthcheck.controller';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

import { SESSION } from './helpers/mcp-harness';

const TOKEN = 'test-agent-token';
/** Agent keys: one may call tools, one may only read its activity. */
const CALLER_KEY = 'test-agent-key-tools';
const READER_KEY = 'test-agent-key-reader';
const agentSession = (scopes: AgentScope[]): McpSession => ({
  ...SESSION,
  callerKind: McpCallerKind.AGENT,
  storedCredential: true,
  scopes,
});
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
              if (token === CALLER_KEY) return agentSession([AgentScope.TOOLS_CALL]);
              if (token === READER_KEY) return agentSession([AgentScope.ACTIVITY_READ]);
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
                {
                  capabilities: { tools: { listChanged: false } },
                  cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } },
                },
              );
              server.setRequestHandler('tools/list', async () => ({ tools: [] }));
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

    // The same order as `AppMcpModule`: OAuth and well-known routes first.
    // `OAuthDiscoveryModule` is the part of `OAuthMcpModule` that needs no
    // database, Redis or OAuth secret.
    const moduleRef = await Test.createTestingModule({
      imports: [OAuthDiscoveryModule, HostModule],
    })
      .overrideProvider(MCP_HOST_CONFIG)
      .useValue({ mcpPublicUrl: HOST, webAppUrl: WEB })
      .compile();
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

  describe('OAuth and well-known routes come before the catch-all (R-OA-29)', () => {
    it('AppMcpModule imports OAuthMcpModule before McpHttpModule', () => {
      const imports: unknown[] = Reflect.getMetadata('imports', AppMcpModule);
      const oauth = imports.indexOf(OAuthMcpModule);
      expect(oauth).toBeGreaterThanOrEqual(0);
      expect(oauth).toBeLessThan(imports.indexOf(McpHttpModule));
      const oauthImports: unknown[] = Reflect.getMetadata('imports', OAuthMcpModule);
      expect(oauthImports).toContain(OAuthDiscoveryModule);
    });

    it('/.well-known/oauth-protected-resource/c/weather reaches the metadata controller, not the catch-all', async () => {
      const response = await request(app.getHttpServer())
        .get('/.well-known/oauth-protected-resource/c/weather')
        // Even a browser's Accept: the catch-all would redirect it.
        .set('Accept', 'text/html,application/xhtml+xml');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        resource: `${HOST}/c/weather`,
        authorization_servers: [HOST],
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
    });

    /**
     * The RFC 9728 §3.3 invariant end to end (builder review IM-1): follow the
     * 401's `resource_metadata`, and the PRM it names has `resource` equal to
     * the URL the client asked for (without its query) — byte for byte, so a
     * strict client accepts it, mixed case included.
     */
    it.each([
      ['/c/weather', `${HOST}/c/weather`],
      ['/C/Weather', `${HOST}/C/Weather`],
      ['/%40acme/kit', `${HOST}/%40acme/kit`],
      ['/c/weather/', `${HOST}/c/weather/`],
      ['/my/Research?free=1', `${HOST}/my/Research`],
      ['/?free=1', HOST],
      ['/', HOST],
    ])('following the 401 challenge for %s leads to resource = %s', async (path, want) => {
      const challenged = await request(app.getHttpServer()).post(path).send({});
      expect(challenged.status).toBe(401);
      const header = challenged.headers['www-authenticate'];
      const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
      expect(metadataUrl).toBeDefined();
      expect(metadataUrl?.startsWith(`${HOST}/.well-known/oauth-protected-resource`)).toBe(true);

      const metadata = await request(app.getHttpServer()).get(
        (metadataUrl as string).slice(HOST.length),
      );
      expect(metadata.status).toBe(200);
      expect(metadata.body.resource).toBe(want);
    });

    it('/.well-known/oauth-authorization-server reaches the metadata controller', async () => {
      const response = await request(app.getHttpServer()).get(
        '/.well-known/oauth-authorization-server',
      );
      expect(response.status).toBe(200);
      expect(response.body.issuer).toBe(HOST);
    });

    it('/oauth/token is not an MCP URL', async () => {
      // No token route is mounted here (Task 1.11), so this is the catch-all:
      // a 404 before any token is read, never a 401 challenge.
      const response = await request(app.getHttpServer())
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code' });
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'MCP_URL_NOT_FOUND' } });
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    });

    it('/health still answers', async () => {
      const response = await request(app.getHttpServer()).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true });
    });
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

  it('an agent key needs tools:call: 403 AUTH_SCOPE_MISSING without it, before any URL or server', async () => {
    const call = (token: string) =>
      request(app.getHttpServer())
        .post('/')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    const refused = await call(READER_KEY);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: { code: 'AUTH_SCOPE_MISSING', context: { requiredScope: 'tools:call' } },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    const served = await call(CALLER_KEY);
    expect(served.status).toBe(200);
    expect(created).toHaveLength(1);
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

  describe('protocol eras (SDK v2, design spec §7.4)', () => {
    const MODERN_META = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };

    const post = (body: { method: string; [key: string]: unknown }, version?: string) => {
      const call = request(app.getHttpServer())
        .post('/')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json');
      if (version) call.set('MCP-Protocol-Version', version);
      // The 2026-07-28 revision names the method in a header as well.
      if (version === '2026-07-28') call.set('Mcp-Method', body.method);
      return call.send(body);
    };

    it('a 2026-07-28 client gets ttlMs and a private cache scope on tools/list', async () => {
      const response = await post(
        { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: MODERN_META } },
        '2026-07-28',
      );
      expect(response.status).toBe(200);
      expect(response.body.result).toMatchObject({
        tools: [],
        ttlMs: 60_000,
        cacheScope: 'private',
      });
    });

    it('server/discover advertises tools without list_changed', async () => {
      const response = await post(
        { jsonrpc: '2.0', id: 8, method: 'server/discover', params: { _meta: MODERN_META } },
        '2026-07-28',
      );
      expect(response.body.result).toMatchObject({
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: { listChanged: false } },
      });
    });

    it('an older client is served as before: JSON, no TTL, the same tools', async () => {
      const init = await post({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'old', version: '1' },
        },
      });
      expect(init.status).toBe(200);
      expect(init.headers['content-type']).toContain('application/json');
      expect(init.body.result).toMatchObject({
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
      });
      expect(init.headers['mcp-session-id']).toBeUndefined();

      const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '2025-11-25');
      expect(list.body.result).toEqual({ tools: [] });
    });

    it('GET and DELETE are 405: no stream, no session', async () => {
      for (const method of ['get', 'delete'] as const) {
        const response = await request(app.getHttpServer())
          [method]('/')
          .set('Authorization', `Bearer ${TOKEN}`)
          .set('Accept', 'text/event-stream');
        expect({ method, status: response.status }).toEqual({ method, status: 405 });
        expect(response.headers.allow).toBe('POST');
      }
    });

    it('a POST that is not JSON is 415', async () => {
      const response = await request(app.getHttpServer())
        .post('/')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Content-Type', 'text/plain')
        .send('hello');
      expect(response.status).toBe(415);
    });
  });
});
