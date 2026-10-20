import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppApiModule } from '@bootstrap/api/app.module';
import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { mcpCorsOptions } from '@bootstrap/mcp/mcp-cors';
import { AccountId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import {
  MCP_SESSION_SOURCE,
  McpCallerKind,
  McpSession,
  McpSessionPort,
} from '@modules/mcp/ports/mcp-session.port';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { OAuthCounterName, oauthCounterKey } from '@modules/oauth/domain/oauth-counters';
import { MetricsCollectorService } from '@modules/observability/services/metrics-collector.service';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { McpExceptionsFilter } from '@bootstrap/mcp/mcp-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';

import { freshMigratedDatabase, runDatabaseName } from '../helpers/slash-prorata-context';
import { testConnectionOptions } from '../helpers/test-database';

// `bull-board.module.ts` has a type error ts-jest reports and the build does
// not; the API app imports it, and it has nothing to do with OAuth.
jest.mock('../../../src/bull-board/bull-board.module', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Module } = require('@nestjs/common');
  class BullBoardConfigModule {}
  Module({})(BullBoardConfigModule);
  return { BullBoardConfigModule };
});

/**
 * The MCP OAuth endpoints (spec §6.3.4–§6.3.12; R-OA-4, R-OA-6, R-OA-7,
 * R-OA-8, R-OA-10; T6, T8), over real HTTP, with the real `AppMcpModule` and
 * `AppApiModule` booted against a migrated test database and a real Redis.
 * Only the API app's session source is replaced, by a fixed human session:
 * the consent API needs a person, and a Privy login is not what is tested.
 */
