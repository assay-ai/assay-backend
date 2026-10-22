import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { OAuthClientEntity } from '@database/postgres/entities/oauth-client.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { AgentCredentialScopes1762400000060 } from '@database/postgres/migrations/1762400000060-agent-credential-scopes';
import { AgentCredentialsController } from '@modules/account/controllers/agent-credentials.controller';
import { AgentDelegateController } from '@modules/account/controllers/agent-delegate.controller';
import { AuditLogController } from '@modules/account/controllers/audit-log.controller';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { AuditLogService } from '@modules/account/services/audit-log.service';
import { CompositeMcpSessionSource } from '@modules/auth/services/composite-mcp-session.source';
import { CredentialSessionResolver } from '@modules/auth/services/credential-session.resolver';
import { DbCredentialMcpSessionSource } from '@modules/auth/services/db-credential-mcp-session.source';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { CallDisputesController } from '@modules/dispute/controllers/call-disputes.controller';
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import { FreeQuotaController } from '@modules/free-tier/controllers/free-quota.controller';
import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import { BalancesController } from '@modules/ledger/controllers/balances.controller';
import { BalancesService } from '@modules/ledger/services/balances.service';
import { MCP_SESSION_SOURCE } from '@modules/mcp/ports/mcp-session.port';
import { ConfigMcpSessionSource } from '@modules/mcp/services/config-mcp-session.source';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { CursorPageDto } from '@shared/api';
import { AuditLogWriter } from '@shared/audit';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';

import {
  ensureTestDatabase,
  resetSchemaIfMigrationsChanged,
  testConnectionOptions,
} from '../helpers/test-database';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSON_TOKEN = 'person-token-for-the-key-scopes-suite';
// A fresh payer per run: the database outlives a run, and an account is one agent's.
const PAYER =
  `${CHAIN}:0x${randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)}` as AccountId;
const QUOTA = { remaining: 1, limit: 1, resetsAt: new Date() };

/**
 * Agent key scopes over HTTP, against the real migrations: a person creates
 * keys through the real `POST /agents/:agentId/credentials`, and each key is
 * resolved by the real DB-credential session source and checked by the real
 * `SessionAuthGuard` on real controllers. Only the services behind the read
 * routes are stubs: what is under test is who reaches them.
 */
