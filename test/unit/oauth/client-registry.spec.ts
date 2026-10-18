import { AppRole } from '@shared/app-role/app-role';
import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthConfig } from '@modules/oauth/config/oauth.config';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import {
  BUILTIN_CLIENT_DOCUMENT_NAME,
  OAuthClientRegistry,
  ResolvedClient,
  builtinClientDocument,
} from '@modules/oauth/services/oauth-client.registry';
import { EgressHttpClient } from '@shared/network/egress';

import { FakeEgressHttpClient } from '../auth/helpers/fake-egress';
import {
  CHATGPT_REDIRECT,
  Clock,
  FakeOAuthClientRepository,
  FakeOAuthRedis,
  MCP,
  fakeCache,
  oauthConfig,
  oauthMetrics,
  rateLimiter,
} from './helpers/oauth-fakes';

const BUILTIN = `${MCP}/oauth/clients/assay-mcp`;
const VERIFIED_URL = 'https://chatgpt.com/oauth/client.json';
const OTHER_URL = 'https://tools.example.com/client.json';
const IP = '203.0.113.7';
/** Cleared in the allowlist and listed as a vendor redirect, but not in the client's document. */
const OTHER_VENDOR_REDIRECT = 'https://chatgpt.com/other_redirect';

function cimdDocument(url: string, name: string, redirects: string[]) {
  return {
    client_id: url,
    client_name: name,
    redirect_uris: redirects,
    token_endpoint_auth_method: 'none',
  };
}

function setup(overrides: Partial<OAuthConfig> = {}, role?: AppRole) {
  const config = oauthConfig({
    verifiedClients: [
      {
        clientId: VERIFIED_URL,
        displayName: 'ChatGPT',
        vendorRedirects: [CHATGPT_REDIRECT, OTHER_VENDOR_REDIRECT],
      },
    ],
    redirectAllowlist: [
      { uri: CHATGPT_REDIRECT, review: false },
      { uri: OTHER_VENDOR_REDIRECT, review: false },
    ],
    ...overrides,
  });
  const egress = new FakeEgressHttpClient();
  egress.respondWith((request) => {
    const docs: Record<string, unknown> = {
      [VERIFIED_URL]: cimdDocument(VERIFIED_URL, 'ChatGPT (self-declared)', [
        CHATGPT_REDIRECT,
        'http://127.0.0.1/callback',
      ]),
      [OTHER_URL]: cimdDocument(OTHER_URL, 'Example Tools', ['http://127.0.0.1/cb']),
    };
    const doc = docs[request.url];
    const body = doc ? JSON.stringify(doc) : '';
    return {
      status: doc ? 200 : 404,
      headers: {},
      body,
      bytes: body.length,
      url: request.url,
      redirects: 0,
    };
  });
  const redis = new FakeOAuthRedis();
  const repo = new FakeOAuthClientRepository();
  const clock = new Clock();
  const { metrics } = oauthMetrics();
  const limiter = rateLimiter(redis, clock);
  const fetcher = new CimdFetcher(
    egress as unknown as EgressHttpClient,
    repo as unknown as OAuthClientRepository,
    limiter,
    fakeCache(redis),
    metrics,
    config,
    clock.now,
  );
  const registry = new OAuthClientRegistry(
    repo as unknown as OAuthClientRepository,
    fetcher,
    config,
    role,
  );
  return { registry, repo, egress, redis };
}

async function resolved(registry: OAuthClientRegistry, clientId: string): Promise<ResolvedClient> {
  const result = await registry.resolve(clientId, IP);
  if ('error' in result) throw new Error(`expected a client, got ${result.error}`);
  return result;
}

