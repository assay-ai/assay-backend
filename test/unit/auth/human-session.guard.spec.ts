import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AgentCredentialsController } from '@modules/account/controllers/agent-credentials.controller';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
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
import { EscrowController } from '@modules/settlement/controllers/escrow.controller';
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
      };
      return session;
    },
  };

  const spendPolicy = { get: jest.fn(async () => ({})), patch: jest.fn(), history: jest.fn() };
  const credentials = { list: jest.fn(async () => ({})), create: jest.fn(), revoke: jest.fn() };
  const notifications = {
    listChannels: jest.fn(async () => []),
    upsertChannel: jest.fn(),
    listPreferences: jest.fn(async () => []),
    upsertPreferences: jest.fn(),
  };
  const escrows = { assetFor: jest.fn() };
  const withdrawals = { buildIntent: jest.fn(), submitRelayedIntent: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        SpendPolicyController,
        AgentCredentialsController,
        NotificationSettingsController,
        EscrowController,
      ],
      providers: [
        { provide: MCP_SESSION_SOURCE, useValue: sessions },
        { provide: SpendPolicyService, useValue: spendPolicy },
        { provide: AgentCredentialsService, useValue: credentials },
        { provide: NotificationSettingsService, useValue: notifications },
        { provide: EscrowAccountService, useValue: escrows },
        { provide: WithdrawalService, useValue: withdrawals },
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
    { method: 'post', path: '/escrow/limits-intent' },
    { method: 'post', path: '/escrow/limits' },
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
      for (const service of [spendPolicy, credentials, notifications, escrows, withdrawals]) {
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
    '$method $path lets a config demo token through — it stands in for a person',
    async ({ method, path }) => {
      const res = await send(method, path, 'token-config');

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    },
  );

  it.each([
    '/spend-policy',
    `/agents/${AGENT_ID}/credentials`,
    '/notification-channels',
    '/notification-preferences',
  ])('GET %s still answers an agent credential', async (path) => {
    const res = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer token-agent');

    expect(res.status).toBe(200);
  });

  it('still refuses an unknown token with 401, before the human check', async () => {
    const res = await send('patch', '/spend-policy', 'token-nobody');

    expect(res.status).toBe(401);
  });
});
