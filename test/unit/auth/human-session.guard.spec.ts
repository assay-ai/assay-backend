import { AuditLogWriter } from '@shared/audit';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AgentCredentialsController } from '@modules/account/controllers/agent-credentials.controller';
import { NotificationsController } from '@modules/account/controllers/notifications.controller';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { AuthErrorCode } from '@modules/auth/errors/auth.errors';
import { CHAIN_IDS, AccountId } from '@modules/chains/ports/caip.types';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import {
  MCP_SESSION_SOURCE,
  McpCallerKind,
  McpSession,
  McpSessionPort,
} from '@modules/mcp/ports/mcp-session.port';
import { NotificationSettingsController } from '@modules/notification/controllers/notification-settings.controller';
import { NotificationSettingsService } from '@modules/notification/services/notification-settings.service';
import { EscrowDelegatesController } from '@modules/settlement/controllers/escrow-delegates.controller';
import { EscrowController } from '@modules/settlement/controllers/escrow.controller';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';
import { EscrowAccountService } from '@modules/settlement/services/escrow-account.service';
import { WithdrawalService } from '@modules/settlement/services/withdrawal.service';
import { SpendPolicyController } from '@modules/spend-policy/controllers/spend-policy.controller';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

/**
 * BUG-J-BUY-07: the agent's own machine credential could rewrite the limits
 * that exist to bound it (`PATCH /spend-policy`), mint or revoke credentials,
 * and redirect or mute its owner's alerts.
 *
 * Driven over HTTP through the REAL `SessionAuthGuard` and `HumanSessionGuard`
 * — only the session source and the services are stubbed — because what is
 * under test is the route wiring: a guard nobody attached passes every test
 * of the guard alone.
 *
 * Guards run before pipes, so an empty body tells the two cases apart without
 * ever writing: an agent is refused 403 by the guard, and a person gets past
 * it to the validation pipe's 400.
 */
