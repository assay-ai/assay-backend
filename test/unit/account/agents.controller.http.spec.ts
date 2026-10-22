import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { AgentCredentialsController } from '@modules/account/controllers/agent-credentials.controller';
import { AgentsController } from '@modules/account/controllers/agents.controller';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { AgentListService } from '@modules/account/services/agent-list.service';
import { AgentsService } from '@modules/account/services/agents.service';
import { CursorPageDto } from '@shared/api';
import { MCP_SESSION_SOURCE, McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { AuditLogWriter } from '@shared/audit';
import { AGENT_SCOPES } from '@shared/auth/agent-scope';
import { TENANT_CACHE_KEY } from '@shared/decorators/tenant-cache.decorator';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';

import { buildAgent } from '../auth/helpers/fake-agent-repository';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const AGENT_A = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const AGENT_B = '9d4c1f80-6b2e-4a57-8c31-7e05b9a2d146';

/**
 * `PATCH /agents/:agentId` over HTTP, through the real guards, the app's
 * global ValidationPipe options and the one exception filter: what a caller
 * actually meets, not what the decorators say.
 */
describe('PATCH /agents/:agentId over HTTP', () => {
  let app: INestApplication;
  const update = jest.fn();
  const record = jest.fn();

  const session = (callerKind: McpCallerKind) => ({
    credentialId: `cred-${callerKind}`,
    organizationId: ORG_A,
    agentId: AGENT_A,
    agentAccount: 'eip155:46630:0x0000000000000000000000000000000000000001',
    chainId: 'eip155:46630',
    label: null,
    callerKind,
  });
  const sessions = {
    resolve: jest.fn(async (token: string | null) => {
      if (token === 'person') return session(McpCallerKind.HUMAN);
      if (token === 'machine') return session(McpCallerKind.AGENT);
      throw McpErrors.credentialInvalid();
    }),
  };

  beforeAll(async () => {
    const rows: Record<string, AgentEntity> = {
      [AGENT_A]: buildAgent({ id: AGENT_A, organizationId: ORG_A, label: 'My agent' }),
      [AGENT_B]: buildAgent({ id: AGENT_B, organizationId: ORG_B, label: 'Theirs' }),
    };
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        AgentsService,
        AgentListService,
        { provide: AgentCredentialsService, useValue: {} },
        { provide: MCP_SESSION_SOURCE, useValue: sessions },
        {
          provide: AgentRepository,
          useValue: { findById: async (id: string) => rows[id] ?? null },
        },
        { provide: AgentCredentialRepository, useValue: { createQueryBuilder: () => qb } },
        { provide: ConfigService, useValue: { get: (_k: string, fallback: string) => fallback } },
        {
          provide: getDataSourceToken('postgres'),
          useValue: { transaction: async (work: (m: unknown) => unknown) => work({ update }) },
        },
        { provide: AuditLogWriter, useValue: { record } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // The same options as `bootstrap/api/main.ts`.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    update.mockReset().mockResolvedValue({ affected: 1 });
    record.mockReset().mockResolvedValue(undefined);
  });

  const patch = (id: string, token: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(`/agents/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  it('renames the caller organization agent for a person, trimmed, with an audit row', async () => {
    const res = await patch(AGENT_A, 'person', { label: '  Research bot ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentId: AGENT_A, label: 'Research bot' });
    expect(update).toHaveBeenCalledWith(
      AgentEntity,
      { id: AGENT_A, organizationId: ORG_A },
      { label: 'Research bot' },
    );
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'agent.renamed' }),
    );
  });

  it('refuses an agent machine credential with 403', async () => {
    const res = await patch(AGENT_A, 'machine', { label: 'Mine now' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('AUTH_HUMAN_SESSION_REQUIRED');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses no credential at all', async () => {
    const res = await request(app.getHttpServer()).patch(`/agents/${AGENT_A}`).send({ label: 'x' });
    expect(res.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("answers another organization's agent with 404, writing nothing", async () => {
    const res = await patch(AGENT_B, 'person', { label: 'Mine now' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain('ACCOUNT_AGENT_NOT_FOUND');
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['another field', { label: 'ok', status: 'SUSPENDED' }],
    ['an organization id', { label: 'ok', organizationId: ORG_B }],
    ['a blank label', { label: '   ' }],
    ['a control character', { label: 'a\nb' }],
    ['an invisible label', { label: 'ㅤ' }],
    ['no label', {}],
  ])('refuses %s with 400 through the global pipe', async (_name, body) => {
    const res = await patch(AGENT_A, 'person', body);
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a non-UUID agent id with 400', async () => {
    const res = await patch('me', 'person', { label: 'ok' });
    expect(res.status).toBe(400);
  });
});

/**
 * `GET /agents?include=` over HTTP: a person's read. `include` nests the
 * credentials route's items for every agent, and only what was asked for is
 * added. An agent credential is refused, whatever its scopes: the agents list
 * and key metadata are the owner's (owner decision, agent key scopes).
 */
describe('GET /agents?include= over HTTP', () => {
  let app: INestApplication;
  const firstPagesFor = jest.fn();
  const list = jest.fn();

  const session = (callerKind: McpCallerKind) => ({
    credentialId: `cred-${callerKind}`,
    storedCredential: callerKind === McpCallerKind.AGENT,
    organizationId: ORG_A,
    agentId: AGENT_A,
    agentAccount: 'eip155:46630:0x0000000000000000000000000000000000000001',
    chainId: 'eip155:46630',
    label: null,
    callerKind,
    scopes: AGENT_SCOPES,
  });
  const sessions = {
    resolve: jest.fn(async (token: string | null) => {
      if (token === 'person') return session(McpCallerKind.HUMAN);
      if (token === 'machine') return session(McpCallerKind.AGENT);
      throw McpErrors.credentialInvalid();
    }),
  };

  const agent = (agentId: string) => ({
    agentId,
    label: 'Agent',
    agentAccount: null,
    chainId: 'eip155:46630',
    credentialCount: 1,
  });
  const key = {
    id: 'k1',
    agentId: AGENT_A,
    name: 'laptop',
    issuedVia: 'API_KEY',
    oauthClient: null,
    prefix: 'assay_sk_live_ab',
    scopes: ['tools:call', 'payments', 'activity:read'],
    lastUsedAt: new Date('2026-10-19T08:00:00.000Z'),
    expiresAt: null,
    revokedAt: null,
    rotatedFromId: null,
    delegateAccount: 'eip155:46630:0x0000000000000000000000000000000000000002',
    delegateBoundAt: new Date('2026-10-18T08:00:00.000Z'),
    pendingDelegateAccount: null,
    pendingDelegateRequestedAt: null,
    createdAt: new Date('2026-10-18T07:00:00.000Z'),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        AgentListService,
        { provide: AgentsService, useValue: { list } },
        { provide: AgentCredentialsService, useValue: { firstPagesFor } },
        { provide: MCP_SESSION_SOURCE, useValue: sessions },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    list.mockReset().mockResolvedValue(new CursorPageDto([agent(AGENT_A), agent(AGENT_B)], null));
    firstPagesFor
      .mockReset()
      .mockResolvedValue(new Map([[AGENT_A, { items: [key], hasMore: false }]]));
  });

  const get = (token: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get('/agents')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  it.each([{}, { include: 'credentials,health' }])(
    'refuses an agent credential holding every scope (%o), reading nothing',
    async (query) => {
      const res = await get('machine', query);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain('AUTH_HUMAN_SESSION_REQUIRED');
      expect(list).not.toHaveBeenCalled();
      expect(firstPagesFor).not.toHaveBeenCalled();
    },
  );

  it('a person lists every agent of the organization', async () => {
    const res = await get('person');
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(ORG_A, expect.anything());
    expect(res.body.items).toEqual([agent(AGENT_A), agent(AGENT_B)]);
  });

  it('reads every agent’s credentials in one call and nests both parts', async () => {
    const res = await get('person', { include: 'credentials,health', limit: '20' });
    expect(res.status).toBe(200);
    expect(firstPagesFor).toHaveBeenCalledTimes(1);
    expect(firstPagesFor).toHaveBeenCalledWith(ORG_A, [AGENT_A, AGENT_B], 50);
    expect(list).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ limit: 20 }));
    const [mine, theirs] = res.body.items;
    expect(mine.credentials).toEqual(JSON.parse(JSON.stringify({ items: [key], hasMore: false })));
    expect(mine.health).toMatchObject({
      liveKeyCount: 1,
      keyBound: true,
      lastUsedAt: '2026-10-19T08:00:00.000Z',
    });
    // An agent the batch returned nothing for has an empty page, not a gap.
    expect(theirs.credentials).toEqual({ items: [], hasMore: false });
    expect(theirs.health).toMatchObject({ liveKeyCount: 0, keyBound: false, lastUsedAt: null });
  });

  it('adds only what was asked for', async () => {
    const res = await get('person', { include: 'health' });
    expect(res.body.items[0]).toHaveProperty('health');
    expect(res.body.items[0]).not.toHaveProperty('credentials');
  });

  it('caches the page per organization (a person-only body)', () => {
    const options = Reflect.getMetadata(TENANT_CACHE_KEY, AgentsController.prototype.list);
    expect(options).toMatchObject({ vary: 'org' });
  });

  it.each([
    ['repeated', '?include=credentials&include=health'],
    ['repeated and comma-separated', '?include=credentials,&include=,health'],
    ['with spaces and empty entries', '?include=%20credentials%20,,health'],
  ])('reads include %s as both parts', async (_name, search) => {
    const res = await request(app.getHttpServer())
      .get(`/agents${search}`)
      .set('Authorization', 'Bearer person');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toHaveProperty('credentials');
    expect(res.body.items[0]).toHaveProperty('health');
  });

  it('reads an empty include as none: the plain list', async () => {
    const res = await get('person', { include: ',' });
    expect(res.status).toBe(200);
    expect(firstPagesFor).not.toHaveBeenCalled();
  });

  it('refuses an unknown include with 400', async () => {
    expect((await get('person', { include: 'secrets' })).status).toBe(400);
  });
});

/**
 * `GET /agents/:agentId/credentials` over HTTP: a person reads any agent of
 * the organization; an agent credential reads none, its own included.
 */
describe('GET /agents/:agentId/credentials over HTTP', () => {
  let app: INestApplication;
  const credentialList = jest.fn();
  const AGENT_SIBLING = '5e0d2a61-7c3b-4d18-9f42-0a1b2c3d4e5f';

  const session = (callerKind: McpCallerKind) => ({
    credentialId: `cred-${callerKind}`,
    storedCredential: callerKind === McpCallerKind.AGENT,
    organizationId: ORG_A,
    agentId: AGENT_A,
    agentAccount: 'eip155:46630:0x0000000000000000000000000000000000000001',
    chainId: 'eip155:46630',
    label: null,
    callerKind,
    scopes: AGENT_SCOPES,
  });
  const sessions = {
    resolve: jest.fn(async (token: string | null) => {
      if (token === 'person') return session(McpCallerKind.HUMAN);
      if (token === 'config-person') return session(McpCallerKind.CONFIG);
      if (token === 'machine') return session(McpCallerKind.AGENT);
      throw McpErrors.credentialInvalid();
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentCredentialsController],
      providers: [
        { provide: AgentCredentialsService, useValue: { list: credentialList } },
        { provide: MCP_SESSION_SOURCE, useValue: sessions },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    credentialList.mockReset().mockResolvedValue(new CursorPageDto([], null));
  });

  const get = (agentId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/agents/${agentId}/credentials`)
      .set('Authorization', `Bearer ${token}`);

  it.each([
    ['its own agent', AGENT_A],
    ['another agent of its organization', AGENT_SIBLING],
    ['an agent of another organization', AGENT_B],
  ])('refuses an agent credential reading %s, reading nothing', async (_name, agentId) => {
    const res = await get(agentId, 'machine');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('AUTH_HUMAN_SESSION_REQUIRED');
    expect(credentialList).not.toHaveBeenCalled();
  });

  it.each(['person', 'config-person'])('lets a %s read any agent', async (token) => {
    expect((await get(AGENT_SIBLING, token)).status).toBe(200);
    expect(credentialList).toHaveBeenCalledWith(ORG_A, AGENT_SIBLING, expect.anything());
  });

  it('caches the page per organization (a person-only body)', () => {
    const options = Reflect.getMetadata(
      TENANT_CACHE_KEY,
      AgentCredentialsController.prototype.list,
    );
    expect(options).toMatchObject({ vary: 'org' });
  });

  it('still refuses an agent credential minting a credential, even for itself', async () => {
    const res = await request(app.getHttpServer())
      .post(`/agents/${AGENT_A}/credentials`)
      .set('Authorization', 'Bearer machine')
      .send({ name: 'x' });
    expect(res.status).toBe(403);
  });
});
