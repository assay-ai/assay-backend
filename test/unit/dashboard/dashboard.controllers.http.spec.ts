import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AccountBlockStatusService } from '@modules/account/services/account-block-status.service';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { MeStatusController } from '@modules/dashboard/controllers/me-status.controller';
import { OverviewController } from '@modules/dashboard/controllers/overview.controller';
import { OverviewService } from '@modules/dashboard/services/overview.service';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { MCP_SESSION_SOURCE, McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import { BuyerDebtService } from '@modules/payment/services/buyer-debt.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

const ORG = '11111111-1111-4111-8111-111111111111';
const PAYER = 'eip155:46630:0x0000000000000000000000000000000000000001';

/**
 * `GET /overview` and `GET /me/status` over HTTP, through the real guard,
 * the app's ValidationPipe options and the exception filter.
 */
describe('dashboard composite routes over HTTP', () => {
  let app: INestApplication;
  const get = jest.fn();
  const statusOf = jest.fn();
  const unreadCount = jest.fn();
  const listDebts = jest.fn();

  const session = (callerKind: McpCallerKind) => ({
    credentialId: `cred-${callerKind}`,
    organizationId: ORG,
    agentId: '22222222-2222-4222-8222-222222222222',
    agentAccount: PAYER,
    chainId: 'eip155:46630',
    label: null,
    callerKind,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OverviewController, MeStatusController],
      providers: [
        {
          provide: MCP_SESSION_SOURCE,
          useValue: {
            resolve: async (token: string | null) => {
              if (token === 'person') return session(McpCallerKind.HUMAN);
              if (token === 'machine') return session(McpCallerKind.AGENT);
              throw McpErrors.credentialInvalid();
            },
          },
        },
        { provide: OverviewService, useValue: { get } },
        { provide: AccountBlockStatusService, useValue: { statusOf } },
        { provide: NotificationsService, useValue: { unreadCount } },
        { provide: BuyerDebtService, useValue: { list: listDebts } },
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
    get.mockReset().mockResolvedValue({ at: 'x' });
    statusOf.mockReset().mockReturnValue({ blocked: false, blocks: [] });
    unreadCount.mockReset().mockResolvedValue({ count: 3 });
    listDebts.mockReset().mockResolvedValue([{ intentId: 'debt-1' }]);
  });

  const call = (path: string, token?: string, query: Record<string, string> = {}) => {
    const req = request(app.getHttpServer()).get(path).query(query);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  describe('GET /overview', () => {
    it('hands the session’s organization and the defaulted query to the service', async () => {
      const res = await call('/overview', 'person', { at: '2026-10-20T10:30:00.000Z' });
      expect(res.status).toBe(200);
      expect(get).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ at: '2026-10-20T10:30:00.000Z', callsLimit: 6, alertsLimit: 50 }),
      );
    });

    it('is open to an agent credential, as the routes it stands for are', async () => {
      expect((await call('/overview', 'machine')).status).toBe(200);
    });

    it('refuses no credential with 401', async () => {
      expect((await call('/overview')).status).toBe(401);
      expect(get).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-ISO anchor', { at: 'today' }],
      ['a zero limit', { callsLimit: '0' }],
      ['a limit over the page size', { alertsLimit: '101' }],
      ['a fractional limit', { callsLimit: '1.5' }],
      ['an organization id', { organizationId: ORG }],
    ])('refuses %s with 400', async (_name, query) => {
      expect((await call('/overview', 'person', query)).status).toBe(400);
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe('GET /me/status', () => {
    it('is block-status, unread-count and escrow/debts, each in its route’s shape', async () => {
      const res = await call('/me/status', 'person');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        blockStatus: { blocked: false, blocks: [] },
        unreadCount: { count: 3 },
        debts: { account: PAYER, debts: [{ intentId: 'debt-1' }] },
      });
      expect(unreadCount).toHaveBeenCalledWith(ORG);
      expect(statusOf).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG }));
      expect(listDebts).toHaveBeenCalledWith(expect.objectContaining({ agentAccount: PAYER }));
    });

    it('refuses no credential with 401', async () => {
      expect((await call('/me/status')).status).toBe(401);
    });

    it.each([
      ['debts', () => listDebts.mockRejectedValue(new Error('db down'))],
      ['unreadCount', () => unreadCount.mockRejectedValue(new Error('db down'))],
      [
        'blockStatus',
        () =>
          statusOf.mockImplementation(() => {
            throw new Error('blocklist not loaded');
          }),
      ],
    ])('answers %s as null when it fails, and the other two intact', async (part, fail) => {
      fail();
      const res = await call('/me/status', 'person');
      expect(res.status).toBe(200);
      const whole = {
        blockStatus: { blocked: false, blocks: [] },
        unreadCount: { count: 3 },
        debts: { account: PAYER, debts: [{ intentId: 'debt-1' }] },
      };
      expect(res.body).toEqual({ ...whole, [part]: null });
    });
  });
});