describe('human-only control writes', () => {
  let app: INestApplication;

  const AGENT_ID = '22222222-2222-4222-8222-222222222222';
  const TOKENS: Record<string, McpCallerKind> = {
    'token-agent': McpCallerKind.AGENT,
    'token-human': McpCallerKind.HUMAN,
    'token-config': McpCallerKind.CONFIG,
  };

  const sessions: McpSessionPort = {
    resolve: async (token) => {
      const callerKind = token ? TOKENS[token] : undefined;
      if (!callerKind) throw McpErrors.credentialInvalid();
      const session: McpSession = {
        credentialId: `cred-${callerKind}`,
        organizationId: '11111111-1111-4111-8111-111111111111',
        agentId: AGENT_ID,
        agentAccount:
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as AccountId,
        chainId: CHAIN_IDS.SOLANA_DEVNET,
        label: null,
        callerKind,
        paymentsAllowed: true,
      };
      return session;
    },
  };

  const spendPolicy = {
    get: jest.fn(async () => ({})),
    getForRequest: jest.fn(async () => ({})),
    patch: jest.fn(),
    history: jest.fn(),
  };
  const credentials = { list: jest.fn(async () => ({})), create: jest.fn(), revoke: jest.fn() };
  const notifications = {
    listChannels: jest.fn(async () => []),
    upsertChannel: jest.fn(),
    listPreferences: jest.fn(async () => []),
    upsertPreferences: jest.fn(),
  };
  // The feed the owner reads to watch its agent. An agent that could mark it
  // read could clear the badge on the very alert that names it.
  const feed = {
    list: jest.fn(async () => ({ items: [], nextCursor: null })),
    unreadCount: jest.fn(async () => ({ count: 0 })),
    markRead: jest.fn(),
    markAllRead: jest.fn(),
  };
  const escrows = { assetFor: jest.fn(), getForConsole: jest.fn(async () => ({})) };
  const withdrawals = {
    buildIntent: jest.fn(),
    submitRelayedIntent: jest.fn(),
    unsettledVouchers: jest.fn(async () => null),
    tightenDelaySeconds: jest.fn(async () => 0),
  };
  // Agent payment delegation: the payer's control over what its agent may
  // spend. Every route, the read included, is the person's and never the agent's.
  const delegation = {
    assetFor: jest.fn(),
    authorizeIntent: jest.fn(),
    revokeIntent: jest.fn(),
    list: jest.fn(async () => []),
    tightenDelaySeconds: jest.fn(async () => 0),
    submit: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        SpendPolicyController,
        AgentCredentialsController,
        NotificationSettingsController,
        NotificationsController,
        EscrowController,
        EscrowDelegatesController,
      ],
      providers: [
        { provide: MCP_SESSION_SOURCE, useValue: sessions },
        { provide: SpendPolicyService, useValue: spendPolicy },
        { provide: AgentCredentialsService, useValue: credentials },
        { provide: NotificationSettingsService, useValue: notifications },
        { provide: NotificationsService, useValue: feed },
        { provide: EscrowAccountService, useValue: escrows },
        { provide: WithdrawalService, useValue: withdrawals },
        { provide: EscrowDelegationService, useValue: delegation },
        { provide: AuditLogWriter, useValue: { recordAfterCommit: jest.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => jest.clearAllMocks());

  const WRITES: readonly {
    readonly method: 'patch' | 'post' | 'put' | 'delete';
    readonly path: string;
  }[] = [
    { method: 'patch', path: '/spend-policy' },
    { method: 'post', path: `/agents/${AGENT_ID}/credentials` },
    {
      method: 'delete',
      path: `/agents/${AGENT_ID}/credentials/33333333-3333-4333-8333-333333333333`,
    },
    { method: 'put', path: '/notification-channels/EMAIL' },
    { method: 'put', path: '/notification-preferences' },
    { method: 'patch', path: '/notifications/44444444-4444-4444-8444-444444444444/read' },
    { method: 'post', path: '/notifications/read-all' },
    { method: 'post', path: '/escrow/limits-intent' },
    { method: 'post', path: '/escrow/limits' },
    // D1-S01: the buyer's own withdrawal. The chain still wants the buyer's
    // signature, but the agent must not even get the API to build or relay it.
    { method: 'post', path: '/escrow/withdrawals/request-intent' },
    { method: 'post', path: '/escrow/withdrawals/request' },
    { method: 'post', path: '/escrow/withdrawals/intent' },
    { method: 'post', path: '/escrow/delegates/intent' },
    { method: 'post', path: '/escrow/delegates' },
    { method: 'post', path: '/escrow/delegates/revoke-intent' },
    { method: 'post', path: '/escrow/delegates/revoke' },
  ];

  const send = (method: string, path: string, token: string) =>
    (request(app.getHttpServer()) as unknown as Record<string, (p: string) => request.Test>)
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .send({});

  it.each(WRITES)(
    '$method $path refuses an agent credential with 403',
    async ({ method, path }) => {
      const res = await send(method, path, 'token-agent');

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain(AuthErrorCode.AUTH_HUMAN_SESSION_REQUIRED);
      for (const service of [
        spendPolicy,
        credentials,
        notifications,
        feed,
        escrows,
        withdrawals,
        delegation,
      ]) {
        for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(WRITES)('$method $path lets a signed-in person through', async ({ method, path }) => {
    const res = await send(method, path, 'token-human');

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it.each(WRITES)(
    '$method $path lets a config token marked as a person through',
    async ({ method, path }) => {
      const res = await send(method, path, 'token-config');

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    },
  );

  it.each([
    '/spend-policy',
    '/notification-channels',
    '/notification-preferences',
    '/notifications',
    '/notifications/unread-count',
    '/escrow',
  ])('GET %s still answers an agent credential', async (path) => {
    const res = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer token-agent');

    expect(res.status).toBe(200);
  });

  // Review A-5, narrowed by BUG-DEMO-02: a machine token must not enumerate
  // another agent's credentials (prefixes, delegate keys, expiries); it may
  // read its own agent's metadata, which never carries a secret.
  it('GET /agents/:agentId/credentials refuses an agent credential for another agent', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const agent = await request(app.getHttpServer())
      .get(`/agents/${OTHER}/credentials`)
      .set('Authorization', 'Bearer token-agent');
    expect(agent.status).toBe(403);
    expect(JSON.stringify(agent.body)).toContain(AuthErrorCode.AUTH_HUMAN_SESSION_REQUIRED);
    expect(credentials.list).not.toHaveBeenCalled();

    const own = await request(app.getHttpServer())
      .get(`/agents/${AGENT_ID}/credentials`)
      .set('Authorization', 'Bearer token-agent');
    expect(own.status).toBe(200);

    const human = await request(app.getHttpServer())
      .get(`/agents/${OTHER}/credentials`)
      .set('Authorization', 'Bearer token-human');
    expect(human.status).toBe(200);
  });

  it('GET /escrow/delegates refuses an agent credential: the delegations are the payer’s', async () => {
    const res = await request(app.getHttpServer())
      .get('/escrow/delegates')
      .set('Authorization', 'Bearer token-agent');

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain(AuthErrorCode.AUTH_HUMAN_SESSION_REQUIRED);
    expect(delegation.list).not.toHaveBeenCalled();
  });

  it('GET /escrow/unsettled refuses an agent credential and answers the payer (review S3-12)', async () => {
    const agent = await request(app.getHttpServer())
      .get('/escrow/unsettled')
      .set('Authorization', 'Bearer token-agent');
    expect(agent.status).toBe(403);
    expect(JSON.stringify(agent.body)).toContain(AuthErrorCode.AUTH_HUMAN_SESSION_REQUIRED);
    expect(withdrawals.unsettledVouchers).not.toHaveBeenCalled();

    const human = await request(app.getHttpServer())
      .get('/escrow/unsettled')
      .set('Authorization', 'Bearer token-human');
    expect(human.status).toBe(200);
    expect(withdrawals.unsettledVouchers).toHaveBeenCalledTimes(1);
  });

  it('still refuses an unknown token with 401, before the human check', async () => {
    const res = await send('patch', '/spend-policy', 'token-nobody');

    expect(res.status).toBe(401);
  });
});
