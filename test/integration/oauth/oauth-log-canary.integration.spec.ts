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
import { McpExceptionsFilter } from '@bootstrap/mcp/mcp-exceptions.filter';
import { OAuthConsentService } from '@modules/oauth/services/oauth-consent.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';
import { digestToken } from '@shared/crypto/token-digest';
import { StructuredLogger } from '@shared/observability';

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
 * The log canary (R-OA-26, R-OA-27, anti-goal 3): F1 (authorize, consent,
 * continue, code exchange), F2 (refresh), a few refusals and a revoke, run
 * over real HTTP through both apps wired as their `main.ts` files wire them —
 * the structured logger, `LoggingInterceptor` and the global filters — with
 * everything the process writes captured. Not one secret may appear: no
 * minted token, code, PKCE verifier or challenge, consent request id, request
 * cookie, `Authorization` value, `assay_replaces`, `state`, nor any sha256 of
 * them; and no error body may echo one either.
 */
describe('OAuth log canary — every secret through every logging call site', () => {
  const DATABASE = 'assay_oauth_log_canary_test';
  const MCP = 'https://mcp.example.test';
  const WEB = 'https://app.example.test';
  const BUILTIN = `${MCP}/oauth/clients/assay-mcp`;
  // Solana devnet: the one chain that boots without an RPC URL setting.
  const CHAIN = CHAIN_IDS.SOLANA_DEVNET as ChainId;
  const WALLETS = [
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
  ];
  const HUMAN = 'canary-human-bearer-' + randomBytes(12).toString('hex');

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
    const mcpApp = mcpRef.createNestApplication<NestExpressApplication>({
      logger: new StructuredLogger(),
    });
    // One proxy hop, so each test can be its own client address.
    mcpApp.set('trust proxy', 1);
    mcpApp.enableCors(mcpCorsOptions);
    mcpApp.useGlobalFilters(new McpExceptionsFilter());
    mcpApp.useGlobalInterceptors(new LoggingInterceptor());
    await mcpApp.init();
    mcp = mcpApp;

    const apiRef = await Test.createTestingModule({ imports: [AppApiModule] })
      .overrideProvider(MCP_SESSION_SOURCE)
      .useValue(humanSource)
      .compile();
    api = apiRef.createNestApplication({ logger: new StructuredLogger() });
    api.setGlobalPrefix('api');
    api.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    api.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    api.useGlobalFilters(new AllExceptionsFilter());
    api.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());
    await api.init();
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

  // ── the canary ─────────────────────────────────────────────────────────────

  function captureOutput(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const capture = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => capture(args.join(' ')));
    const warn = jest.spyOn(console, 'warn').mockImplementation((...a) => capture(a.join(' ')));
    const error = jest.spyOn(console, 'error').mockImplementation((...a) => capture(a.join(' ')));
    return {
      lines,
      restore: () => [out, err, log, warn, error].forEach((spy) => spy.mockRestore()),
    };
  }

  /** Each secret, plus the sha256 forms (hex and base64url) a server may compute of it. */
  function withHashes(secrets: string[]): string[] {
    const all = new Set<string>();
    for (const secret of secrets) {
      all.add(secret);
      all.add(digestToken(secret));
      all.add(createHash('sha256').update(secret).digest('base64url'));
    }
    return [...all];
  }

  it('F1 → F2 → refusals → revoke leaves no secret in any log line or error body', async () => {
    const secrets: string[] = [HUMAN];
    const bodies: string[] = [];
    const keep = (response: request.Response) => {
      // Error bodies only: a successful consent read returns its own rid.
      if (response.status >= 400) bodies.push(response.text ?? '');
      return response;
    };
    const replaces = randomUUID();
    const state = 'canary-state-' + randomBytes(9).toString('base64url');
    // `__Host-assay_oar_{mac16}={mac}`: both halves are secrets.
    const cookieValue = (cookie: string) => cookie.split('=').slice(1).join('=');
    const cookieMac = (cookie: string) => cookie.split('=')[0].slice('__Host-assay_oar_'.length);

    const { lines, restore } = captureOutput();
    try {
      // F1, with offline_access so F2 has a refresh token.
      const { verifier, challenge } = pkce();
      secrets.push(verifier, challenge, replaces, state);
      // `assay_replaces` and `state` travel only in the authorize query.
      await start(pkce().challenge, { state, assay_replaces: replaces });
      const first = await start(challenge, { scope: 'assay:agent offline_access', state });
      secrets.push(first.rid, cookieValue(first.cookie), cookieMac(first.cookie));
      await approve(first.rid);
      const resumed = await resume(first.rid, first.cookie);
      expect(resumed.status).toBe(302);
      const code = new URL(resumed.headers.location).searchParams.get('code')!;
      secrets.push(code);

      const exchanged = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:61234/callback',
        client_id: BUILTIN,
        code_verifier: verifier,
      });
      expect(exchanged.status).toBe(200);
      secrets.push(exchanged.body.access_token, exchanged.body.refresh_token);

      // An MCP call carrying the access token in the Authorization header.
      await request(mcp.getHttpServer())
        .post('/')
        .set('Authorization', `Bearer ${exchanged.body.access_token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      // F2.
      const refreshed = await token({
        grant_type: 'refresh_token',
        refresh_token: exchanged.body.refresh_token,
        client_id: BUILTIN,
      });
      expect(refreshed.status).toBe(200);
      secrets.push(refreshed.body.access_token, refreshed.body.refresh_token);

      // Refusals, each through the logging interceptor and the filter: a
      // replayed code, a consumed request read and approved again, a
      // continue without the cookie, a second flow with a wrong verifier.
      keep(
        await token({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://127.0.0.1:61234/callback',
          client_id: BUILTIN,
          code_verifier: verifier,
        }),
      );
      keep(await request(api.getHttpServer()).get(`/api/v1/oauth/requests/${first.rid}`).set(auth));
      keep(
        await request(api.getHttpServer())
          .post(`/api/v1/oauth/requests/${first.rid}/approve`)
          .set(auth)
          .send({ agentId: AGENT, name: 'Canary' }),
      );
      keep(
        await request(api.getHttpServer())
          .post(`/api/v1/oauth/requests/${first.rid}/approve`)
          .set(auth)
          .send({ agentId: 'not-a-uuid', name: 'Canary', extra: exchanged.body.refresh_token }),
      );
      keep(await resume(first.rid));

      const other = pkce();
      secrets.push(other.verifier, other.challenge);
      const second = await start(other.challenge);
      secrets.push(second.rid, cookieValue(second.cookie), cookieMac(second.cookie));
      await approve(second.rid);
      const secondCode = new URL(
        (await resume(second.rid, second.cookie)).headers.location,
      ).searchParams.get('code')!;
      secrets.push(secondCode);
      // A continue before anyone decided.
      const third = await start(pkce().challenge);
      secrets.push(third.rid, cookieValue(third.cookie), cookieMac(third.cookie));
      keep(await resume(third.rid, third.cookie));

      const wrongVerifier = randomBytes(32).toString('base64url');
      secrets.push(wrongVerifier);
      keep(
        await token({
          grant_type: 'authorization_code',
          code: secondCode,
          redirect_uri: 'http://127.0.0.1:61234/callback',
          client_id: BUILTIN,
          code_verifier: wrongVerifier,
        }),
      );
      keep(
        await request(mcp.getHttpServer())
          .get(`/oauth/token?refresh_token=${refreshed.body.refresh_token}`)
          .set('X-Forwarded-For', newIp()),
      );

      // Review M7. A wrong method on a consent route: Nest's own 404 message
      // names the URL (I1).
      const rt = refreshed.body.refresh_token as string;
      keep(
        await request(api.getHttpServer())
          .get(`/api/v1/oauth/requests/${first.rid}/approve?x=${rt}`)
          .set(auth),
      );
      keep(await request(api.getHttpServer()).put(`/api/v1/oauth/requests/${first.rid}`).set(auth));
      // Malformed JSON on approve (API) and on token and register (MCP).
      keep(
        await request(api.getHttpServer())
          .post(`/api/v1/oauth/requests/${first.rid}/approve`)
          .set(auth)
          .set('Content-Type', 'application/json')
          .send(`{"name":${rt}}`),
      );
      for (const path of ['/oauth/token', '/oauth/register']) {
        keep(
          await request(mcp.getHttpServer())
            .post(path)
            .set('X-Forwarded-For', newIp())
            .set('Content-Type', 'application/json')
            .send(`{"refresh_token":${rt}}`),
        );
      }
      // A registration.
      keep(
        await request(mcp.getHttpServer())
          .post('/oauth/register')
          .set('X-Forwarded-For', newIp())
          .send({ client_name: 'Canary client', redirect_uris: ['http://127.0.0.1/callback'] }),
      );
      // Uppercase paths, which route all the same (M1).
      const upper = pkce();
      secrets.push(upper.verifier, upper.challenge);
      const upperState = 'canary-upper-' + randomBytes(9).toString('base64url');
      const upperReplaces = randomUUID();
      secrets.push(upperState, upperReplaces);
      const upperAuthorize = await request(mcp.getHttpServer())
        .get(
          `/OAUTH/AUTHORIZE?${new URLSearchParams(
            baseParams(upper.challenge, { state: upperState, assay_replaces: upperReplaces }),
          )}`,
        )
        .set('X-Forwarded-For', newIp());
      expect(upperAuthorize.status).toBe(302);
      const fourth = await start(pkce().challenge);
      secrets.push(fourth.rid, cookieValue(fourth.cookie), cookieMac(fourth.cookie));
      keep(
        await request(api.getHttpServer()).get(`/api/v1/OAuth/Requests/${fourth.rid}`).set(auth),
      );
      // A 5xx: the filter's error line and stack.
      const consent = api.get(OAuthConsentService, { strict: false });
      const failing = jest
        .spyOn(consent, 'read')
        .mockRejectedValueOnce(new Error(`store failed: ${rt}`));
      try {
        const failed = keep(
          await request(api.getHttpServer()).get(`/api/v1/oauth/requests/${fourth.rid}`).set(auth),
        );
        expect(failed.status).toBe(500);
      } finally {
        failing.mockRestore();
      }

      // Revoke, then the revoked access token on the MCP endpoint.
      const revoked = await request(mcp.getHttpServer())
        .post('/oauth/revoke')
        .type('form')
        .send({ token: refreshed.body.refresh_token, client_id: BUILTIN });
      expect(revoked.status).toBe(200);
      keep(
        await request(mcp.getHttpServer())
          .post('/')
          .set('Authorization', `Bearer ${refreshed.body.access_token}`)
          .set('Accept', 'application/json, text/event-stream')
          .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      );
    } finally {
      restore();
    }

    const output = lines.join('');
    // Not vacuous: the routes were logged, by path, with the rid replaced.
    expect(output).toContain('/api/v1/oauth/requests/[REDACTED]');
    expect(output).toContain('/api/v1/oauth/requests/[REDACTED]/approve');
    expect(output).toContain('"url":"/oauth/authorize/continue"');
    expect(output).toContain('"url":"/oauth/authorize"');
    expect(output).toContain('"url":"/oauth/token"');
    expect(output).toContain('"url":"/oauth/revoke"');

    expect(output).toContain('Cannot GET /api/v1/oauth/requests/[REDACTED]/approve');
    expect(output).toContain('Cannot PUT /api/v1/oauth/requests/[REDACTED]');
    expect(output).toContain('"url":"/OAUTH/AUTHORIZE"');
    expect(output).toContain('/api/v1/OAuth/Requests/[REDACTED]');
    expect(output).toContain('"url":"/oauth/register"');
    expect(output).toContain('"level":"error"');

    const errorBodies = bodies.join('\n');
    expect(errorBodies).toContain('/api/v1/oauth/requests/[REDACTED]');
    expect(errorBodies).toContain('Malformed request body');
    expect(errorBodies).toContain('"error":"invalid_request"');

    for (const secret of withHashes(secrets)) {
      expect(secret.length).toBeGreaterThan(8);
      if (output.includes(secret))
        throw new Error(`a secret reached the logs: …${secret.slice(-6)}`);
      if (errorBodies.includes(secret)) {
        throw new Error(`a secret reached an error body: …${secret.slice(-6)}`);
      }
    }
    expect(output).not.toMatch(/assay_(?:at|rt|ac|sk_live)_[A-Za-z0-9_-]{8,}/);
  });
});