describe('MCP OAuth endpoints — AppMcpModule and AppApiModule, real database and Redis', () => {
  const DATABASE = 'assay_oauth_endpoints_test';
  const MCP = 'https://mcp.example.test';
  const WEB = 'https://app.example.test';
  const BUILTIN = `${MCP}/oauth/clients/assay-mcp`;
  const LOOPBACK = 'http://127.0.0.1/callback';
  // Solana devnet: the one chain that boots without an RPC URL setting.
  const CHAIN = CHAIN_IDS.SOLANA_DEVNET as ChainId;
  const WALLETS = [
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
  ];
  const HUMAN = 'endpoints-test-human';

  const ORG = randomUUID();
  const PERSON = randomUUID();
  const AGENT = randomUUID();

  const ENV: Record<string, string> = {
    NODE_ENV: 'local',
    TYPEORM_CACHE_TTL_MULTIPLIER: '1',
    TYPEORM_CACHE_ENABLED: 'false',
    SERVICE_TYPE: 'all',
    MCP_PUBLIC_URL: MCP,
    WEB_APP_URL: WEB,
    AUTH_SESSION_SOURCE: 'both',
    PRIVY_APP_ID: 'endpoints-test-app',
    PRIVY_DEFAULT_CHAIN_ID: CHAIN,
    PRIVY_USER_LOOKUP_ENABLED: 'false',
    ENABLED_CHAINS: CHAIN,
    BULLBOARD_ENABLED: 'false',
    BULLBOARD_USERNAME: 'endpoints-test',
    BULLBOARD_PASSWORD: 'endpoints-test-password',
    JWT_SECRET: 'endpoints-test-jwt-'.repeat(3),
    MCP_SEARCH_CURSOR_SECRET: 'endpoints-test-'.repeat(3),
  };

  let saved: NodeJS.ProcessEnv;
  let dataSource: DataSource;
  let mcp: INestApplication;
  let api: INestApplication;

  const humanSession = {
    credentialId: 'user-endpoints',
    organizationId: ORG,
    agentId: PERSON,
    agentAccount: `${CHAIN}:${WALLETS[0]}` as AccountId,
    chainId: CHAIN,
    label: null,
    callerKind: McpCallerKind.HUMAN,
    paymentsAllowed: true,
  } as McpSession;

  const humanSource: McpSessionPort = {
    resolve: async (token: string | null) => {
      if (token !== HUMAN) throw McpErrors.credentialInvalid();
      return humanSession;
    },
  } as McpSessionPort;

  beforeAll(async () => {
    saved = { ...process.env };
    dataSource = await freshMigratedDatabase(DATABASE);
    const connection = testConnectionOptions();
    Object.assign(process.env, ENV, {
      DATABASE_HOST: connection.host,
      DATABASE_PORT: String(connection.port),
      DATABASE_USER: connection.username,
      DATABASE_PASSWORD: connection.password,
      DATABASE_NAME: runDatabaseName(DATABASE),
      OAUTH_REQUEST_COOKIE_SECRET: randomBytes(32).toString('hex'),
      REDIS_HOST: process.env.REDIS_HOST || 'localhost',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_URL: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
    });

    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Endpoints org', 'ACTIVE')`,
      [ORG],
    );
    for (const [index, id] of [PERSON, AGENT].entries()) {
      await dataSource.query(
        `INSERT INTO "agents"
           ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id", "label")
         VALUES ($1, $2, $3, 'ACTIVE', $4, $5, 'endpoints-bot')`,
        [id, ORG, `did:privy:test-${id}`, `${CHAIN}:${WALLETS[index]}`, CHAIN],
      );
    }

    const mcpRef = await Test.createTestingModule({ imports: [AppMcpModule] }).compile();
    const mcpApp = mcpRef.createNestApplication<NestExpressApplication>({ logger: false });
    // One proxy hop, so each test can be its own client address.
    mcpApp.set('trust proxy', 1);
    mcpApp.enableCors(mcpCorsOptions);
    mcpApp.useGlobalFilters(new McpExceptionsFilter());
    // Bound once, on 127.0.0.1 exactly: supertest then reuses this address
    // instead of an ephemeral wildcard listen per request, which another local
    // process holding the same port on 127.0.0.1 could answer.
    await mcpApp.listen(0, '127.0.0.1');
    mcp = mcpApp;

    const apiRef = await Test.createTestingModule({ imports: [AppApiModule] })
      .overrideProvider(MCP_SESSION_SOURCE)
      .useValue(humanSource)
      .compile();
    api = apiRef.createNestApplication({ logger: false });
    api.setGlobalPrefix('api');
    api.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    api.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    api.useGlobalFilters(new AllExceptionsFilter());
    api.useGlobalInterceptors(new TransformInterceptor());
    await api.listen(0, '127.0.0.1');
  }, 300_000);

  afterAll(async () => {
    // `app.close()` leaves the named DataSource and several ioredis clients
    // open (the cache, the blocklist, kill-switch and signing-rate clients have
    // no shutdown hook; see `di-wiring.integration.spec.ts`), so every Redis
    // instance either container holds is disconnected here.
    for (const app of [api, mcp]) {
      if (!app) continue;
      const appData = app.get<DataSource>(getDataSourceToken('postgres'), { strict: false });
      const clients = new Set<Redis>();
      for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.providers.values()) {
          if (wrapper.instance instanceof Redis) clients.add(wrapper.instance);
        }
      }
      await app.close().catch(() => undefined);
      await appData?.destroy().catch(() => undefined);
      for (const client of clients) client.disconnect();
    }
    await dataSource?.destroy();
    process.env = saved;
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  /** A fresh client address per test, so the per-IP limits do not leak across tests. */
  function newIp(): string {
    return `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 250) + 1}`;
  }

  function pkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  }

  function authorize(params: Record<string, string | undefined>, ip = newIp()): request.Test {
    const defined = Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return request(mcp.getHttpServer())
      .get(`/oauth/authorize?${new URLSearchParams(defined)}`)
      .set('X-Forwarded-For', ip);
  }

  function baseParams(challenge: string, over: Record<string, string | undefined> = {}) {
    return {
      response_type: 'code',
      client_id: BUILTIN,
      redirect_uri: 'http://127.0.0.1:61234/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'client-state',
      ...over,
    };
  }

  /** Authorize, then return the rid (from the fragment) and the cookie pair. */
  async function start(challenge: string, over: Record<string, string | undefined> = {}) {
    const response = await authorize(baseParams(challenge, over));
    expect(response.status).toBe(302);
    const location: string = response.headers.location;
    const rid = /#request=([A-Za-z0-9_-]{43})$/.exec(location)![1];
    const setCookie = (response.headers['set-cookie'] as unknown as string[])[0];
    return { rid, cookie: setCookie.split(';')[0], response };
  }

  const auth = { Authorization: `Bearer ${HUMAN}` };

  async function approve(rid: string): Promise<void> {
    const read = await request(api.getHttpServer()).get(`/api/v1/oauth/requests/${rid}`).set(auth);
    expect(read.status).toBe(200);
    const approved = await request(api.getHttpServer())
      .post(`/api/v1/oauth/requests/${rid}/approve`)
      .set(auth)
      .send({ agentId: AGENT, name: 'Endpoints test' });
    expect(approved.status).toBe(200);
  }

  const resume = (rid: string, cookie?: string) => {
    const call = request(mcp.getHttpServer()).get(
      `/oauth/authorize/continue?request=${encodeURIComponent(rid)}`,
    );
    return cookie ? call.set('Cookie', cookie) : call;
  };

  const token = (form: Record<string, string>, ip = newIp()) =>
    request(mcp.getHttpServer())
      .post('/oauth/token')
      .set('X-Forwarded-For', ip)
      .type('form')
      .send(form);

  /**
   * A request-path counter (spec §6.7) over the current and the previous
   * hourly bucket, read through the MCP container's own Redis client, so it
   * sees every count that container sent before.
   */
  async function counter(name: OAuthCounterName, label: string): Promise<number> {
    const now = Date.now();
    const keys = [now, now - 3_600_000].map((at) => oauthCounterKey(name, label, at));
    const values = await mcp.get(CacheService, { strict: false }).getRedisClient().mget(keys);
    return values.reduce((total, value) => total + Number(value ?? 0), 0);
  }

  /** Approve a fresh request and return the exchange form for its code. */
  async function codeForm(): Promise<Record<string, string>> {
    const { verifier, challenge } = pkce();
    const { rid, cookie } = await start(challenge);
    await approve(rid);
    const resumed = await resume(rid, cookie);
    expect(resumed.status).toBe(302);
    return {
      grant_type: 'authorization_code',
      code: new URL(resumed.headers.location).searchParams.get('code')!,
      redirect_uri: 'http://127.0.0.1:61234/callback',
      client_id: BUILTIN,
      code_verifier: verifier,
    };
  }

  // ── authorize ──────────────────────────────────────────────────────────────

  it('missing code_challenge → redirect error=invalid_request (R-OA-4)', async () => {
    const response = await authorize(baseParams(pkce().challenge, { code_challenge: undefined }));
    const location = new URL(response.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe('http://127.0.0.1:61234/callback');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(MCP);
  });

  it('code_challenge_method=plain → invalid_request', async () => {
    const response = await authorize(
      baseParams(pkce().challenge, { code_challenge_method: 'plain' }),
    );
    expect(new URL(response.headers.location).searchParams.get('error')).toBe('invalid_request');
  });

  it('unknown client → 302 to {WEB}/connect/authorize-error?reason=client_unknown, never to redirect_uri', async () => {
    const response = await authorize(
      baseParams(pkce().challenge, { client_id: 'dcr_AAAAAAAAAAAAAAAAAAAAAA' }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${WEB}/connect/authorize-error?reason=client_unknown`);
  });

  it('redirect_uri mismatch → reason=redirect_uri_mismatch (R-OA-7)', async () => {
    for (const redirect of ['http://127.0.0.1/other', 'https://evil.example/callback']) {
      const response = await authorize(baseParams(pkce().challenge, { redirect_uri: redirect }));
      expect(response.headers.location).toBe(
        `${WEB}/connect/authorize-error?reason=redirect_uri_mismatch`,
      );
    }
  });

  it('success → 302 Location has #request= and no rid in the query; Set-Cookie has __Host-assay_oar, HttpOnly, Secure, SameSite=Lax, Max-Age=600', async () => {
    const { rid, response } = await start(pkce().challenge);
    const location: string = response.headers.location;
    expect(location).toBe(`${WEB}/connect/authorize#request=${rid}`);
    expect(new URL(location).search).toBe('');
    const setCookie = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(setCookie).toMatch(/^__Host-assay_oar_[0-9a-f]{16}=[0-9a-z]+\.[0-9a-f]{64}; /);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600']) {
      expect(setCookie.split('; ')).toContain(attribute);
    }
    expect(setCookie).not.toContain(rid);
    expect(response.headers['cache-control']).toBe('no-store');
    // No CORS on authorize.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('authorize stamps the client last_used_at', async () => {
    await dataSource.query(
      `UPDATE "oauth_clients" SET "last_used_at" = NULL WHERE "client_id" = $1`,
      [BUILTIN],
    );
    await start(pkce().challenge);
    const [row] = (await dataSource.query(
      `SELECT "last_used_at" FROM "oauth_clients" WHERE "client_id" = $1`,
      [BUILTIN],
    )) as { last_used_at: Date | null }[];
    expect(row.last_used_at).not.toBeNull();
  });

  // ── continue ───────────────────────────────────────────────────────────────

  it("continue without cookie → error page; with another browser's cookie → error page (R-OA-8)", async () => {
    const first = await start(pkce().challenge);
    const second = await start(pkce().challenge);

    // Before any decision, a stray continue takes nothing.
    const early = await resume(first.rid);
    expect(early.status).toBe(403);
    expect(early.text).toContain('Finish this in the browser window where you started it');
    expect(early.headers.location).toBeUndefined();

    await approve(first.rid);
    const other = await resume(first.rid, second.cookie);
    expect(other.status).toBe(403);
    expect(other.text).toContain('Finish this in the browser window where you started it');

    // After a decision, the wrong browser's continue discarded the request:
    // not even the browser that started it can finish it now.
    const right = await resume(first.rid, first.cookie);
    expect(right.status).toBe(404);
    expect(right.headers.location).toBeUndefined();
  });

  it('T8: a request an attacker started and a victim approved yields no code to anyone', async () => {
    // Remaining window: a code is minted only if the attacker's own continue
    // lands between the victim's approve and the victim's continue (about one
    // round trip, blind); the consent page's Cross-Origin-Opener-Policy
    // (same-origin-allow-popups) keeps an opener from stretching it by holding
    // the window open or closing it.
    // The attacker starts a sign-in in their own browser and keeps its cookie.
    const { challenge } = pkce();
    const attacker = await start(challenge);
    // The victim opens the consent link and approves it with their agent.
    await approve(attacker.rid);
    // The victim's browser goes on to continue, without the attacker's cookie.
    const victim = await resume(attacker.rid);
    expect(victim.status).toBe(403);
    expect(victim.headers.location).toBeUndefined();
    // The attacker then continues with their own cookie: no code.
    const stolen = await resume(attacker.rid, attacker.cookie);
    expect(stolen.status).toBe(404);
    expect(stolen.headers.location).toBeUndefined();
    const [{ count }] = (await dataSource.query(
      `SELECT count(*)::int AS "count" FROM "oauth_authorization_codes" WHERE "code_challenge" = $1`,
      [challenge],
    )) as { count: number }[];
    expect(count).toBe(0);
    // Nor later: the discarded request stays decided, so it cannot be
    // approved again, and a second continue with the attacker's cookie still
    // finds nothing.
    const reapprove = await request(api.getHttpServer())
      .post(`/api/v1/oauth/requests/${attacker.rid}/approve`)
      .set(auth)
      .send({ agentId: AGENT, name: 'Endpoints test' });
    expect(reapprove.status).toBe(409);
    expect(JSON.stringify(reapprove.body)).toContain('OAUTH_REQUEST_ALREADY_DECIDED');
    const again = await resume(attacker.rid, attacker.cookie);
    expect(again.status).toBe(404);
    expect(again.headers.location).toBeUndefined();
  });

  it('two sign-ins started together in one browser both complete', async () => {
    const first = await start(pkce().challenge, { state: 'one' });
    const second = await start(pkce().challenge, { state: 'two' });
    expect(first.cookie.split('=')[0]).not.toBe(second.cookie.split('=')[0]);
    const jar = `${first.cookie}; ${second.cookie}`;
    await approve(first.rid);
    await approve(second.rid);

    for (const [rid, state] of [
      [second.rid, 'two'],
      [first.rid, 'one'],
    ]) {
      const response = await resume(rid, jar);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.location);
      expect(location.searchParams.get('code')).toMatch(/^assay_ac_/);
      expect(location.searchParams.get('state')).toBe(state);
    }
  });

  it('approve then continue → 302 with code, state, iss={MCP}; the code exchanges once (R-OA-6)', async () => {
    const { verifier, challenge } = pkce();
    const { rid, cookie } = await start(challenge);
    await approve(rid);

    const response = await resume(rid, cookie);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe('http://127.0.0.1:61234/callback');
    const code = location.searchParams.get('code')!;
    expect(code).toMatch(/^assay_ac_/);
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(MCP);
    expect((response.headers['set-cookie'] as unknown as string[])[0]).toBe(
      `${cookie.split('=')[0]}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );

    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:61234/callback',
      client_id: BUILTIN,
      code_verifier: verifier,
    };
    const exchanged = await token(form);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'assay:agent',
    });
    expect(exchanged.body.access_token).toMatch(/^assay_at_/);
    expect(exchanged.body.refresh_token).toMatch(/^assay_rt_/);

    const replayed = await token(form);
    expect(replayed.status).toBe(400);
    expect(replayed.body).toEqual({ error: 'invalid_grant' });
  });

  it('deny → error=access_denied', async () => {
    const { rid, cookie } = await start(pkce().challenge);
    await request(api.getHttpServer()).get(`/api/v1/oauth/requests/${rid}`).set(auth);
    const denied = await request(api.getHttpServer())
      .post(`/api/v1/oauth/requests/${rid}/deny`)
      .set(auth);
    expect(denied.status).toBe(200);

    const response = await resume(rid, cookie);
    const location = new URL(response.headers.location);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(MCP);
    expect(location.searchParams.has('code')).toBe(false);
  });

  it('continue before anyone decided, in the browser that started it → access_denied, no code', async () => {
    const { rid, cookie } = await start(pkce().challenge);
    const response = await resume(rid, cookie);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe('http://127.0.0.1:61234/callback');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(MCP);
    expect(location.searchParams.has('code')).toBe(false);
  });

  it('response_type other than code → unsupported_response_type', async () => {
    const response = await authorize(baseParams(pkce().challenge, { response_type: 'token' }));
    const location = new URL(response.headers.location);
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('iss')).toBe(MCP);
  });

  // ── token, refresh, revoke, and the 401 reason ───────────────────────────────

  it('token response has Cache-Control no-store; refresh rotates; revoke is 200 empty; a revoked token is a 401 counted as revoked', async () => {
    const { verifier, challenge } = pkce();
    const { rid, cookie } = await start(challenge, { scope: 'assay:agent offline_access' });
    await approve(rid);
    const code = new URL((await resume(rid, cookie)).headers.location).searchParams.get('code')!;

    const exchanged = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:61234/callback',
      client_id: BUILTIN,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers['cache-control']).toBe('no-store');
    expect(exchanged.headers.pragma).toBe('no-cache');

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: exchanged.body.refresh_token,
      client_id: BUILTIN,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers['cache-control']).toBe('no-store');
    expect(refreshed.body.refresh_token).not.toBe(exchanged.body.refresh_token);

    const before = await counter('mcp_unauthorized', 'revoked');
    const revoked = await request(mcp.getHttpServer())
      .post('/oauth/revoke')
      .type('form')
      .send({ token: refreshed.body.refresh_token, client_id: BUILTIN });
    expect(revoked.status).toBe(200);
    expect(revoked.text).toBe('');

    const call = await request(mcp.getHttpServer())
      .post('/')
      .set('Authorization', `Bearer ${refreshed.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(call.status).toBe(401);
    expect(call.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(JSON.stringify(call.body)).not.toContain('revoked');
    expect(await counter('mcp_unauthorized', 'revoked')).toBeGreaterThanOrEqual(before + 1);

    expect(await counter('token', 'refresh_token.ok')).toBeGreaterThanOrEqual(1);
  });

  it('a body the parser refuses on token, revoke and register → 400 invalid_request', async () => {
    for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/register']) {
      const response = await request(mcp.getHttpServer())
        .post(path)
        .set('X-Forwarded-For', newIp())
        .set('Content-Type', 'application/json')
        .send('{not json');
      expect({ path, status: response.status, body: response.body }).toEqual({
        path,
        status: 400,
        body: { error: 'invalid_request' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('a client name that claims trust is refused at registration', async () => {
    for (const name of ['Claude \u2713 Verified', 'Assay app', 'V\u0435rified Tools']) {
      const response = await request(mcp.getHttpServer())
        .post('/oauth/register')
        .set('X-Forwarded-For', newIp())
        .send({ client_name: name, redirect_uris: [LOOPBACK] });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_client_metadata' });
    }
  });

  it('a malformed request is invalid_request before anything else', async () => {
    const response = await token({ grant_type: 'authorization_code', client_id: BUILTIN });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  // ── register and CORS ──────────────────────────────────────────────────────

  it('register has no CORS headers, and registers a public loopback client (R-OA-10)', async () => {
    const preflight = await request(mcp.getHttpServer())
      .options('/oauth/register')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const response = await request(mcp.getHttpServer())
      .post('/oauth/register')
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-For', newIp())
      .send({ client_name: 'Visual Studio Code', redirect_uris: [LOOPBACK] });
    expect(response.status).toBe(201);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{22}$/);
    expect(response.body.token_endpoint_auth_method).toBe('none');
    expect(response.body).not.toHaveProperty('client_secret');

    // The new client can authorize at once, on any loopback port.
    const authorized = await authorize(
      baseParams(pkce().challenge, {
        client_id: response.body.client_id,
        redirect_uri: 'http://127.0.0.1:50001/callback',
      }),
    );
    expect(authorized.headers.location.startsWith(`${WEB}/connect/authorize#request=`)).toBe(true);

    const refused = await request(mcp.getHttpServer())
      .post('/oauth/register')
      .set('X-Forwarded-For', newIp())
      .send({ client_name: 'Bad', redirect_uris: ['https://evil.example/callback'] });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'invalid_redirect_uri' });
  });

  it('token preflight → ACAO *, no credentials; authorize preflight → no CORS', async () => {
    for (const path of ['/oauth/token', '/oauth/revoke']) {
      const preflight = await request(mcp.getHttpServer())
        .options(path)
        .set('Origin', 'https://client.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('*');
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    }
    const authorizePreflight = await request(mcp.getHttpServer())
      .options('/oauth/authorize')
      .set('Origin', 'https://client.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(authorizePreflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── rate limit ─────────────────────────────────────────────────────────────

  it('31st authorize in a minute → 429', async () => {
    const ip = newIp();
    const { challenge } = pkce();
    // A window boundary between the calls would split them across two windows.
    const secondOfMinute = new Date().getUTCSeconds();
    if (secondOfMinute > 50) await new Promise((r) => setTimeout(r, (61 - secondOfMinute) * 1000));
    for (let i = 0; i < 30; i += 1) {
      expect((await authorize(baseParams(challenge), ip)).status).toBe(302);
    }
    const limited = await authorize(baseParams(challenge), ip);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(limited.headers['content-type']).toMatch(/text\/html/);
    // Another address is not affected.
    expect((await authorize(baseParams(challenge))).status).toBe(302);
  });

  it('the MCP container counts on its own OAuthMetrics', () => {
    expect(mcp.get(OAuthMetrics, { strict: false })).toBeInstanceOf(OAuthMetrics);
  });

  // ── dashboard signals (§6.7) ───────────────────────────────────────────────

  it('a token exchange and consent steps count in Redis, and the operator snapshot reports them', async () => {
    const before = {
      ok: await counter('token', 'authorization_code.ok'),
      shown: await counter('consent', 'shown'),
      approved: await counter('consent', 'approved'),
      stored: await counter('authorize', 'stored'),
    };

    const exchanged = await token(await codeForm());
    expect(exchanged.status).toBe(200);

    // The Redis server is shared with other runs, so the counts only grow by at least one.
    const after = {
      ok: await counter('token', 'authorization_code.ok'),
      shown: await counter('consent', 'shown'),
      approved: await counter('consent', 'approved'),
      stored: await counter('authorize', 'stored'),
    };
    expect(after.ok).toBeGreaterThanOrEqual(before.ok + 1);
    expect(after.shown).toBeGreaterThanOrEqual(before.shown + 1);
    expect(after.approved).toBeGreaterThanOrEqual(before.approved + 1);
    expect(after.stored).toBeGreaterThanOrEqual(before.stored + 1);

    // The API container's dashboard reads the counters the MCP container wrote.
    process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS = '1';
    await new Promise((resolve) => setTimeout(resolve, 5));
    const snapshot = await api.get(MetricsCollectorService, { strict: false }).snapshot();
    const signal = (name: string) => {
      const row = snapshot.signals.find((reading) => reading.signal === name);
      if (!row) throw new Error(`no ${name} reading`);
      return row;
    };

    const tokens = signal('OAUTH_TOKEN_RESULTS');
    expect(tokens.section).toBe('oauth');
    expect(tokens.extra?.['authorization_code.ok']).toBeGreaterThanOrEqual(after.ok);
    expect(tokens.value).toBeGreaterThanOrEqual(after.ok);
    const consent = signal('OAUTH_CONSENT_STEPS');
    expect(consent.value).toBeGreaterThanOrEqual(after.approved);
    expect(consent.extra?.shown).toBeGreaterThanOrEqual(after.shown);
    expect(signal('OAUTH_AUTHORIZE_OUTCOMES').value).toBeGreaterThanOrEqual(after.stored);
    // Database-backed: this run's own database holds the grant just issued.
    expect(signal('OAUTH_LIVE_GRANTS').value).toBeGreaterThanOrEqual(1);
    expect(signal('OAUTH_LIVE_GRANTS_PER_AGENT_MAX').gate).toEqual({
      status: 'OK',
      summary: expect.any(String),
    });
    expect(signal('OAUTH_CONTINUE_COOKIE_MISSING').value).not.toBeNull();
  });

  it('a counter that cannot reach Redis never fails /oauth/token', async () => {
    const form = await codeForm();
    const original = Redis.prototype.incr;
    const incr = jest.spyOn(Redis.prototype, 'incr').mockImplementation(function (
      this: Redis,
      key: unknown,
      ...rest: unknown[]
    ) {
      if (String(key).startsWith('oauth:m:')) return Promise.reject(new Error('redis is down'));
      return (original as (...args: unknown[]) => Promise<number>).call(this, key, ...rest);
    } as never);
    try {
      const exchanged = await token(form);
      expect(exchanged.status).toBe(200);
      expect(exchanged.body.access_token).toMatch(/^assay_at_/);
      expect(incr.mock.calls.some(([key]) => String(key).startsWith('oauth:m:token:'))).toBe(true);
    } finally {
      incr.mockRestore();
    }
  });
});
