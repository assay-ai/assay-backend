import { randomBytes, randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAUTH_CONFIG, OAuthConfig } from '@modules/oauth/config/oauth.config';
import { OAuthAuthorizeController } from '@modules/oauth/controllers/oauth-authorize.controller';
import { OAuthRegisterController } from '@modules/oauth/controllers/oauth-register.controller';
import { OAuthRevokeController } from '@modules/oauth/controllers/oauth-revoke.controller';
import { OAuthTokenController } from '@modules/oauth/controllers/oauth-token.controller';
import {
  REQUEST_COOKIE_NAME,
  readRequestCookie,
  requestCookieMatches,
  requestCookieValue,
} from '@modules/oauth/domain/request-cookie';
import { DcrService } from '@modules/oauth/services/dcr.service';
import { OAuthClientRegistry, ResolvedClient } from '@modules/oauth/services/oauth-client.registry';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { OAuthRateLimiter } from '@modules/oauth/services/oauth-rate-limiter.service';
import {
  NewOAuthPendingRequest,
  OAuthPendingRequest,
  OAuthRequestStore,
} from '@modules/oauth/services/oauth-request.store';
import { OAuthTokenService } from '@modules/oauth/services/oauth-token.service';
import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

import {
  Clock,
  FakeOAuthRedis,
  MCP,
  counterValue,
  oauthConfig,
  rateLimiter,
} from './helpers/oauth-fakes';

const WEB = 'https://app.assay.ai';
const BUILTIN_ID = `${MCP}/oauth/clients/assay-mcp`;
const CIMD_ID = 'https://tools.example.com/client.json';
const LOOPBACK = 'http://127.0.0.1/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function client(kind: OAuthClientKind, clientId: string): ResolvedClient {
  return {
    id: randomUUID(),
    clientId,
    kind,
    name: 'Test client',
    clientUri: null,
    redirectUris: [LOOPBACK],
    verifiedDisplayName: null,
    vendorRedirects: [],
  };
}

/** The pending-request store, in memory. */
class FakeStore {
  readonly requests = new Map<string, OAuthPendingRequest>();
  failCreate = false;
  takes = 0;

  create(input: NewOAuthPendingRequest): Promise<string> {
    if (this.failCreate) return Promise.reject(new Error('redis down'));
    const rid = randomBytes(32).toString('base64url');
    this.requests.set(rid, {
      ...input,
      createdAt: new Date().toISOString(),
      boundOrganizationId: null,
      approval: null,
      denied: false,
    });
    return Promise.resolve(rid);
  }

  take(rid: string): Promise<OAuthPendingRequest | null> {
    this.takes += 1;
    const found = this.requests.get(rid) ?? null;
    this.requests.delete(rid);
    return Promise.resolve(found);
  }

  approve(rid: string): void {
    const found = this.requests.get(rid)!;
    this.requests.set(rid, {
      ...found,
      boundOrganizationId: randomUUID(),
      approval: { agentId: randomUUID(), name: 'n', approvedBy: randomUUID(), replaces: null },
    });
  }

  deny(rid: string): void {
    const found = this.requests.get(rid)!;
    this.requests.set(rid, { ...found, boundOrganizationId: randomUUID(), denied: true });
  }
}

