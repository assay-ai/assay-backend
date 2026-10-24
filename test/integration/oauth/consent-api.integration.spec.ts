import { randomBytes, randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import {
  OAuthClientEntity,
  OAuthClientKind,
} from '@database/postgres/entities/oauth-client.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OrganizationRepository } from '@database/postgres/repositories/organization.repository';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { BlockSubjectKind, BlockedRole } from '@modules/blocklist/domain/account-block';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_FREE_QUOTA_CONFIG,
  FREE_QUOTA_CONFIG,
} from '@modules/free-tier/config/free-quota.config';
import {
  MCP_SESSION_SOURCE,
  McpCallerKind,
  McpSession,
  McpSessionPort,
} from '@modules/mcp/ports/mcp-session.port';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { OAUTH_CONFIG, OAuthConfig } from '@modules/oauth/config/oauth.config';
import { OAuthConsentController } from '@modules/oauth/controllers/oauth-consent.controller';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import { OAuthClientRegistry } from '@modules/oauth/services/oauth-client.registry';
import { OAuthConsentService } from '@modules/oauth/services/oauth-consent.service';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import {
  NewOAuthPendingRequest,
  OAUTH_REQUEST_KEY_PREFIX,
  OAuthRequestStore,
} from '@modules/oauth/services/oauth-request.store';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The consent API (spec §6.3.5): `GET {API}/oauth/requests/{rid}` and its
 * approve and deny, over real HTTP, against a real migrated database and a
 * real Redis. Only a person may answer; the first organization to read a
 * request owns it; a request is decided once; it lives 600 s.
 */