describe('agent key scopes — over HTTP, with real keys', () => {
  const DATABASE = 'assay_agent_key_scopes_test';
  let dataSource: DataSource;
  let app: INestApplication;
  const organizationId = randomUUID();
  const agentId = randomUUID();
  const reached: string[] = [];

  beforeAll(async () => {
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [
        AgentCredentialEntity,
        AgentEntity,
        OrganizationEntity,
        OAuthClientEntity,
        AuditLogEntryEntity,
      ],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await resetSchemaIfMigrationsChanged(dataSource);
    await dataSource.runMigrations({ transaction: 'each' });

    await dataSource.query(
      `INSERT INTO "organizations" ("id", "name", "status") VALUES ($1, 'Scopes org', 'ACTIVE')`,
      [organizationId],
    );
    await dataSource.query(
      `INSERT INTO "agents" ("id", "organization_id", "privy_user_id", "status", "primary_account_id", "chain_id")
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5)`,
      [agentId, organizationId, `did:privy:test-${agentId}`, PAYER, CHAIN],
    );

    const credentialRepository = new AgentCredentialRepository(dataSource);
    const agentRepository = new AgentRepository(dataSource);
    const credentials = new AgentCredentialsService(
      credentialRepository,
      agentRepository,
      dataSource,
      new AuditLogWriter(dataSource),
      { bump: async () => undefined } as unknown as AccessEpochService,
      new OAuthClientRepository(dataSource),
      { paymentClients: [], verifiedClients: [] },
    );
    const sessions = new CompositeMcpSessionSource([
      new DbCredentialMcpSessionSource(
        credentialRepository,
        new CredentialSessionResolver(credentialRepository, agentRepository),
      ),
      new ConfigMcpSessionSource({
        [PERSON_TOKEN]: {
          credentialId: 'person',
          organizationId,
          agentId,
          agentAccount: PAYER,
          chainId: CHAIN,
          kind: 'human',
        },
      }),
    ]);
    const reach = (name: string, answer: unknown = { ok: true }) =>
      jest.fn(async () => {
        reached.push(name);
        return answer;
      });

    @Module({
      controllers: [
        AgentCredentialsController,
        AgentDelegateController,
        AuditLogController,
        BalancesController,
        CallDisputesController,
        FreeQuotaController,
      ],
      providers: [
        { provide: MCP_SESSION_SOURCE, useValue: sessions },
        { provide: AgentCredentialsService, useValue: credentials },
        {
          provide: AgentDelegateService,
          useValue: { bindingStatus: reach('delegate.status'), current: reach('delegate') },
        },
        { provide: AuditLogService, useValue: { list: reach('audit-log', CursorPageDto.empty()) } },
        { provide: BalancesService, useValue: { getBalances: reach('balances') } },
        {
          provide: CallDisputeService,
          useValue: {
            file: reach('call-disputes.file'),
            listForBuyer: reach('call-disputes.list', CursorPageDto.empty()),
          },
        },
        {
          provide: FreeQuotaService,
          useValue: {
            platformRemaining: reach('free-quota', QUOTA),
            rateLimitRemaining: reach('free-quota.rate', QUOTA),
            remainingByTool: reach('free-quota.tools', []),
          },
        },
      ],
    })
    class ScopesModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ScopesModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.listen(0, '127.0.0.1');
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(() => {
    reached.length = 0;
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function createKey(body: Record<string, unknown> = {}) {
    const response = await http()
      .post(`/agents/${agentId}/credentials`)
      .set(as(PERSON_TOKEN))
      .send({ name: 'key', ...body });
    return response;
  }

  async function key(body: Record<string, unknown> = {}): Promise<string> {
    const response = await createKey(body);
    expect(response.status).toBe(201);
    return response.body.data.token as string;
  }

  const refusal = (response: request.Response) => ({
    status: response.status,
    code: response.body?.error?.code,
    requiredScope: response.body?.error?.context?.requiredScope,
  });

  describe('POST /agents/:agentId/credentials — defaults and validation', () => {
    it('a new key gets tools:call payments activity:read and a 90-day expiry', async () => {
      const response = await createKey();

      expect(response.status).toBe(201);
      expect(response.body.data.scopes).toEqual(['tools:call', 'payments', 'activity:read']);
      const lifetime = Date.parse(response.body.data.expiresAt) - Date.now();
      expect(Math.abs(lifetime - 90 * DAY_MS)).toBeLessThan(60_000);

      const [row] = await dataSource.query(
        `SELECT "scopes", "expires_at" FROM "agent_credentials" WHERE "id" = $1`,
        [response.body.data.id],
      );
      expect(row.scopes).toEqual(['tools:call', 'payments', 'activity:read']);
      expect(row.expires_at).not.toBeNull();
    });

    it.each([
      ['an unknown scope', { scopes: ['tools:call', 'admin'] }, 'VALIDATION_FAILED'],
      ['an empty scope list', { scopes: [] }, 'VALIDATION_FAILED'],
      [
        'payments without tools:call',
        { scopes: ['payments'] },
        'ACCOUNT_CREDENTIAL_SCOPES_INVALID',
      ],
      [
        'an expiry over 365 days',
        { expiresAt: new Date(Date.now() + 366 * DAY_MS).toISOString() },
        'ACCOUNT_CREDENTIAL_EXPIRY_INVALID',
      ],
      [
        'an expiry in the past',
        { expiresAt: new Date(Date.now() - DAY_MS).toISOString() },
        'ACCOUNT_CREDENTIAL_EXPIRY_INVALID',
      ],
    ])('refuses %s with 400 and creates nothing', async (_label, body, code) => {
      const before = await dataSource.query(
        `SELECT count(*)::int AS n FROM "agent_credentials" WHERE "agent_id" = $1`,
        [agentId],
      );
      const response = await createKey(body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(code);
      const after = await dataSource.query(
        `SELECT count(*)::int AS n FROM "agent_credentials" WHERE "agent_id" = $1`,
        [agentId],
      );
      expect(after[0].n).toBe(before[0].n);
    });

    it('a key cannot create a key', async () => {
      const token = await key();
      const response = await http()
        .post(`/agents/${agentId}/credentials`)
        .set(as(token))
        .send({ name: 'self-made' });
      expect(refusal(response)).toMatchObject({
        status: 403,
        code: 'AUTH_HUMAN_SESSION_REQUIRED',
      });
    });
  });

  describe('a default key (tools:call payments activity:read)', () => {
    let token: string;
    beforeAll(async () => {
      token = await key();
    });

    it('reaches its quota, its balance and its payment-key status', async () => {
      expect((await http().get('/free-quota').set(as(token))).status).toBe(200);
      expect((await http().get('/balances').set(as(token))).status).toBe(200);
      expect((await http().get('/agents/me/delegate/status').set(as(token))).status).toBe(200);
      expect(reached).toEqual(
        expect.arrayContaining(['free-quota', 'balances', 'delegate.status']),
      );
    });

    it('reads its own reports but cannot file one without reports:write', async () => {
      expect((await http().get('/call-disputes').set(as(token))).status).toBe(200);
      const filed = await http()
        .post('/call-disputes')
        .set(as(token))
        .send({ subjectType: 'PAYMENT_INTENT', subjectId: randomUUID(), reason: 'WRONG_DATA' });
      expect(refusal(filed)).toEqual({
        status: 403,
        code: 'AUTH_SCOPE_MISSING',
        requiredScope: 'reports:write',
      });
      expect(reached).not.toContain('call-disputes.file');
    });

    it.each(['/audit-log', `/agents/:agentId/credentials`])(
      'is refused %s, a person-only route, before the service runs',
      async (path) => {
        const response = await http().get(path.replace(':agentId', agentId)).set(as(token));
        expect(refusal(response)).toMatchObject({
          status: 403,
          code: 'AUTH_HUMAN_SESSION_REQUIRED',
        });
        expect(reached).toEqual([]);
      },
    );
  });

  describe('a free-calls-only key (tools:call)', () => {
    let token: string;
    beforeAll(async () => {
      token = await key({ scopes: ['tools:call'] });
    });

    it('reaches its quota', async () => {
      expect((await http().get('/free-quota').set(as(token))).status).toBe(200);
    });

    it('cannot read activity or take part in payments, and each refusal names the scope', async () => {
      expect(refusal(await http().get('/balances').set(as(token)))).toEqual({
        status: 403,
        code: 'AUTH_SCOPE_MISSING',
        requiredScope: 'activity:read',
      });
      expect(refusal(await http().get('/agents/me/delegate/status').set(as(token)))).toEqual({
        status: 403,
        code: 'AUTH_SCOPE_MISSING',
        requiredScope: 'payments',
      });
      expect(reached).toEqual([]);
    });
  });

  it('a key with reports:write can file a report', async () => {
    const token = await key({ scopes: ['tools:call', 'reports:write'] });
    const filed = await http()
      .post('/call-disputes')
      .set(as(token))
      .send({ subjectType: 'PAYMENT_INTENT', subjectId: randomUUID(), reason: 'WRONG_DATA' });
    expect(filed.status).not.toBe(403);
    expect(reached).toContain('call-disputes.file');
  });

  it('a person reaches every route, whatever scopes mean for keys', async () => {
    expect((await http().get('/audit-log').set(as(PERSON_TOKEN))).status).toBe(200);
    expect((await http().get('/balances').set(as(PERSON_TOKEN))).status).toBe(200);
  });

  it('an expired key is refused as an invalid credential', async () => {
    const created = await createKey();
    await dataSource.query(
      `UPDATE "agent_credentials" SET "expires_at" = now() - interval '1 minute' WHERE "id" = $1`,
      [created.body.data.id],
    );
    const response = await http().get('/free-quota').set(as(created.body.data.token));
    expect(refusal(response)).toMatchObject({ status: 401, code: 'MCP_CREDENTIAL_INVALID' });
  });

  describe('migration 1762400000060 — existing rows get scopes and an expiry', () => {
    it('API keys get the default scopes and at most 365 days; OAuth rows by client', async () => {
      const builtin = randomUUID();
      const thirdParty = randomUUID();
      await dataSource.query(
        `INSERT INTO "oauth_clients" ("id", "client_id", "kind", "client_name", "redirect_uris", "metadata")
         VALUES ($1, $2, 'BUILTIN', 'Assay', '{}', '{}'), ($3, $4, 'DCR', 'Other', '{}', '{}')`,
        [builtin, `https://mcp.example/${builtin}`, thirdParty, `dcr_${thirdParty.slice(0, 22)}`],
      );
      const ids = {
        never: randomUUID(),
        far: randomUUID(),
        mcp: randomUUID(),
        other: randomUUID(),
      };
      await dataSource.query(
        `INSERT INTO "agent_credentials"
           ("id", "organization_id", "agent_id", "name", "prefix", "token_hash", "scopes", "expires_at")
         VALUES ($1, $3, $4, 'never', 'assay_sk_live_m1', $5, '{tools:call}', NULL),
                ($2, $3, $4, 'far', 'assay_sk_live_m2', $6, '{}', now() + interval '1000 days')`,
        [ids.never, ids.far, organizationId, agentId, `hash-${ids.never}`, `hash-${ids.far}`],
      );
      await dataSource.query(
        `INSERT INTO "agent_credentials"
           ("id", "organization_id", "agent_id", "name", "issued_via", "oauth_client_id", "scopes", "expires_at")
         VALUES ($1, $3, $4, 'mcp', 'OAUTH', $5, '{}', now() + interval '30 days'),
                ($2, $3, $4, 'other', 'OAUTH', $6, '{}', now() + interval '30 days')`,
        [ids.mcp, ids.other, organizationId, agentId, builtin, thirdParty],
      );

      const migration = new AgentCredentialScopes1762400000060();
      const runner = dataSource.createQueryRunner();
      try {
        await migration.up(runner);
      } finally {
        await runner.release();
      }

      const rows = (await dataSource.query(
        `SELECT "id", "scopes", "expires_at" FROM "agent_credentials" WHERE "id" = ANY($1)`,
        [Object.values(ids)],
      )) as { id: string; scopes: string[]; expires_at: Date }[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const days = (id: string) => (byId.get(id)!.expires_at.getTime() - Date.now()) / DAY_MS;

      expect(byId.get(ids.never)!.scopes).toEqual(['tools:call', 'payments', 'activity:read']);
      expect(Math.round(days(ids.never))).toBe(90);
      expect(byId.get(ids.far)!.scopes).toEqual(['tools:call', 'payments', 'activity:read']);
      expect(Math.round(days(ids.far))).toBe(365);
      expect(byId.get(ids.mcp)!.scopes).toEqual(['tools:call', 'payments', 'activity:read']);
      expect(Math.round(days(ids.mcp))).toBe(30);
      expect(byId.get(ids.other)!.scopes).toEqual(['tools:call']);
    });
  });
});