describe('OAuth endpoints on the MCP host (controllers)', () => {
  let app: INestApplication;
  let config: OAuthConfig;
  let store: FakeStore;
  let redis: FakeOAuthRedis;
  let clock: Clock;
  let registry: MetricsRegistryService;
  let tokens: {
    mintCode: jest.Mock;
    exchangeCode: jest.Mock;
    refresh: jest.Mock;
    revoke: jest.Mock;
  };
  let touched: string[];
  let dcrRegister: jest.Mock;
  const builtin = client(OAuthClientKind.BUILTIN, BUILTIN_ID);
  const cimd = client(OAuthClientKind.CIMD, CIMD_ID);

  async function build(overrides: Partial<OAuthConfig> = {}): Promise<void> {
    config = oauthConfig({ webAppUrl: WEB, ...overrides });
    store = new FakeStore();
    redis = new FakeOAuthRedis();
    clock = new Clock();
    registry = new MetricsRegistryService();
    touched = [];
    tokens = {
      mintCode: jest.fn().mockResolvedValue('assay_ac_code'),
      exchangeCode: jest.fn(),
      refresh: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    dcrRegister = jest.fn();
    const resolve = jest.fn(async (clientId: string) => {
      if (clientId === BUILTIN_ID) return builtin;
      if (clientId === CIMD_ID) return cimd;
      if (clientId === 'https://broken.example.com/client.json') {
        return { error: 'client_metadata_invalid' };
      }
      return { error: 'client_unknown' };
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [
        OAuthAuthorizeController,
        OAuthTokenController,
        OAuthRegisterController,
        OAuthRevokeController,
      ],
      providers: [
        { provide: OAUTH_CONFIG, useValue: config },
        { provide: OAuthClientRegistry, useValue: { resolve } },
        { provide: OAuthRequestStore, useValue: store },
        { provide: OAuthTokenService, useValue: tokens },
        { provide: OAuthRateLimiter, useValue: rateLimiter(redis, clock) },
        { provide: OAuthMetrics, useValue: new OAuthMetrics(registry) },
        {
          provide: OAuthClientRepository,
          useValue: {
            touchLastUsed: async (id: string) => {
              touched.push(id);
            },
          },
        },
        { provide: DcrService, useValue: { register: dcrRegister } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }

  afterEach(async () => app?.close());

  function authorizeQuery(overrides: Record<string, string | undefined> = {}) {
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: BUILTIN_ID,
      redirect_uri: 'http://127.0.0.1:53111/callback',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'st-1',
      ...overrides,
    };
    const defined = Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return `/oauth/authorize?${new URLSearchParams(defined)}`;
  }

  const authorize = (overrides: Record<string, string | undefined> = {}) =>
    request(app.getHttpServer()).get(authorizeQuery(overrides));

  function query(location: string): URLSearchParams {
    return new URL(location).searchParams;
  }

  /** Runs a successful authorize and returns the rid and this browser's cookie. */
  async function started(): Promise<{ rid: string; cookie: string }> {
    const response = await authorize();
    expect(response.status).toBe(302);
    const rid = /#request=(.+)$/.exec(response.headers.location)![1];
    const setCookie = (response.headers['set-cookie'] as unknown as string[])[0];
    return { rid, cookie: setCookie.split(';')[0] };
  }

  const resume = (rid: string, cookie?: string) => {
    const call = request(app.getHttpServer()).get(
      `/oauth/authorize/continue?request=${encodeURIComponent(rid)}`,
    );
    return cookie ? call.set('Cookie', cookie) : call;
  };

  describe('GET /oauth/authorize', () => {
    beforeEach(() => build());

    it('stores the request, sets the browser cookie, sends the person to consent with #request=', async () => {
      const response = await authorize({ assay_device: 'Work Mac', scope: 'offline_access x' });
      expect(response.status).toBe(302);
      const location: string = response.headers.location;
      expect(location.startsWith(`${WEB}/connect/authorize#request=`)).toBe(true);
      expect(new URL(location).search).toBe('');
      expect(response.headers['cache-control']).toBe('no-store');

      const rid = /#request=(.+)$/.exec(location)![1];
      const stored = store.requests.get(rid)!;
      expect(stored).toMatchObject({
        oauthClientId: builtin.id,
        redirectUri: 'http://127.0.0.1:53111/callback',
        codeChallenge: CHALLENGE,
        scope: 'assay:agent offline_access',
        state: 'st-1',
        device: 'Work Mac',
        replaces: null,
      });

      const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toBe(
        `${REQUEST_COOKIE_NAME}=${requestCookieValue(config.requestCookieSecret!, rid)}; ` +
          'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600',
      );
      expect(cookie).not.toContain(rid);
      expect(
        await counterValue(registry, 'assay_oauth_authorize_total', { outcome: 'stored' }),
      ).toBe(1);
    });

    it('stamps the client last_used_at', async () => {
      await authorize();
      expect(touched).toEqual([builtin.id]);
    });

    it('honours assay_device and assay_replaces for the built-in client only', async () => {
      const replaces = randomUUID();
      await authorize({ assay_replaces: replaces });
      const own = [...store.requests.values()][0];
      expect(own.replaces).toBe(replaces);

      store.requests.clear();
      await authorize({
        client_id: CIMD_ID,
        redirect_uri: LOOPBACK,
        assay_device: 'x',
        assay_replaces: replaces,
      });
      const other = [...store.requests.values()][0];
      expect(other).toMatchObject({ device: null, replaces: null });
    });

    it('drops an assay_replaces that is not a credential id, and an over-long device label', async () => {
      await authorize({ assay_replaces: 'not-a-uuid', assay_device: 'd'.repeat(33) });
      expect([...store.requests.values()][0]).toMatchObject({ replaces: null, device: null });
    });

    it.each([
      ['an unknown client', { client_id: 'nobody' }, 'client_unknown'],
      ['no client', { client_id: undefined }, 'client_unknown'],
      [
        'a CIMD client whose document is bad',
        { client_id: 'https://broken.example.com/client.json' },
        'client_metadata_invalid',
      ],
      [
        'an unregistered redirect',
        { redirect_uri: 'http://127.0.0.1/other' },
        'redirect_uri_mismatch',
      ],
      ['no redirect', { redirect_uri: undefined }, 'redirect_uri_mismatch'],
      [
        'an attacker redirect',
        { redirect_uri: 'https://evil.example/cb' },
        'redirect_uri_mismatch',
      ],
    ])(
      '%s goes to {WEB}/connect/authorize-error, never to the client',
      async (_n, over, reason) => {
        const response = await authorize(over);
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`${WEB}/connect/authorize-error?reason=${reason}`);
        expect(store.requests.size).toBe(0);
        expect(
          await counterValue(registry, 'assay_oauth_authorize_total', { outcome: reason }),
        ).toBe(1);
      },
    );

    it('a repeated redirect_uri is a mismatch, never redirected to', async () => {
      const response = await request(app.getHttpServer()).get(
        `${authorizeQuery()}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
      );
      expect(response.headers.location).toBe(
        `${WEB}/connect/authorize-error?reason=redirect_uri_mismatch`,
      );
    });

    it.each([
      ['no code_challenge', { code_challenge: undefined }, 'invalid_request'],
      ['a short code_challenge', { code_challenge: 'abc' }, 'invalid_request'],
      ['code_challenge_method=plain', { code_challenge_method: 'plain' }, 'invalid_request'],
      ['no code_challenge_method', { code_challenge_method: undefined }, 'invalid_request'],
      ['response_type=token', { response_type: 'token' }, 'invalid_request'],
      ['a resource on another origin', { resource: 'https://evil.example' }, 'invalid_target'],
    ])('%s → redirect with error, description, state and iss', async (_n, over, error) => {
      const response = await authorize(over);
      expect(response.status).toBe(302);
      const location: string = response.headers.location;
      expect(location.startsWith('http://127.0.0.1:53111/callback?')).toBe(true);
      const params = query(location);
      expect(params.get('error')).toBe(error);
      expect(params.get('error_description')).toBeTruthy();
      expect(params.get('state')).toBe('st-1');
      expect(params.get('iss')).toBe(MCP);
      expect(store.requests.size).toBe(0);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('a state longer than 512 characters is refused and not echoed', async () => {
      const response = await authorize({ state: 's'.repeat(513) });
      const params = query(response.headers.location);
      expect(params.get('error')).toBe('invalid_request');
      expect(params.has('state')).toBe(false);
      expect(params.get('iss')).toBe(MCP);
    });

    it('a resource at {MCP} with a path is accepted', async () => {
      const response = await authorize({ resource: `${MCP}/c/weather` });
      expect(response.headers.location.startsWith(`${WEB}/connect/authorize#request=`)).toBe(true);
    });

    it('a store failure answers temporarily_unavailable to the client', async () => {
      store.failCreate = true;
      const response = await authorize();
      const params = query(response.headers.location);
      expect(params.get('error')).toBe('temporarily_unavailable');
      expect(params.get('iss')).toBe(MCP);
      expect(touched).toEqual([]);
    });

    it('the 31st authorize in a minute from one address is a 429 page with Retry-After', async () => {
      for (let i = 0; i < 30; i += 1) {
        expect((await authorize()).status).toBe(302);
      }
      const response = await authorize();
      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toMatch(/^\d+$/);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(
        await counterValue(registry, 'assay_oauth_authorize_total', { outcome: 'rate_limited' }),
      ).toBe(1);
    });

    it('with Redis down the limiter fails closed: nothing is stored', async () => {
      redis.down = true;
      const response = await authorize();
      expect(response.status).toBe(503);
      expect(store.requests.size).toBe(0);
    });
  });

  describe('GET /oauth/authorize/continue', () => {
    beforeEach(() => build());

    it('approved, in the same browser: mints the code and redirects with code, state, iss', async () => {
      const { rid, cookie } = await started();
      store.approve(rid);
      const response = await resume(rid, cookie);
      expect(response.status).toBe(302);
      const params = query(response.headers.location);
      expect(response.headers.location.startsWith('http://127.0.0.1:53111/callback?')).toBe(true);
      expect(params.get('code')).toBe('assay_ac_code');
      expect(params.get('state')).toBe('st-1');
      expect(params.get('iss')).toBe(MCP);
      expect(tokens.mintCode).toHaveBeenCalledTimes(1);
      // The cookie is cleared.
      expect((response.headers['set-cookie'] as unknown as string[])[0]).toMatch(
        new RegExp(`^${REQUEST_COOKIE_NAME}=; .*Max-Age=0`),
      );
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('denied: redirects with error=access_denied, state, iss and no code', async () => {
      const { rid, cookie } = await started();
      store.deny(rid);
      const response = await resume(rid, cookie);
      const params = query(response.headers.location);
      expect(params.get('error')).toBe('access_denied');
      expect(params.get('state')).toBe('st-1');
      expect(params.get('iss')).toBe(MCP);
      expect(params.has('code')).toBe(false);
      expect(tokens.mintCode).not.toHaveBeenCalled();
    });

    it('without the cookie: the error page, the request left in place, counted', async () => {
      const { rid } = await started();
      store.approve(rid);
      const response = await resume(rid);
      expect(response.status).toBe(403);
      expect(response.text).toContain('Finish this in the browser window where you started it');
      expect(store.requests.has(rid)).toBe(true);
      expect(store.takes).toBe(0);
      expect(tokens.mintCode).not.toHaveBeenCalled();
      expect(
        await counterValue(registry, 'assay_oauth_consent_total', {
          step: 'continue_cookie_missing',
        }),
      ).toBe(1);
    });

    it("with another browser's cookie: the error page, no code", async () => {
      const first = await started();
      const second = await started();
      store.approve(first.rid);
      const response = await resume(first.rid, second.cookie);
      expect(response.status).toBe(403);
      expect(response.text).toContain('Finish this in the browser window where you started it');
      expect(tokens.mintCode).not.toHaveBeenCalled();
    });

    it('a cookie sent twice is refused', async () => {
      const { rid, cookie } = await started();
      store.approve(rid);
      const response = await resume(rid, `${cookie}; ${cookie}`);
      expect(response.status).toBe(403);
    });

    it('refuses when the request-cookie secret is null (not the MCP app): nothing taken, no code', async () => {
      await app.close();
      await build({ requestCookieSecret: null });
      const rid = randomBytes(32).toString('base64url');
      store.requests.set(rid, {
        oauthClientId: builtin.id,
        redirectUri: LOOPBACK,
        codeChallenge: CHALLENGE,
        scope: 'assay:agent',
        state: null,
        device: null,
        replaces: null,
        createdAt: new Date().toISOString(),
        boundOrganizationId: null,
        approval: null,
        denied: false,
      });
      store.approve(rid);
      // A cookie a browser could hold from an app that did have a secret.
      const cookie = `${REQUEST_COOKIE_NAME}=${requestCookieValue(Buffer.alloc(32, 7), rid)}`;

      const response = await resume(rid, cookie);
      expect(response.status).toBe(503);
      expect(response.headers.location).toBeUndefined();
      expect(store.takes).toBe(0);
      expect(store.requests.has(rid)).toBe(true);
      expect(tokens.mintCode).not.toHaveBeenCalled();
    });

    it('authorize with a null secret binds no browser: temporarily_unavailable, nothing stored', async () => {
      await app.close();
      await build({ requestCookieSecret: null });
      const response = await authorize();
      expect(query(response.headers.location).get('error')).toBe('temporarily_unavailable');
      expect(store.requests.size).toBe(0);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('a taken request neither approved nor denied is an error: no redirect, no code', async () => {
      const { rid, cookie } = await started();
      const response = await resume(rid, cookie);
      expect(response.status).toBe(409);
      expect(response.headers.location).toBeUndefined();
      expect(tokens.mintCode).not.toHaveBeenCalled();
      expect(store.requests.has(rid)).toBe(false);
    });

    it('an expired or used request: the expired page', async () => {
      const { rid, cookie } = await started();
      store.approve(rid);
      expect((await resume(rid, cookie)).status).toBe(302);
      const again = await resume(rid, cookie);
      expect(again.status).toBe(404);
      expect(tokens.mintCode).toHaveBeenCalledTimes(1);
    });

    it('a malformed request id never reaches the store', async () => {
      const response = await resume('short');
      expect(response.status).toBe(404);
      expect(store.takes).toBe(0);
    });

    it('a failed mint answers temporarily_unavailable to the client', async () => {
      const { rid, cookie } = await started();
      store.approve(rid);
      tokens.mintCode.mockRejectedValueOnce(new Error('db down'));
      const response = await resume(rid, cookie);
      const params = query(response.headers.location);
      expect(params.get('error')).toBe('temporarily_unavailable');
      expect(params.get('iss')).toBe(MCP);
      expect(params.has('code')).toBe(false);
    });
  });

  describe('POST /oauth/token', () => {
    beforeEach(() => build());

    const token = (form: Record<string, string>) =>
      request(app.getHttpServer()).post('/oauth/token').type('form').send(form);

    const exchange = (over: Record<string, string> = {}) =>
      token({
        grant_type: 'authorization_code',
        code: 'assay_ac_x',
        redirect_uri: LOOPBACK,
        client_id: BUILTIN_ID,
        code_verifier: VERIFIER,
        ...over,
      });

    const pair = {
      access_token: 'assay_at_a',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'assay_rt_r',
      scope: 'assay:agent',
    };

    it('answers the pair with Cache-Control no-store and Pragma no-cache, counted ok', async () => {
      tokens.exchangeCode.mockResolvedValue(pair);
      const response = await exchange();
      expect(response.status).toBe(200);
      expect(response.body).toEqual(pair);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(tokens.exchangeCode).toHaveBeenCalledWith({
        code: 'assay_ac_x',
        redirectUri: LOOPBACK,
        clientId: BUILTIN_ID,
        codeVerifier: VERIFIER,
        resource: undefined,
      });
      expect(
        await counterValue(registry, 'assay_oauth_token_total', {
          grant_type: 'authorization_code',
          result: 'ok',
        }),
      ).toBe(1);
    });

    it('a malformed verifier is invalid_request, checked before the code is burned', async () => {
      const response = await exchange({ code_verifier: 'short' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
      expect(tokens.exchangeCode).not.toHaveBeenCalled();
      expect(
        await counterValue(registry, 'assay_oauth_token_total', {
          grant_type: 'authorization_code',
          result: 'invalid_request',
        }),
      ).toBe(1);
    });

    it.each([
      ['no code', { code: '' }],
      ['no redirect_uri', { redirect_uri: '' }],
      ['no client_id', { client_id: '' }],
    ])('%s is invalid_request', async (_n, over) => {
      const response = await exchange(over);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
      expect(tokens.exchangeCode).not.toHaveBeenCalled();
    });

    it('a JSON body is invalid_request', async () => {
      const response = await request(app.getHttpServer())
        .post('/oauth/token')
        .send({ grant_type: 'authorization_code' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
    });

    it('a repeated parameter is invalid_request', async () => {
      const response = await request(app.getHttpServer())
        .post('/oauth/token')
        .type('form')
        .send(
          'grant_type=authorization_code&code=a&code=b&client_id=c&redirect_uri=d&code_verifier=' +
            VERIFIER,
        );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
    });

    it('no grant_type is invalid_request; another is unsupported_grant_type, counted as other', async () => {
      expect((await token({ client_id: BUILTIN_ID })).body).toEqual({ error: 'invalid_request' });
      const response = await token({ grant_type: 'password', client_id: BUILTIN_ID });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'unsupported_grant_type' });
      expect(
        await counterValue(registry, 'assay_oauth_token_total', {
          grant_type: 'other',
          result: 'unsupported_grant_type',
        }),
      ).toBe(1);
    });

    it('the service errors keep their RFC shape and status', async () => {
      tokens.exchangeCode.mockResolvedValueOnce({ error: 'invalid_grant' });
      const grant = await exchange();
      expect(grant.status).toBe(400);
      expect(grant.body).toEqual({ error: 'invalid_grant' });
      expect(grant.headers['cache-control']).toBe('no-store');

      tokens.exchangeCode.mockResolvedValueOnce({ error: 'invalid_client' });
      expect((await exchange()).status).toBe(401);
    });

    it('refresh: a grace-write failure is 503 temporarily_unavailable', async () => {
      tokens.refresh.mockResolvedValue({ error: 'temporarily_unavailable' });
      const response = await token({
        grant_type: 'refresh_token',
        refresh_token: 'assay_rt_x',
        client_id: BUILTIN_ID,
      });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'temporarily_unavailable' });
      expect(tokens.refresh).toHaveBeenCalledWith({
        refreshToken: 'assay_rt_x',
        clientId: BUILTIN_ID,
        scope: undefined,
      });
      expect(
        await counterValue(registry, 'assay_oauth_token_total', {
          grant_type: 'refresh_token',
          result: 'temporarily_unavailable',
        }),
      ).toBe(1);
    });

    it('refresh without the token is invalid_request', async () => {
      const response = await token({ grant_type: 'refresh_token', client_id: BUILTIN_ID });
      expect(response.body).toEqual({ error: 'invalid_request' });
      expect(tokens.refresh).not.toHaveBeenCalled();
    });

    it('an unexpected failure is a 500 server_error that does not reach the platform filter', async () => {
      tokens.exchangeCode.mockRejectedValueOnce(new Error('secret-bearing message assay_ac_x'));
      const response = await exchange();
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'server_error' });
      expect(response.text).not.toContain('assay_ac_x');
    });

    it('the 61st request in a minute for one client and address is 429 with Retry-After', async () => {
      tokens.exchangeCode.mockResolvedValue({ error: 'invalid_grant' });
      for (let i = 0; i < 60; i += 1) expect((await exchange()).status).toBe(400);
      const response = await exchange();
      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toMatch(/^\d+$/);
      expect(
        await counterValue(registry, 'assay_oauth_token_total', {
          grant_type: 'authorization_code',
          result: 'rate_limited',
        }),
      ).toBe(1);
      // Another client from the same address has its own budget.
      expect((await exchange({ client_id: CIMD_ID })).status).toBe(400);
    });
  });

  describe('POST /oauth/register', () => {
    beforeEach(() => build());

    it('201 with no-store on success', async () => {
      dcrRegister.mockResolvedValue({ ok: true, body: { client_id: 'dcr_x' } });
      const response = await request(app.getHttpServer())
        .post('/oauth/register')
        .send({ redirect_uris: [LOOPBACK], client_name: 'VS Code' });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ client_id: 'dcr_x' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(dcrRegister.mock.calls[0][0]).toEqual({
        redirect_uris: [LOOPBACK],
        client_name: 'VS Code',
      });
    });

    it('400 with the RFC 7591 code; 429 with Retry-After when limited', async () => {
      dcrRegister.mockResolvedValueOnce({ ok: false, error: 'invalid_redirect_uri' });
      const bad = await request(app.getHttpServer()).post('/oauth/register').send({});
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'invalid_redirect_uri' });

      dcrRegister.mockResolvedValueOnce({ ok: false, error: 'rate_limited' });
      const limited = await request(app.getHttpServer()).post('/oauth/register').send({});
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    });

    it('a body that is not JSON is passed as no metadata', async () => {
      dcrRegister.mockResolvedValue({ ok: false, error: 'invalid_client_metadata' });
      await request(app.getHttpServer()).post('/oauth/register').type('form').send('client_name=x');
      expect(dcrRegister.mock.calls[0][0]).toBeUndefined();
    });
  });

  describe('POST /oauth/revoke', () => {
    beforeEach(() => build());

    const revoke = (form: Record<string, string> | string) =>
      request(app.getHttpServer()).post('/oauth/revoke').type('form').send(form);

    it('always 200 with an empty body', async () => {
      const ok = await revoke({
        token: 'assay_rt_x',
        client_id: BUILTIN_ID,
        token_type_hint: 'refresh_token',
      });
      expect(ok.status).toBe(200);
      expect(ok.text).toBe('');
      expect(tokens.revoke).toHaveBeenCalledWith({ token: 'assay_rt_x', clientId: BUILTIN_ID });

      tokens.revoke.mockRejectedValueOnce(new Error('db down'));
      const failed = await revoke({ token: 'assay_rt_x', client_id: BUILTIN_ID });
      expect(failed.status).toBe(200);
      expect(failed.text).toBe('');

      const malformed = await revoke({ client_id: BUILTIN_ID });
      expect(malformed.status).toBe(200);
      expect(malformed.text).toBe('');
      expect(tokens.revoke).toHaveBeenCalledTimes(2);
    });
  });
});

describe('the request cookie', () => {
  const secret = Buffer.alloc(32, 9);
  const rid = randomBytes(32).toString('base64url');

  it('is an HMAC of the rid, never the rid', () => {
    const value = requestCookieValue(secret, rid);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value).not.toContain(rid);
    expect(requestCookieValue(Buffer.alloc(32, 8), rid)).not.toBe(value);
  });

  it('matches only the value for this rid', () => {
    const value = requestCookieValue(secret, rid);
    expect(requestCookieMatches(secret, rid, value)).toBe(true);
    expect(requestCookieMatches(secret, randomBytes(32).toString('base64url'), value)).toBe(false);
    expect(requestCookieMatches(secret, rid, null)).toBe(false);
    expect(requestCookieMatches(secret, rid, value.toUpperCase())).toBe(false);
    expect(requestCookieMatches(secret, rid, value.slice(1))).toBe(false);
  });

  it('is read by its exact name only, and refused when sent twice', () => {
    expect(readRequestCookie(`a=1; ${REQUEST_COOKIE_NAME}=abc; b=2`)).toBe('abc');
    expect(readRequestCookie('assay_oar=abc')).toBeNull();
    expect(readRequestCookie(undefined)).toBeNull();
    expect(readRequestCookie(`${REQUEST_COOKIE_NAME}=a; ${REQUEST_COOKIE_NAME}=b`)).toBeNull();
  });
});