describe('OAuth consent API — real database and Redis', () => {
  const DATABASE = 'assay_oauth_consent_api_test';
  const MCP = 'https://mcp.example.test';
  const BUILTIN_CLIENT_ID = `${MCP}/oauth/clients/assay-mcp`;
  const LOOPBACK = 'http://127.0.0.1/callback';
  const CHAIN = 'eip155:46630' as ChainId;
  const ASSET = 'eip155:46630/erc20:0x7e99c98e066032b2ef5768ff18ed090e1ab921ac';

  const ORG_A = randomUUID();
  const ORG_B = randomUUID();
  const ORG_SUSPENDED = randomUUID();
  const PERSON_A = randomUUID();
  const PERSON_B = randomUUID();
  const PERSON_SUSPENDED_ORG = randomUUID();

  const HUMAN_A = 'test-human-a';
  const HUMAN_B = 'test-human-b';
  const HUMAN_SUSPENDED_ORG = 'test-human-suspended-org';
  const AGENT_A = 'test-agent-a';

  let dataSource: DataSource;
  let redis: Redis;
  let app: INestApplication;
  let store: OAuthRequestStore;
  let registry: OAuthClientRegistry;
  let clients: OAuthClientRepository;
  let builtin: OAuthClientEntity;
  let dcr: OAuthClientEntity;
  let cimd: OAuthClientEntity;

  const sessions = new Map<string, McpSession>();

  function session(
    credentialId: string,
    organizationId: string,
    agentId: string,
    callerKind: McpCallerKind,
  ): McpSession {
    return {
      credentialId,
      organizationId,
      agentId,
      agentAccount: `${CHAIN}:0x${'1'.repeat(40)}` as AccountId,
      chainId: CHAIN,
      label: null,
      callerKind,
      paymentsAllowed: true,
    } as McpSession;
  }

  const sessionSource: McpSessionPort = {
    resolve: async (token: string | undefined) => {
      const found = token ? sessions.get(token) : undefined;
      if (!found) throw McpErrors.credentialInvalid();
      return found;
    },
  } as McpSessionPort;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });

    clients = new OAuthClientRepository(dataSource);
    builtin = await insertClient(
      OAuthClientKind.BUILTIN,
      BUILTIN_CLIENT_ID,
      'Assay app (assay-mcp)',
    );
    dcr = await insertClient(
      OAuthClientKind.DCR,
      `dcr_${randomBytes(16).toString('base64url').slice(0, 22)}`,
      'Visual Studio Code',
    );
    cimd = await insertClient(
      OAuthClientKind.CIMD,
      'https://tools.example.com/oauth/client.json',
      'Claude Code',
    );

    await insertOrganization(ORG_A);
    await insertOrganization(ORG_B);
    await insertOrganization(ORG_SUSPENDED, 'SUSPENDED');
    await insertAgent(PERSON_A, { organizationId: ORG_A, label: 'research-bot' });
    await insertAgent(PERSON_B, { organizationId: ORG_B });
    await insertAgent(PERSON_SUSPENDED_ORG, { organizationId: ORG_SUSPENDED });

    sessions.set(HUMAN_A, session('user-a', ORG_A, PERSON_A, McpCallerKind.HUMAN));
    sessions.set(HUMAN_B, session('user-b', ORG_B, PERSON_B, McpCallerKind.HUMAN));
    sessions.set(
      HUMAN_SUSPENDED_ORG,
      session('user-s', ORG_SUSPENDED, PERSON_SUSPENDED_ORG, McpCallerKind.HUMAN),
    );
    sessions.set(AGENT_A, session(randomUUID(), ORG_A, PERSON_A, McpCallerKind.AGENT));

    const config: OAuthConfig = {
      issuer: MCP,
      webAppUrl: 'https://app.example.test',
      verifiedClients: [],
      redirectAllowlist: [],
      paymentClients: [BUILTIN_CLIENT_ID],
      allowHttpCimdLoopback: false,
      requestCookieSecret: Buffer.alloc(32, 7),
      dcrGlobalPerDay: 1000,
      dcrPer48PerHour: 50,
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [OAuthConsentController],
      providers: [
        OAuthConsentService,
        OAuthRequestStore,
        OAuthClientRegistry,
        { provide: CimdFetcher, useValue: {} },
        { provide: OAUTH_CONFIG, useValue: config },
        { provide: OAuthMetrics, useValue: new OAuthMetrics() },
        { provide: FREE_QUOTA_CONFIG, useValue: DEFAULT_FREE_QUOTA_CONFIG },
        { provide: REDIS_CACHE_CLIENT, useValue: redis },
        { provide: MCP_SESSION_SOURCE, useValue: sessionSource },
        { provide: OAuthClientRepository, useValue: clients },
        { provide: AgentRepository, useValue: new AgentRepository(dataSource) },
        { provide: OrganizationRepository, useValue: new OrganizationRepository(dataSource) },
        { provide: AgentCredentialRepository, useValue: new AgentCredentialRepository(dataSource) },
        { provide: SpendPolicyRepository, useValue: new SpendPolicyRepository(dataSource) },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    // Bound once, on 127.0.0.1 exactly: supertest then reuses this address
    // instead of an ephemeral wildcard listen per request, which another local
    // process holding the same port on 127.0.0.1 could answer.
    await app.listen(0, '127.0.0.1');

    store = app.get(OAuthRequestStore);
    registry = app.get(OAuthClientRegistry);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await dataSource?.destroy();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function insertClient(
    kind: OAuthClientKind,
    clientId: string,
    clientName: string,
  ): Promise<OAuthClientEntity> {
    return clients.save(
      clients.create({
        clientId,
        kind,
        clientName,
        clientUri: null,
        redirectUris: [LOOPBACK, 'https://tools.example.com/callback'],
        metadata: {},
        fetchedAt: null,
        cacheUntil: null,
        lastUsedAt: null,
      }),
    );
  }

  async function insertOrganization(id: string, status = 'ACTIVE'): Promise<void> {
    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Example org', $2)`,
      [id, status],
    );
  }

  async function insertAgent(
    agentId: string,
    options: { organizationId?: string; status?: string; wallet?: boolean; label?: string } = {},
  ): Promise<string> {
    const wallet = options.wallet ?? true;
    await dataSource.query(
      `INSERT INTO "agents"
         ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id", "label")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        agentId,
        options.organizationId ?? ORG_A,
        `did:privy:test-${agentId}`,
        options.status ?? 'ACTIVE',
        wallet ? `${CHAIN}:0x${randomBytes(20).toString('hex')}` : null,
        wallet ? CHAIN : null,
        options.label ?? null,
      ],
    );
    return agentId;
  }

  async function insertGrant(
    agentId: string,
    options: {
      organizationId?: string;
      client?: OAuthClientEntity;
      expiresIn?: string;
      revoked?: boolean;
      name?: string;
      narrowed?: boolean;
    } = {},
  ): Promise<string> {
    const [row] = (await dataSource.query(
      `INSERT INTO "agent_credentials"
         ("organization_id", "agent_id", "name", "issued_via", "oauth_client_id", "expires_at",
          "revoked_at", "revoked_by", "access_mode")
       VALUES ($1, $2, $3, 'OAUTH', $4, now() + $5::interval, $6, $7, $8) RETURNING "id"`,
      [
        options.organizationId ?? ORG_A,
        agentId,
        options.name ?? 'existing',
        (options.client ?? dcr).id,
        options.expiresIn ?? '1 day',
        options.revoked ? new Date() : null,
        options.revoked ? 'test' : null,
        options.narrowed ? 'RESTRICTED' : null,
      ],
    )) as { id: string }[];
    return row.id;
  }

  async function newRequest(overrides: Partial<NewOAuthPendingRequest> = {}): Promise<string> {
    return store.create({
      oauthClientId: dcr.id,
      redirectUri: LOOPBACK,
      codeChallenge: randomBytes(32).toString('base64url'),
      scope: 'assay:agent offline_access',
      state: 'client-state-value',
      device: null,
      replaces: null,
      ...overrides,
    });
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const read = (rid: string, token = HUMAN_A) =>
    request(app.getHttpServer()).get(`/api/v1/oauth/requests/${rid}`).set(auth(token));

  const approve = (rid: string, body: Record<string, unknown>, token = HUMAN_A) =>
    request(app.getHttpServer())
      .post(`/api/v1/oauth/requests/${rid}/approve`)
      .set(auth(token))
      .send(body);

  const deny = (rid: string, token = HUMAN_A) =>
    request(app.getHttpServer()).post(`/api/v1/oauth/requests/${rid}/deny`).set(auth(token));

  const continueUrl = (rid: string) =>
    `${MCP}/oauth/authorize/continue?request=${encodeURIComponent(rid)}`;

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Every key anywhere in a JSON value. */
  function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
    }
    return [];
  }

  // ── HUMAN only (R-OA-24) ─────────────────────────────────────────────────

  it('AGENT token → 403 AUTH_HUMAN_SESSION_REQUIRED on read, approve and deny', async () => {
    const rid = await newRequest();
    for (const response of [
      await read(rid, AGENT_A),
      await approve(rid, { agentId: PERSON_A, name: 'x' }, AGENT_A),
      await deny(rid, AGENT_A),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('AUTH_HUMAN_SESSION_REQUIRED');
    }
    // The agent's attempt neither bound nor decided it.
    const taken = await store.take(rid);
    expect(taken).toEqual(
      expect.objectContaining({ boundOrganizationId: null, approval: null, denied: false }),
    );
  });

  it('no token → 401', async () => {
    const rid = await newRequest();
    const response = await request(app.getHttpServer()).get(`/api/v1/oauth/requests/${rid}`);
    expect(response.status).toBe(401);
  });

  // ── binding and decisions ────────────────────────────────────────────────

  it('first reader binds; other org → 404 OAUTH_REQUEST_NOT_FOUND', async () => {
    const rid = await newRequest();
    expect((await read(rid)).status).toBe(200);

    for (const response of [
      await read(rid, HUMAN_B),
      await approve(rid, { agentId: PERSON_B, name: 'Mine now' }, HUMAN_B),
      await deny(rid, HUMAN_B),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
    }
    // The first reader can still read and answer it.
    expect((await read(rid)).status).toBe(200);
    expect((await approve(rid, { agentId: PERSON_A, name: 'Mine' })).status).toBe(200);
  });

  it('an unread request is bound by its approver; another org then gets 404', async () => {
    const rid = await newRequest();
    expect((await approve(rid, { agentId: PERSON_A, name: 'Direct' })).status).toBe(200);
    const response = await read(rid, HUMAN_B);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
  });

  it('approve → redirectTo continue; the approval is recorded for continue to take', async () => {
    const rid = await newRequest();
    await read(rid);
    const response = await approve(rid, { agentId: PERSON_A, name: '  Laptop‏ app  ' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ redirectTo: continueUrl(rid) });

    const taken = await store.take(rid);
    expect(taken?.boundOrganizationId).toBe(ORG_A);
    expect(taken?.denied).toBe(false);
    // Name sanitised; approvedBy is the person's audit actor id, never taken from the body.
    expect(taken?.approval).toEqual({
      agentId: PERSON_A,
      name: 'Laptop app',
      approvedBy: 'user-a',
      replaces: null,
    });
  });

  it('deny → the same redirectTo; the request is marked denied', async () => {
    const rid = await newRequest();
    await read(rid);
    const response = await deny(rid);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ redirectTo: continueUrl(rid) });
    const taken = await store.take(rid);
    expect(taken).toEqual(expect.objectContaining({ denied: true, approval: null }));
  });

  it('approve twice → 409 OAUTH_REQUEST_ALREADY_DECIDED; deny after approve and reread too', async () => {
    const rid = await newRequest();
    await read(rid);
    expect((await approve(rid, { agentId: PERSON_A, name: 'First' })).status).toBe(200);

    for (const response of [
      await approve(rid, { agentId: PERSON_A, name: 'Second' }),
      await deny(rid),
      await read(rid),
    ]) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('OAUTH_REQUEST_ALREADY_DECIDED');
    }
    // Another org learns nothing: still 404.
    expect((await read(rid, HUMAN_B)).body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
    // The first decision stands.
    expect((await store.take(rid))?.approval?.name).toBe('First');
  });

  it('after continue took the request, the tombstone still answers 409', async () => {
    const rid = await newRequest();
    await read(rid);
    await deny(rid);
    expect(await store.take(rid)).not.toBeNull();
    expect(await store.take(rid)).toBeNull();
    const response = await approve(rid, { agentId: PERSON_A, name: 'Late' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OAUTH_REQUEST_ALREADY_DECIDED');
  });

  it('two approvals racing: exactly one wins', async () => {
    const rid = await newRequest();
    await read(rid);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        approve(rid, { agentId: PERSON_A, name: `Racer ${index}` }),
      ),
    );
    expect(results.filter((response) => response.status === 200)).toHaveLength(1);
    expect(results.filter((response) => response.status === 409)).toHaveLength(7);
  });

  it('expired (TTL elapsed) → 404', async () => {
    const rid = await newRequest();
    expect(await redis.ttl(`${OAUTH_REQUEST_KEY_PREFIX}${rid}`)).toBeGreaterThan(590);
    await redis.pexpire(`${OAUTH_REQUEST_KEY_PREFIX}${rid}`, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const response of [
      await read(rid),
      await approve(rid, { agentId: PERSON_A, name: 'Late' }),
      await deny(rid),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
    }
  });

  it('binding and deciding keep the 600 s TTL; the tombstone lives 600 s', async () => {
    const rid = await newRequest();
    await redis.expire(`${OAUTH_REQUEST_KEY_PREFIX}${rid}`, 100);
    await read(rid);
    await approve(rid, { agentId: PERSON_A, name: 'Kept' });
    expect(await redis.ttl(`${OAUTH_REQUEST_KEY_PREFIX}${rid}`)).toBeLessThanOrEqual(100);
    expect(await redis.ttl(`oauth:req-done:${rid}`)).toBeGreaterThan(590);
  });

  it('an unknown or malformed rid → 404', async () => {
    const unknown = randomBytes(32).toString('base64url');
    expect((await read(unknown)).body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
    expect((await read('short')).body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
    expect((await deny('a'.repeat(44))).body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
  });

  // ── approval checks ──────────────────────────────────────────────────────

  it('51st live grant → 409 OAUTH_GRANT_LIMIT_REACHED; 49 live + expired + revoked → ok', async () => {
    const full = await insertAgent(randomUUID());
    for (let i = 0; i < 50; i += 1) await insertGrant(full);
    const rid = await newRequest();
    await read(rid);
    const refused = await approve(rid, { agentId: full, name: 'One too many' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('OAUTH_GRANT_LIMIT_REACHED');
    // A refusal leaves the request undecided: another agent can still be chosen.
    expect((await approve(rid, { agentId: PERSON_A, name: 'Other agent' })).status).toBe(200);

    const roomy = await insertAgent(randomUUID());
    for (let i = 0; i < 49; i += 1) await insertGrant(roomy);
    await insertGrant(roomy, { expiresIn: '-1 minute' });
    await insertGrant(roomy, { revoked: true });
    const ok = await newRequest();
    await read(ok);
    expect((await approve(ok, { agentId: roomy, name: 'Fiftieth' })).status).toBe(200);
  });

  it('at 50, re-login of the Assay app replacing its own live grant → ok', async () => {
    const agent = await insertAgent(randomUUID());
    for (let i = 0; i < 49; i += 1) await insertGrant(agent);
    const old = await insertGrant(agent, { client: builtin, name: 'Assay app on this Mac' });
    const rid = await newRequest({ oauthClientId: builtin.id, replaces: old });
    await read(rid);
    const response = await approve(rid, { agentId: agent, name: 'Assay app on this Mac' });
    expect(response.status).toBe(200);
    expect((await store.take(rid))?.approval?.replaces).toBe(old);
  });

  it('suspended agent, suspended org or no wallet → 409 OAUTH_AGENT_NOT_ACTIVE', async () => {
    const suspended = await insertAgent(randomUUID(), { status: 'SUSPENDED' });
    const walletless = await insertAgent(randomUUID(), { wallet: false });
    for (const agentId of [suspended, walletless]) {
      const rid = await newRequest();
      await read(rid);
      const response = await approve(rid, { agentId, name: 'Paused' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('OAUTH_AGENT_NOT_ACTIVE');
    }

    const rid = await newRequest();
    await read(rid, HUMAN_SUSPENDED_ORG);
    const response = await approve(
      rid,
      { agentId: PERSON_SUSPENDED_ORG, name: 'Org paused' },
      HUMAN_SUSPENDED_ORG,
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OAUTH_AGENT_NOT_ACTIVE');
  });

  it('an agent of another org → 404 ACCOUNT_AGENT_NOT_FOUND', async () => {
    const rid = await newRequest();
    await read(rid);
    const response = await approve(rid, { agentId: PERSON_B, name: 'Not mine' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ACCOUNT_AGENT_NOT_FOUND');
  });

  it('a body with extra fields or a bad agent id → 400, the request stays undecided', async () => {
    const rid = await newRequest();
    await read(rid);
    expect(
      (await approve(rid, { agentId: PERSON_A, name: 'x', approvedBy: 'someone-else' })).status,
    ).toBe(400);
    expect((await approve(rid, { agentId: 'not-a-uuid', name: 'x' })).status).toBe(400);
    expect((await approve(rid, { agentId: PERSON_A, name: '‏‎' })).status).toBe(400);
    expect((await approve(rid, { agentId: PERSON_A, name: 'Fine' })).status).toBe(200);
  });

  // ── the §6.3.5 JSON ──────────────────────────────────────────────────────

  it('GET returns the §6.3.5 JSON: client, returnTo, scope, agents with limits and access', async () => {
    await dataSource.query(
      `INSERT INTO "spend_policies"
         ("organization_id", "agent_id", "policy_version", "asset_id", "decimals",
          "per_call_max", "daily_cap", "changed_by")
       VALUES ($1, $2, 1, $3, 6, '500000', '5000000', 'test')`,
      [ORG_A, PERSON_A, ASSET],
    );
    await insertGrant(PERSON_A);
    await insertGrant(PERSON_A);
    await insertGrant(PERSON_A, { revoked: true });
    const paused = await insertAgent(randomUUID(), { status: 'SUSPENDED' });

    const rid = await newRequest({ oauthClientId: cimd.id });
    const response = await read(rid);
    expect(response.status).toBe(200);
    const body = response.body.data;

    const created = Date.parse(body.createdAt);
    expect(Date.parse(body.expiresAt) - created).toBe(600_000);
    expect(body).toEqual({
      requestId: rid,
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      client: {
        name: 'Claude Code',
        kind: 'CIMD',
        registrableDomain: 'example.com',
        host: 'tools.example.com',
        verified: false,
        builtin: false,
        paymentClient: false,
      },
      returnTo: { kind: 'LOCAL_APP', display: 'an app on this computer' },
      scope: ['assay:agent', 'offline_access'],
      // A third-party client's grant: free tool calls only (H2).
      grantedScopes: ['tools:call'],
      agents: [
        {
          id: PERSON_A,
          label: 'research-bot',
          active: true,
          limits: {
            perCall: { amount: '500000', asset: ASSET, decimals: 6 },
            perDay: { amount: '5000000', asset: ASSET, decimals: 6 },
            freeCallsPerDay: DEFAULT_FREE_QUOTA_CONFIG.platformAgentDailyLimit,
          },
          access: { mode: 'ALL', summary: 'All tools' },
          liveOAuthCredentials: 2,
        },
        ...body.agents.slice(1),
      ],
      replacesAgent: null,
      suggestedName: `Claude Code · ${today()}`,
    });
    // Every agent of the organization, and none of another's.
    const ids = body.agents.map((agent: { id: string }) => agent.id);
    expect(ids).not.toContain(PERSON_B);
    expect(body.agents.find((agent: { id: string }) => agent.id === paused)).toEqual(
      expect.objectContaining({ active: false }),
    );
  });

  it('an agent without a policy has no ceilings; a restricted one is summarised', async () => {
    const org = randomUUID();
    const person = randomUUID();
    await insertOrganization(org);
    await insertAgent(person, { organizationId: org });
    const token = `test-human-${org}`;
    sessions.set(token, session('user-c', org, person, McpCallerKind.HUMAN));

    let body = (await read(await newRequest(), token)).body.data;
    expect(body.agents).toEqual([
      expect.objectContaining({
        limits: {
          perCall: null,
          perDay: null,
          freeCallsPerDay: DEFAULT_FREE_QUOTA_CONFIG.platformAgentDailyLimit,
        },
        access: { mode: 'ALL', summary: 'All tools' },
        liveOAuthCredentials: 0,
      }),
    ]);

    await dataSource.query(
      `INSERT INTO "spend_policies"
         ("organization_id", "agent_id", "policy_version", "asset_id", "decimals",
          "changed_by", "access_mode", "allowed_toolsets", "allowed_tool_ids")
       VALUES ($1, NULL, 1, $2, 6, 'test', 'RESTRICTED', $3::jsonb, $4::uuid[])`,
      [
        org,
        ASSET,
        JSON.stringify([{ toolsetId: randomUUID(), version: null, viaUrlOnly: true }]),
        [randomUUID(), randomUUID()],
      ],
    );
    body = (await read(await newRequest(), token)).body.data;
    expect(body.agents[0].access).toEqual({
      mode: 'RESTRICTED',
      summary: '1 tool set and 2 tools',
    });
  });

  it('the built-in client is a payment client; paymentClient is true only on a strict true', async () => {
    const builtinRid = await newRequest({ oauthClientId: builtin.id });
    expect((await read(builtinRid)).body.data.client).toEqual(
      expect.objectContaining({ kind: 'BUILTIN', builtin: true, paymentClient: true }),
    );

    // Fail closed on anything but `true`.
    for (const flag of [false, undefined, 'true', 1]) {
      jest.spyOn(registry, 'isPaymentClient').mockReturnValue(flag as boolean);
      const rid = await newRequest({ oauthClientId: builtin.id });
      expect((await read(rid)).body.data.client.paymentClient).toBe(false);
    }
  });

  it('a request whose client row is gone → 404', async () => {
    const rid = await newRequest({ oauthClientId: randomUUID() });
    expect((await read(rid)).body.error.code).toBe('OAUTH_REQUEST_NOT_FOUND');
  });

  // ── replaces ─────────────────────────────────────────────────────────────

  it('replaces: present for the same org, built-in client and agent, with narrowed', async () => {
    const old = await insertGrant(PERSON_A, {
      client: builtin,
      name: 'Assay app on this Mac',
      narrowed: true,
    });
    const rid = await newRequest({ oauthClientId: builtin.id, replaces: old });
    const body = (await read(rid)).body.data;
    expect(body.replaces).toEqual({
      id: old,
      name: 'Assay app on this Mac',
      agentId: PERSON_A,
      narrowed: true,
      live: true,
    });

    await approve(rid, { agentId: PERSON_A, name: 'Assay app on this Mac' });
    expect((await store.take(rid))?.approval?.replaces).toBe(old);
  });

  it('replaces of another org/client/agent → field absent, and dropped from the approval', async () => {
    const otherOrg = await insertGrant(PERSON_B, { organizationId: ORG_B, client: builtin });
    const otherClient = await insertGrant(PERSON_A, { client: dcr });
    const otherAgent = await insertAgent(randomUUID());
    const ofOtherAgent = await insertGrant(otherAgent, { client: builtin });

    for (const [replaces, oauthClientId] of [
      [otherOrg, builtin.id],
      [otherClient, builtin.id],
      // Not the built-in client: assay_replaces is ignored whatever it names.
      [await insertGrant(PERSON_A, { client: dcr }), dcr.id],
      [randomUUID(), builtin.id],
    ]) {
      const rid = await newRequest({ oauthClientId, replaces });
      const response = await read(rid);
      expect(response.status).toBe(200);
      expect(response.body.data).not.toHaveProperty('replaces');
      await approve(rid, { agentId: PERSON_A, name: 'New' });
      expect((await store.take(rid))?.approval?.replaces).toBeNull();
    }

    // Another agent's live grant: shown with that agent (the page preselects
    // it), and approving as a different one is refused — a re-login replaces
    // the same agent's connection.
    const rid = await newRequest({ oauthClientId: builtin.id, replaces: ofOtherAgent });
    const shown = (await read(rid)).body.data;
    expect(shown.replaces).toEqual(
      expect.objectContaining({ id: ofOtherAgent, agentId: otherAgent }),
    );
    expect(shown.replacesAgent).toEqual(expect.objectContaining({ id: otherAgent }));
    const refused = await approve(rid, { agentId: PERSON_A, name: 'New' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('OAUTH_REPLACE_AGENT_MISMATCH');
  });

  it('replaces naming a dead grant is shown as not live (spec F5), and approve carries it', async () => {
    const revoked = await insertGrant(PERSON_A, { client: builtin, revoked: true });
    const expired = await insertGrant(PERSON_A, { client: builtin, expiresIn: '-1 minute' });
    for (const old of [revoked, expired]) {
      const rid = await newRequest({ oauthClientId: builtin.id, replaces: old });
      expect((await read(rid)).body.data.replaces).toEqual(
        expect.objectContaining({ id: old, agentId: PERSON_A, live: false }),
      );
      // The exchange still copies its narrowing; it has nothing left to revoke.
      await approve(rid, { agentId: PERSON_A, name: 'Assay app' });
      expect((await store.take(rid))?.approval?.replaces).toBe(old);
    }
  });

  it('at 50, replaces naming a dead grant does not lift the cap → 409', async () => {
    const agent = await insertAgent(randomUUID());
    for (let i = 0; i < 50; i += 1) await insertGrant(agent);
    const dead = await insertGrant(agent, { client: builtin, revoked: true });
    const rid = await newRequest({ oauthClientId: builtin.id, replaces: dead });
    await read(rid);
    const response = await approve(rid, { agentId: agent, name: 'Assay app' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OAUTH_GRANT_LIMIT_REACHED');
  });

  // ── a blocked person ─────────────────────────────────────────────────────

  it('a blocked person can read a request but not approve or deny it', async () => {
    const token = 'test-human-blocked';
    sessions.set(token, {
      ...session('user-blocked', ORG_A, PERSON_A, McpCallerKind.HUMAN),
      blocked: { role: BlockedRole.ORGANIZATION, subjectKind: BlockSubjectKind.ORGANIZATION },
    } as McpSession);
    const rid = await newRequest();
    expect((await read(rid, token)).status).toBe(200);
    for (const response of [
      await approve(rid, { agentId: PERSON_A, name: 'Blocked' }, token),
      await deny(rid, token),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_BLOCKED');
    }
    expect((await store.take(rid))?.approval).toBeNull();
  });

  // ── suggestedName ────────────────────────────────────────────────────────

  it('suggestedName: built-in from assay_device, default "this computer", other client name · date', async () => {
    const withDevice = await newRequest({ oauthClientId: builtin.id, device: "Ana's Mac" });
    expect((await read(withDevice)).body.data.suggestedName).toBe("Assay app on Ana's Mac");

    const noDevice = await newRequest({ oauthClientId: builtin.id });
    expect((await read(noDevice)).body.data.suggestedName).toBe('Assay app on this computer');

    const other = await newRequest({ oauthClientId: cimd.id, device: 'Ignored' });
    expect((await read(other)).body.data.suggestedName).toBe(`Claude Code · ${today()}`);
  });

  // ── what is never returned ───────────────────────────────────────────────

  it('response never contains code or token fields', async () => {
    const rid = await newRequest({ oauthClientId: builtin.id, device: 'Laptop' });
    const responses = [await read(rid), await approve(rid, { agentId: PERSON_A, name: 'Laptop' })];
    const deniedRid = await newRequest();
    responses.push(await deny(deniedRid));

    for (const response of responses) {
      expect(response.status).toBe(200);
      // The response envelope's own `statusCode` aside, the payload names nothing secret.
      const keys = keysOf(response.body.data);
      for (const key of keys) {
        expect(key).not.toMatch(/code|token|secret|challenge|verifier|state|redirect_uri|hash/i);
      }
      const text = JSON.stringify(response.body);
      expect(text).not.toMatch(/assay_(ac|at|rt|sk_live)_/);
      expect(text).not.toContain('client-state-value');
      expect(text).not.toContain('codeChallenge');
    }
  });
});