describe('OAuthClientRegistry (§6.3.6)', () => {
  describe('boot', () => {
    it('upserts the BUILTIN row', async () => {
      const { registry, repo } = setup();
      await registry.onModuleInit();
      await registry.onModuleInit();

      const row = repo.rows.get(BUILTIN)!;
      expect(row.kind).toBe(OAuthClientKind.BUILTIN);
      expect(row.clientName).toBe('Assay app (assay-mcp)');
      expect(row.redirectUris).toEqual(['http://127.0.0.1/callback']);
      expect(row.metadata).toEqual(builtinClientDocument(MCP));
      expect(repo.rows.size).toBeGreaterThanOrEqual(1);
    });

    it('serves the §6.3.6 document for the built-in client', () => {
      expect(builtinClientDocument(MCP)).toEqual({
        client_id: BUILTIN,
        client_name: BUILTIN_CLIENT_DOCUMENT_NAME,
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    });

    it('pre-warms the verified clients’ CIMD documents', async () => {
      const { registry, repo, egress } = setup();
      await registry.onModuleInit();
      await registry.prewarm();
      expect(repo.rows.get(VERIFIED_URL)?.kind).toBe(OAuthClientKind.CIMD);
      expect(egress.requests.map((r) => r.url)).toContain(VERIFIED_URL);
    });

    it('pre-warms only on the MCP app: the API app makes no outbound call at boot', async () => {
      const api = setup({}, 'api');
      await api.registry.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));
      expect(api.egress.requests).toEqual([]);
      // The built-in row is still upserted: the consent API reads it.
      expect(api.repo.rows.get(BUILTIN)?.kind).toBe(OAuthClientKind.BUILTIN);

      const mcp = setup({}, 'mcp');
      await mcp.registry.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));
      expect(mcp.egress.requests.map((r) => r.url)).toContain(VERIFIED_URL);
    });

    it('a failed pre-warm does not fail the boot', async () => {
      const { registry, egress } = setup({
        verifiedClients: [
          {
            clientId: 'https://down.example.com/c.json',
            displayName: 'Down',
            vendorRedirects: [CHATGPT_REDIRECT],
          },
        ],
      });
      await expect(registry.onModuleInit()).resolves.toBeUndefined();
      await expect(registry.prewarm()).resolves.toBeUndefined();
      expect(egress.requests.length).toBeGreaterThan(0);
    });
  });

  describe('resolve', () => {
    it('BUILTIN is resolved in process, with no fetch', async () => {
      const { registry, egress } = setup();
      await registry.onModuleInit();
      const client = await resolved(registry, BUILTIN);
      expect(client).toMatchObject({
        clientId: BUILTIN,
        kind: OAuthClientKind.BUILTIN,
        name: 'Assay app (assay-mcp)',
        redirectUris: ['http://127.0.0.1/callback'],
        verifiedDisplayName: null,
        vendorRedirects: [],
      });
      expect(client.id).toEqual(expect.any(String));
      // The only fetch is the boot pre-warm of the verified client.
      expect(egress.requests.map((request) => request.url)).not.toContain(BUILTIN);
    });

    it('a DCR id resolves to its row, an unregistered one is client_unknown', async () => {
      const { registry, repo } = setup();
      const row = await repo.upsertByClientId({
        clientId: 'dcr_' + 'a'.repeat(22),
        kind: OAuthClientKind.DCR,
        clientName: 'Editor',
        clientUri: null,
        redirectUris: ['http://127.0.0.1/cb'],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
      });
      expect(await resolved(registry, row.clientId)).toMatchObject({
        id: row.id,
        kind: OAuthClientKind.DCR,
        name: 'Editor',
      });
      expect(await registry.resolve('dcr_' + 'b'.repeat(22), IP)).toEqual({
        error: 'client_unknown',
      });
    });

    it('a CIMD row is never answered for a dcr_ id, nor the reverse', async () => {
      const { registry, repo } = setup();
      await repo.upsertByClientId({
        clientId: 'dcr_' + 'c'.repeat(22),
        kind: OAuthClientKind.CIMD,
        clientName: 'Odd',
        clientUri: null,
        redirectUris: ['http://127.0.0.1/cb'],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
      });
      expect(await registry.resolve('dcr_' + 'c'.repeat(22), IP)).toEqual({
        error: 'client_unknown',
      });
    });

    it('a CIMD URL is fetched; a bad document is client_metadata_invalid', async () => {
      const { registry } = setup();
      expect(await resolved(registry, OTHER_URL)).toMatchObject({
        kind: OAuthClientKind.CIMD,
        name: 'Example Tools',
        verifiedDisplayName: null,
      });
      expect(await registry.resolve('https://missing.example.com/c.json', IP)).toEqual({
        error: 'client_metadata_invalid',
      });
    });

    it('anything else is client_unknown, with no fetch', async () => {
      const { registry, egress } = setup();
      for (const id of [
        'not a url',
        'https://203.0.113.9/c.json',
        'https://tools.example.com/',
        'https://tools.example.com:8443/c.json',
        `${MCP}/oauth/clients/other`,
        'http://localhost:4100/client.json',
      ]) {
        expect(await registry.resolve(id, IP)).toEqual({ error: 'client_unknown' });
      }
      expect(egress.requests).toHaveLength(0);
    });

    it('a verified client carries its display name and vendor redirects', async () => {
      const { registry } = setup();
      expect(await resolved(registry, VERIFIED_URL)).toMatchObject({
        name: 'ChatGPT (self-declared)',
        verifiedDisplayName: 'ChatGPT',
        vendorRedirects: [CHATGPT_REDIRECT, OTHER_VENDOR_REDIRECT],
      });
    });
  });

  describe('displayFor', () => {
    it('verified only with vendor redirect', async () => {
      const { registry } = setup();
      const client = await resolved(registry, VERIFIED_URL);
      expect(registry.displayFor(client, CHATGPT_REDIRECT)).toEqual({
        name: 'ChatGPT',
        verified: true,
        builtin: false,
        registrableDomain: 'chatgpt.com',
        host: 'chatgpt.com',
        returnTo: { kind: 'WEB', display: 'chatgpt.com' },
      });
    });

    it('same client with loopback → verified false', async () => {
      const { registry } = setup();
      const client = await resolved(registry, VERIFIED_URL);
      expect(registry.displayFor(client, 'http://127.0.0.1:51234/callback')).toEqual({
        name: 'ChatGPT (self-declared)',
        verified: false,
        builtin: false,
        registrableDomain: 'chatgpt.com',
        host: 'chatgpt.com',
        returnTo: { kind: 'LOCAL_APP', display: 'an app on this computer' },
      });
    });

    it('an unlisted client is never verified, even on an allowlisted redirect', async () => {
      const { registry } = setup();
      const client = await resolved(registry, OTHER_URL);
      const display = registry.displayFor(client, CHATGPT_REDIRECT);
      expect(display.verified).toBe(false);
      expect(display.name).toBe('Example Tools');
      expect(display.registrableDomain).toBe('example.com');
      expect(display.host).toBe('tools.example.com');
    });

    it('builtin always verified false, builtin true', async () => {
      const { registry } = setup({
        verifiedClients: [
          { clientId: BUILTIN, displayName: 'Assay', vendorRedirects: [CHATGPT_REDIRECT] },
        ],
      });
      await registry.onModuleInit();
      const client = await resolved(registry, BUILTIN);
      for (const redirect of ['http://127.0.0.1:40001/callback', CHATGPT_REDIRECT]) {
        const display = registry.displayFor(client, redirect);
        expect(display.verified).toBe(false);
        expect(display.builtin).toBe(true);
        expect(display.name).toBe('Assay app (assay-mcp)');
      }
    });

    it('a DCR client has no proven domain', async () => {
      const { registry, repo } = setup();
      await repo.upsertByClientId({
        clientId: 'dcr_' + 'd'.repeat(22),
        kind: OAuthClientKind.DCR,
        clientName: 'Editor',
        clientUri: 'https://editor.example.com',
        redirectUris: ['http://127.0.0.1/cb'],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
      });
      const client = await resolved(registry, 'dcr_' + 'd'.repeat(22));
      expect(registry.displayFor(client, 'http://localhost:9000/cb')).toMatchObject({
        verified: false,
        builtin: false,
        registrableDomain: null,
        host: null,
        returnTo: { kind: 'LOCAL_APP', display: 'an app on this computer' },
      });
    });

    it('a private-use scheme returns to a local app', async () => {
      const { registry } = setup();
      const client = await resolved(registry, OTHER_URL);
      expect(
        registry.displayFor(client, 'cursor://anysphere.cursor-mcp/oauth/callback').returnTo,
      ).toEqual({ kind: 'LOCAL_APP', display: 'an app on this computer' });
    });
  });

  describe('review fixes', () => {
    it('not verified for a vendor redirect the client did not register (M3)', async () => {
      const { registry } = setup();
      const client = await resolved(registry, VERIFIED_URL);
      expect(client.redirectUris).not.toContain(OTHER_VENDOR_REDIRECT);
      const display = registry.displayFor(client, OTHER_VENDOR_REDIRECT);
      expect(display.verified).toBe(false);
      expect(display.name).toBe('ChatGPT (self-declared)');
    });

    it('a DCR client listed as verified by mistake is never verified (M2)', async () => {
      const dcrId = 'dcr_' + 'e'.repeat(22);
      const { registry, repo } = setup({
        verifiedClients: [
          { clientId: dcrId, displayName: 'Trusted', vendorRedirects: [CHATGPT_REDIRECT] },
        ],
      });
      await repo.insertClient({
        clientId: dcrId,
        kind: OAuthClientKind.DCR,
        clientName: 'Trusted',
        clientUri: null,
        redirectUris: [CHATGPT_REDIRECT],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
      });
      const client = await resolved(registry, dcrId);
      expect(client.verifiedDisplayName).toBeNull();
      expect(registry.displayFor(client, CHATGPT_REDIRECT).verified).toBe(false);
    });

    it('the boot refuses when the built-in URL is held by a client of another kind (M4)', async () => {
      const { registry, repo } = setup();
      await repo.insertClient({
        clientId: BUILTIN,
        kind: OAuthClientKind.CIMD,
        clientName: 'Squatter',
        clientUri: null,
        redirectUris: ['http://127.0.0.1/cb'],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
      });
      await expect(registry.onModuleInit()).rejects.toThrow(/non-BUILTIN/);
      expect(repo.rows.get(BUILTIN)!.kind).toBe(OAuthClientKind.CIMD);
    });
  });

  describe('isPaymentClient', () => {
    it('only the built-in client', () => {
      const { registry } = setup();
      expect(registry.isPaymentClient(BUILTIN)).toBe(true);
      expect(registry.isPaymentClient(VERIFIED_URL)).toBe(false);
      expect(registry.isPaymentClient('dcr_' + 'a'.repeat(22))).toBe(false);
      expect(registry.isPaymentClient(`${BUILTIN}/`)).toBe(false);
    });
  });
});
