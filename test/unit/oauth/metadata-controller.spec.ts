import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { MCP_DOCS_URL, authorizationServerMetadata } from '@modules/oauth/domain/metadata';
import { OAuthDiscoveryModule } from '@modules/oauth/oauth-discovery.module';
import { MCP_HOST_CONFIG } from '@modules/toolset/config/mcp-host.config';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

const MCP = 'https://mcp.example.com';
const WEB = 'https://app.example.com';

/**
 * The discovery documents and the built-in client document on the MCP host
 * (spec §6.3.1, §6.3.2, §6.3.6 item 3; R-OA-1, R-OA-2).
 */
describe('OAuth metadata controller', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [OAuthDiscoveryModule] })
      .overrideProvider(MCP_HOST_CONFIG)
      .useValue({ mcpPublicUrl: MCP, webAppUrl: WEB })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  const get = (path: string) => request(app.getHttpServer()).get(path);

  describe('protected resource metadata (RFC 9728)', () => {
    it('the bare form has resource = {MCP}', async () => {
      const response = await get('/.well-known/oauth-protected-resource');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        resource: MCP,
        authorization_servers: [MCP],
        scopes_supported: ['assay:agent'],
        bearer_methods_supported: ['header'],
        resource_name: 'Assay',
        resource_documentation: MCP_DOCS_URL,
      });
    });

    it('sends Cache-Control public, max-age=3600 on the PRM', async () => {
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/c/weather',
      ]) {
        const response = await get(path);
        expect({ path, cache: response.headers['cache-control'] }).toEqual({
          path,
          cache: 'public, max-age=3600',
        });
      }
    });

    it.each([
      ['/c/weather', `${MCP}/c/weather`],
      ['/my/research', `${MCP}/my/research`],
      ['/@acme/kit@3', `${MCP}/@acme/kit@3`],
      ['/%40acme/kit', `${MCP}/%40acme/kit`],
      ['/u/abcdefghijklmnopqrstuv', `${MCP}/u/abcdefghijklmnopqrstuv`],
      ['/c/weather/', `${MCP}/c/weather/`],
      ['/', MCP],
    ])('the path-inserted form %s has resource = %s (one value per path)', async (path, want) => {
      const response = await get(`/.well-known/oauth-protected-resource${path}`);
      expect(response.status).toBe(200);
      expect(response.body.resource).toBe(want);
    });

    it('drops the query from the resource', async () => {
      const bare = await get('/.well-known/oauth-protected-resource?tools=x');
      expect(bare.body.resource).toBe(MCP);
      const path = await get('/.well-known/oauth-protected-resource/c/weather?free=1');
      expect(path.body.resource).toBe(`${MCP}/c/weather`);
    });

    it.each([
      '/oauth/token',
      '/health',
      '/no/such/thing',
      '/my/a%2Fb',
      '/.well-known/oauth-authorization-server',
    ])('answers 404 for %s, which is no MCP URL', async (path) => {
      const response = await get(`/.well-known/oauth-protected-resource${path}`);
      expect(response.status).toBe(404);
      expect(response.body.resource).toBeUndefined();
    });
  });

  describe('authorization server metadata (RFC 8414)', () => {
    it('has issuer exactly MCP_PUBLIC_URL and the §6.3.2 fields', async () => {
      const response = await get('/.well-known/oauth-authorization-server');
      expect(response.status).toBe(200);
      expect(response.body.issuer).toBe(MCP);
      expect(response.body).toEqual(authorizationServerMetadata(MCP));
      expect(response.body).toMatchObject({
        authorization_endpoint: `${MCP}/oauth/authorize`,
        token_endpoint: `${MCP}/oauth/token`,
        registration_endpoint: `${MCP}/oauth/register`,
        revocation_endpoint: `${MCP}/oauth/revoke`,
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        service_documentation: MCP_DOCS_URL,
      });
    });

    it('openid-configuration 404', async () => {
      const response = await get('/.well-known/openid-configuration');
      expect(response.status).toBe(404);
      expect(response.body.issuer).toBeUndefined();
    });
  });

  describe('the built-in client document (§6.3.6 item 3)', () => {
    it('byte-equals §6.3.6 with {MCP} substituted', async () => {
      const response = await get('/oauth/clients/assay-mcp');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.text).toBe(
        '{"client_id":"https://mcp.example.com/oauth/clients/assay-mcp",' +
          '"client_name":"Assay app (assay-mcp)",' +
          '"redirect_uris":["http://127.0.0.1/callback"],' +
          '"token_endpoint_auth_method":"none",' +
          '"grant_types":["authorization_code","refresh_token"],' +
          '"response_types":["code"]}',
      );
    });
  });
});
