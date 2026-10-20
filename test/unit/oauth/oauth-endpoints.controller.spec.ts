import { randomBytes, randomUUID } from 'node:crypto';

import { INestApplication, Logger } from '@nestjs/common';
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
  MAX_REQUEST_COOKIES,
  REQUEST_COOKIE_PREFIX,
  readCookie,
  requestCookieMatches,
  requestCookieName,
  requestCookieValue,
  requestCookiesToEvict,
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
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

import {
  Clock,
  FakeOAuthRedis,
  MCP,
  counterValue,
  fakeCache,
  oauthConfig,
  rateLimiter,
  timed,
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

  discards = 0;

  discardIfDecided(rid: string): Promise<boolean> {
    this.discards += 1;
    const found = this.requests.get(rid);
    if (!found || (!found.approval && !found.denied)) return Promise.resolve(false);
    this.requests.delete(rid);
    return Promise.resolve(true);
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
  let counters: FakeOAuthRedis;
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
    counters = new FakeOAuthRedis();
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
        { provide: OAuthMetrics, useValue: new OAuthMetrics(fakeCache(counters)) },
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

      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies).toHaveLength(1);
      const secret = config.requestCookieSecret!;
      const name = requestCookieName(secret, rid);
      expect(name).toMatch(new RegExp(`^${REQUEST_COOKIE_PREFIX}[0-9a-f]{16}$`));
      const [pair, ...attributes] = cookies[0].split('; ');
      expect(attributes).toEqual(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600']);
      expect(pair.startsWith(`${name}=`)).toBe(true);
      expect(requestCookieMatches(secret, rid, pair.slice(name.length + 1))).toBe(true);
      expect(cookies[0]).not.toContain(rid);
      expect(await counterValue(counters, 'authorize', 'stored')).toBe(1);
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
        expect(await counterValue(counters, 'authorize', reason)).toBe(1);
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
      ['response_type=token', { response_type: 'token' }, 'unsupported_response_type'],
      ['no response_type', { response_type: undefined }, 'invalid_request'],
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
      expect(await counterValue(counters, 'authorize', 'rate_limited')).toBe(1);
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
      expect((response.headers['set-cookie'] as unknown as string[])[0]).toBe(
        `${requestCookieName(config.requestCookieSecret!, rid)}=; ` +
          'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
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

    it('without the cookie, after a decision: the error page, and the request is discarded (T8)', async () => {
      const { rid, cookie } = await started();
      store.approve(rid);
      const response = await resume(rid);
      expect(response.status).toBe(403);
      expect(response.text).toContain('Finish this in the browser window where you started it');
      expect(store.requests.has(rid)).toBe(false);
      expect(store.takes).toBe(0);
      // Not even the browser that started it can finish it now.
      expect((await resume(rid, cookie)).status).toBe(404);
      expect(tokens.mintCode).not.toHaveBeenCalled();
      expect(await counterValue(counters, 'consent', 'continue_cookie_missing')).toBe(1);
    });

    it('without the cookie, before any decision: the error page, and the request stays', async () => {
      const { rid, cookie } = await started();
      const response = await resume(rid);
      expect(response.status).toBe(403);
      expect(store.requests.has(rid)).toBe(true);
      store.approve(rid);
      const finished = await resume(rid, cookie);
      expect(query(finished.headers.location).get('code')).toBe('assay_ac_code');
    });

    it("with another request's cookie value under this request's name: the error page, no code", async () => {
      const first = await started();
      const second = await started();
      store.approve(first.rid);
      const secret = config.requestCookieSecret!;
      const forged = `${requestCookieName(secret, first.rid)}=${second.cookie.split('=')[1]}`;
      const response = await resume(first.rid, forged);
      expect(response.status).toBe(403);
      expect(response.text).toContain('Finish this in the browser window where you started it');
      expect(tokens.mintCode).not.toHaveBeenCalled();
      expect(store.requests.has(first.rid)).toBe(false);
    });

    it('two sign-ins started together in one browser both complete', async () => {
      const first = await started();
      const second = await started();
      const jar = `${first.cookie}; ${second.cookie}`;
      store.approve(first.rid);
      store.approve(second.rid);
      const one = await resume(second.rid, jar);
      const two = await resume(first.rid, jar);
      expect(query(one.headers.location).get('code')).toBe('assay_ac_code');
      expect(query(two.headers.location).get('code')).toBe('assay_ac_code');
      expect(tokens.mintCode).toHaveBeenCalledTimes(2);
    });

    it(`a browser keeps at most ${MAX_REQUEST_COOKIES} pending sign-ins: the oldest is expired`, async () => {
      const held: string[] = [];
      for (let i = 0; i < MAX_REQUEST_COOKIES; i += 1) {
        const response = await authorize().set('Cookie', held.join('; '));
        const cookies = response.headers['set-cookie'] as unknown as string[];
        expect(cookies).toHaveLength(1);
        // Issue times one second apart (the controller reads the wall clock).
        const [name, value] = cookies[0].split(';')[0].split('=');
        held.push(`${name}=${(1_000_000 + i).toString(36)}.${value.split('.')[1]}`);
      }
      const sixth = await authorize().set('Cookie', held.join('; '));
      const cookies = sixth.headers['set-cookie'] as unknown as string[];
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toBe(
        `${held[0].split('=')[0]}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      );
      expect(cookies[1]).toMatch(/Max-Age=600$/);
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
      const other = Buffer.alloc(32, 7);
      const cookie = `${requestCookieName(other, rid)}=${requestCookieValue(other, rid)}`;

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

    it('undecided, in the browser that started it: access_denied to the client, no code', async () => {
      const { rid, cookie } = await started();
      const response = await resume(rid, cookie);
      expect(response.status).toBe(302);
      const params = query(response.headers.location);
      expect(response.headers.location.startsWith('http://127.0.0.1:53111/callback?')).toBe(true);
      expect(params.get('error')).toBe('access_denied');
      expect(params.get('state')).toBe('st-1');
      expect(params.get('iss')).toBe(MCP);
      expect(params.has('code')).toBe(false);
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
      expect(await counterValue(counters, 'token', 'authorization_code.ok')).toBe(1);
    });

    it('answers the pair when the counter store is down: a counter never fails the request', async () => {
      tokens.exchangeCode.mockResolvedValue(pair);
      counters.down = true;
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

      const response = await exchange();

      expect(response.status).toBe(200);
      expect(response.body).toEqual(pair);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('OAuth counter token'));
      debug.mockRestore();
      counters.down = false;
      expect(await counterValue(counters, 'token', 'authorization_code.ok')).toBe(0);
    });

    it('answers an error unchanged when the counter store is down', async () => {
      counters.down = true;
      const response = await exchange({ code_verifier: 'short' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
      counters.down = false;
    });

    it('a malformed verifier is invalid_request, checked before the code is burned', async () => {
      const response = await exchange({ code_verifier: 'short' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
      expect(tokens.exchangeCode).not.toHaveBeenCalled();
      expect(await counterValue(counters, 'token', 'authorization_code.invalid_request')).toBe(1);
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
      expect(await counterValue(counters, 'token', 'other.unsupported_grant_type')).toBe(1);
    });

    it('the service errors keep their RFC shape and status', async () => {
      tokens.exchangeCode.mockResolvedValueOnce({ error: 'invalid_grant' });
      const grant = await exchange();
      expect(grant.status).toBe(400);
      expect(grant.body).toEqual({ error: 'invalid_grant' });
      expect(grant.headers['cache-control']).toBe('no-store');

      // RFC 6749 §5.2: 400 for a public client; 401 + WWW-Authenticate only
      // when the client tried HTTP authentication.
      tokens.exchangeCode.mockResolvedValueOnce({ error: 'invalid_client' });
      const unknown = await exchange();
      expect(unknown.status).toBe(400);
      expect(unknown.body).toEqual({ error: 'invalid_client' });
      expect(unknown.headers['www-authenticate']).toBeUndefined();

      tokens.exchangeCode.mockResolvedValueOnce({ error: 'invalid_client' });
      const basic = await request(app.getHttpServer())
        .post('/oauth/token')
        .type('form')
        .set('Authorization', `Basic ${Buffer.from('x:y').toString('base64')}`)
        .send({
          grant_type: 'authorization_code',
          code: 'assay_ac_x',
          redirect_uri: LOOPBACK,
          client_id: BUILTIN_ID,
          code_verifier: VERIFIER,
        });
      expect(basic.status).toBe(401);
      expect(basic.body).toEqual({ error: 'invalid_client' });
      expect(basic.headers['www-authenticate']).toBe('Basic realm="oauth"');
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
      expect(await counterValue(counters, 'token', 'refresh_token.temporarily_unavailable')).toBe(
        1,
      );
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
      expect(await counterValue(counters, 'token', 'authorization_code.rate_limited')).toBe(1);
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

    it("has the token endpoint's limit: the 61st in a minute is 503 with Retry-After", async () => {
      for (let i = 0; i < 60; i += 1) {
        expect((await revoke({ token: 'assay_rt_x', client_id: BUILTIN_ID })).status).toBe(200);
      }
      const limited = await revoke({ token: 'assay_rt_x', client_id: BUILTIN_ID });
      expect(limited.status).toBe(503);
      expect(limited.headers['retry-after']).toMatch(/^\d+$/);
      expect(limited.body).toMatchObject({ error: 'temporarily_unavailable' });
      expect(tokens.revoke).toHaveBeenCalledTimes(60);
      // Another client from the same address has its own budget.
      expect((await revoke({ token: 'assay_rt_x', client_id: CIMD_ID })).status).toBe(200);
    });

    it('bounds one address to 120 a minute whatever client_id it sends (R1-m2)', async () => {
      // A new client_id each time never reaches the per-client limit.
      for (let i = 0; i < 120; i += 1) {
        expect((await revoke({ token: 'assay_rt_x', client_id: `client-${i}` })).status).toBe(200);
      }
      const limited = await revoke({ token: 'assay_rt_x', client_id: 'client-120' });
      expect(limited.status).toBe(503);
      expect(limited.headers['retry-after']).toMatch(/^\d+$/);
      expect(limited.body).toMatchObject({ error: 'temporarily_unavailable' });
      expect(tokens.revoke).toHaveBeenCalledTimes(120);
      // The next window starts afresh.
      clock.advance(60);
      expect((await revoke({ token: 'assay_rt_x', client_id: 'client-121' })).status).toBe(200);
      expect(tokens.revoke).toHaveBeenCalledTimes(121);
    });

    it('still revokes with Redis unreachable: refusing would keep a token alive', async () => {
      redis.down = true;
      const response = await revoke({ token: 'assay_rt_x', client_id: BUILTIN_ID });
      expect(response.status).toBe(200);
      expect(tokens.revoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('a Redis that accepts commands and never answers (GATE I-1)', () => {
    beforeEach(() => build());

    const BOUND_MS = 1500;
    const never = () => new Promise<never>(() => undefined);
    const tokenForm = {
      grant_type: 'authorization_code',
      code: 'assay_ac_x',
      redirect_uri: LOOPBACK,
      client_id: BUILTIN_ID,
      code_verifier: VERIFIER,
    };

    it('token: the limiter gives up within its bound and answers 503 temporarily_unavailable', async () => {
      jest.spyOn(redis, 'incr').mockImplementation(never);
      const { value: response, ms } = await timed(
        request(app.getHttpServer()).post('/oauth/token').type('form').send(tokenForm),
      );
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'temporarily_unavailable' });
      expect(tokens.exchangeCode).not.toHaveBeenCalled();
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it('token: a counter that never answers does not hold the pair', async () => {
      tokens.exchangeCode.mockResolvedValue({
        access_token: 'assay_at_a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'assay_rt_r',
        scope: 'assay:agent',
      });
      jest.spyOn(counters, 'incr').mockImplementation(never);
      const { value: response, ms } = await timed(
        request(app.getHttpServer()).post('/oauth/token').type('form').send(tokenForm),
      );
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe('assay_at_a');
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it('authorize: 503 within the bound, nothing stored', async () => {
      jest.spyOn(redis, 'incr').mockImplementation(never);
      const { value: response, ms } = await timed(authorize());
      expect(response.status).toBe(503);
      expect(store.requests.size).toBe(0);
      expect(ms).toBeLessThan(BOUND_MS);
    });

    it('revoke: the buckets fail open within the bound, and the token is revoked', async () => {
      jest.spyOn(redis, 'incr').mockImplementation(never);
      const { value: response, ms } = await timed(
        request(app.getHttpServer())
          .post('/oauth/revoke')
          .type('form')
          .send({ token: 'assay_rt_x', client_id: BUILTIN_ID }),
      );
      expect(response.status).toBe(200);
      expect(tokens.revoke).toHaveBeenCalledTimes(1);
      expect(ms).toBeLessThan(BOUND_MS);
    });
  });
});

describe('the request cookie', () => {
  const secret = Buffer.alloc(32, 9);
  const rid = randomBytes(32).toString('base64url');

  it('is named and valued by an HMAC of the rid, never the rid', () => {
    const name = requestCookieName(secret, rid);
    const value = requestCookieValue(secret, rid);
    expect(name).toMatch(/^__Host-assay_oar_[0-9a-f]{16}$/);
    expect(value).toMatch(/^[0-9a-z]+\.[0-9a-f]{64}$/);
    expect(`${name}${value}`).not.toContain(rid);
    expect(requestCookieName(Buffer.alloc(32, 8), rid)).not.toBe(name);
    expect(requestCookieName(secret, randomBytes(32).toString('base64url'))).not.toBe(name);
  });

  it('matches only the value for this rid', () => {
    const value = requestCookieValue(secret, rid);
    expect(requestCookieMatches(secret, rid, value)).toBe(true);
    expect(requestCookieMatches(secret, randomBytes(32).toString('base64url'), value)).toBe(false);
    expect(requestCookieMatches(secret, rid, null)).toBe(false);
    expect(requestCookieMatches(secret, rid, value.toUpperCase())).toBe(false);
    expect(requestCookieMatches(secret, rid, value.slice(0, -1))).toBe(false);
    expect(requestCookieMatches(secret, rid, value.split('.')[1])).toBe(false);
  });

  it('is read by its exact name only, and refused when sent twice', () => {
    const name = requestCookieName(secret, rid);
    expect(readCookie(`a=1; ${name}=abc; b=2`, name)).toBe('abc');
    expect(readCookie(`${REQUEST_COOKIE_PREFIX}0000000000000000=abc`, name)).toBeNull();
    expect(readCookie(undefined, name)).toBeNull();
    expect(readCookie(`${name}=a; ${name}=b`, name)).toBeNull();
  });

  it('evicts the oldest past the cap, unreadable issue times first', () => {
    const at = (n: number) => `${REQUEST_COOKIE_PREFIX}${String(n).padStart(16, '0')}`;
    const v = (seconds: number) => `${seconds.toString(36)}.${'a'.repeat(64)}`;
    const four = [1, 2, 3, 4].map((n) => `${at(n)}=${v(100 + n)}`).join('; ');
    expect(requestCookiesToEvict(four)).toEqual([]);
    const five = `${four}; ${at(5)}=${v(50)}`;
    expect(requestCookiesToEvict(five)).toEqual([at(5)]);
    const garbled = `${four}; ${at(6)}=garbage`;
    expect(requestCookiesToEvict(garbled)).toEqual([at(6)]);
    expect(requestCookiesToEvict('other=1')).toEqual([]);
  });

  it('evicts only names of the exact binding format, never echoing another (R1-m3)', () => {
    const at = (n: number) => `${REQUEST_COOKIE_PREFIX}${String(n).padStart(16, '0')}`;
    const v = (seconds: number) => `${seconds.toString(36)}.${'a'.repeat(64)}`;
    const four = [1, 2, 3, 4].map((n) => `${at(n)}=${v(100 + n)}`).join('; ');
    for (const odd of [
      `${REQUEST_COOKIE_PREFIX}`,
      `${REQUEST_COOKIE_PREFIX}0000`,
      `${REQUEST_COOKIE_PREFIX}${'0'.repeat(17)}`,
      `${REQUEST_COOKIE_PREFIX}${'A'.repeat(16)}`,
      `${REQUEST_COOKIE_PREFIX}${'g'.repeat(16)}`,
      `${REQUEST_COOKIE_PREFIX}${'0'.repeat(16)}; Domain=evil.example`,
      `${REQUEST_COOKIE_PREFIX}${'0'.repeat(15)}\r\nX`,
      `x${REQUEST_COOKIE_PREFIX}${'0'.repeat(16)}`,
    ]) {
      // An odd name with the oldest issue time is not counted, and not named.
      expect(requestCookiesToEvict(`${four}; ${odd}=${v(1)}`)).toEqual([]);
      const five = `${four}; ${odd}=${v(1)}; ${at(5)}=${v(50)}`;
      expect(requestCookiesToEvict(five)).toEqual([at(5)]);
    }
  });
});
