import { randomBytes, randomUUID } from 'node:crypto';

import {
  Controller,
  INestApplication,
  Post,
  UseGuards,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { AgentsController } from '@modules/account/controllers/agents.controller';
import { NotificationsController } from '@modules/account/controllers/notifications.controller';
import { AccountBlockStatusService } from '@modules/account/services/account-block-status.service';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { AgentListService } from '@modules/account/services/agent-list.service';
import { AgentsService } from '@modules/account/services/agents.service';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { MeStatusController } from '@modules/dashboard/controllers/me-status.controller';
import { DEFAULT_CALL_DISPUTE_CONFIG } from '@modules/dispute/constants/call-dispute.config';
import { CallDisputesController } from '@modules/dispute/controllers/call-disputes.controller';
import { ProviderCallDisputesController } from '@modules/dispute/controllers/provider-call-disputes.controller';
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import { BalancesController } from '@modules/ledger/controllers/balances.controller';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { BalancesService } from '@modules/ledger/services/balances.service';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerWithheldService } from '@modules/ledger/services/ledger-withheld.service';
import { MCP_SESSION_SOURCE, McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { OAUTH_CLIENT_TRUST } from '@modules/oauth/domain/credential-client-view';
import { OperatorReferenceController } from '@modules/operator/controllers/operator-reference.controller';
import { OPERATOR_SESSION_SOURCE } from '@modules/operator/ports/operator-session.port';
import { OperatorAuthThrottle } from '@modules/operator/services/operator-auth-throttle.service';
import { OperatorReferenceService } from '@modules/operator/services/operator-reference.service';
import { PlatformHealthService } from '@modules/operator/services/platform-health.service';
import { BuyerDebtService } from '@modules/payment/services/buyer-debt.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { ProviderPayoutsController } from '@modules/provider/controllers/provider-payouts.controller';
import { ProviderPayoutsService } from '@modules/provider/services/provider-payouts.service';
import { ToolsetsController } from '@modules/toolset/controllers/toolsets.controller';
import { ToolsetPublishingService } from '@modules/toolset/services/toolset-publishing.service';
import { ToolsetsService } from '@modules/toolset/services/toolsets.service';
import { ReceiptsController } from '@modules/verification/controllers/receipts.controller';
import { ReceiptService } from '@modules/verification/services/receipt.service';
import { ReceiptSummaryService } from '@modules/verification/services/receipt-summary.service';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { AuditLogWriter } from '@shared/audit';
import { OperatorAuthGuard, SessionAuthGuard } from '@shared/auth';
import { BumpsOperatorConsole } from '@shared/decorators/tenant-write.decorator';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { TenantEpochService, tenantEpochKey } from '@shared/cache/redis-cache/tenant-epoch.service';
import { LastSeenRecorder } from '@shared/last-seen';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { CacheHeaderInterceptor } from '@shared/interceptors/cache-header.interceptor';
import { HttpCacheInterceptor } from '@shared/interceptors/http-cache.interceptor';
import { SingleFlightInterceptor } from '@shared/interceptors/single-flight.interceptor';
import { TenantWriteEpochInterceptor } from '@shared/interceptors/tenant-write-epoch.interceptor';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';
import { SingleFlightService } from '@shared/services/single-flight.service';
import { SingleFlightWaitTimeout } from '@shared/decorators/single-flight.decorator';
import { MoneyUtil } from '@shared/utils/money.util';

import { noBlocks } from '../../unit/helpers/blocklist';
import { FakeHeldPayments } from '../helpers/fake-held-payments';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { USDC_ASSET, USDC_DECIMALS } from '../helpers/test-database';
import { toolsetTestContext } from '../helpers/toolset-test-context';

/** A write by an operator, to show what the write backstop does for one. */
@Controller('operator/test-write')
@UseGuards(OperatorAuthGuard)
class OperatorTestWriteController {
  @Post()
  write(): { ok: true } {
    return { ok: true };
  }
}

/** A write by an organization that the operator console lists, and one it does not. */
@Controller('test-org-write')
@UseGuards(SessionAuthGuard)
class OrgTestWriteController {
  @Post('listed')
  @BumpsOperatorConsole()
  listed(): { ok: true } {
    return { ok: true };
  }

  @Post('unlisted')
  unlisted(): { ok: true } {
    return { ok: true };
  }
}

const CHAIN = CHAIN_IDS.SOLANA_MAINNET;
const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };

/**
 * The tenant read cache, end to end: real controllers and services on a real
 * Postgres, the real Redis, and the global interceptors in `bootstrapApi`'s
 * order. For each cached family it proves that a second read is served from
 * Redis (the handler does not run), that the relevant write through the real
 * code path is visible on the very next read, that tenants, agents and caller
 * kinds never share an entry, and that `If-None-Match` answers `304` only
 * while the body is unchanged.
 */
describe('tenant read cache (Redis + epochs + single flight + ETag)', () => {
  const DATABASE = 'assay_tenant_cache_test';
  let dataSource: DataSource;
  let app: INestApplication;
  let redis: Redis;
  let pub: Redis;
  let sub: Redis;
  let epochs: TenantEpochService;
  let ledger: LedgerService;
  let balances: BalancesService;
  let notifications: NotificationsService;
  let agentsService: AgentsService;
  let toolsets: ToolsetsService;
  let disputes: CallDisputeService;
  let payouts: ProviderPayoutsService;
  const health = { getHealth: jest.fn(async () => ({ tiles: [], at: 'fixed' })) };
  const reference = {
    listPolicies: jest.fn(async () => [{ id: 'p1' }]),
    listVerifiers: jest.fn(async () => []),
    listEconomicParameters: jest.fn(async () => []),
    listOverrideRegister: jest.fn(() => []),
  };

  let orgA: string;
  let orgB: string;
  let agentA: string;
  let agentA2: string;
  let agentB: string;
  const payerA = toAccountId(CHAIN, `CachePayerA${randomBytes(6).toString('hex')}`) as AccountId;
  const payerA2 = toAccountId(CHAIN, `CachePayerC${randomBytes(6).toString('hex')}`) as AccountId;
  const payerB = toAccountId(CHAIN, `CachePayerB${randomBytes(6).toString('hex')}`) as AccountId;

  function session(token: string): McpSession {
    const base = { chainId: CHAIN, label: token, paymentsAllowed: true };
    switch (token) {
      case 'personA':
        return {
          ...base,
          credentialId: 'cred-personA',
          organizationId: orgA,
          agentId: agentA,
          agentAccount: payerA,
          callerKind: McpCallerKind.HUMAN,
        } as McpSession;
      case 'personA2':
        return {
          ...base,
          credentialId: 'cred-personA2',
          organizationId: orgA,
          agentId: agentA2,
          agentAccount: payerA2,
          callerKind: McpCallerKind.HUMAN,
        } as McpSession;
      case 'machineA':
        return {
          ...base,
          credentialId: randomUUID(),
          storedCredential: true,
          organizationId: orgA,
          agentId: agentA,
          agentAccount: payerA,
          callerKind: McpCallerKind.AGENT,
        } as McpSession;
      case 'personB':
        return {
          ...base,
          credentialId: 'cred-personB',
          organizationId: orgB,
          agentId: agentB,
          agentAccount: payerB,
          callerKind: McpCallerKind.HUMAN,
        } as McpSession;
      default:
        throw McpErrors.credentialInvalid();
    }
  }

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    const redisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
    };
    redis = new Redis(redisOptions);
    pub = new Redis(redisOptions);
    sub = new Redis(redisOptions);
    const cache = new CacheService(redis);
    epochs = new TenantEpochService(cache);

    const entries = new LedgerEntryRepository(dataSource);
    const balanceRows = new AccountBalanceRepository(dataSource);
    const journal = new LedgerJournalService(entries, balanceRows, dataSource, undefined, epochs);
    ledger = new LedgerService(
      journal,
      new LedgerBalanceService(balanceRows, journal),
      new LedgerHoldService(new LedgerHoldRepository(dataSource), journal, dataSource),
    );
    const paymentIntents = new PaymentIntentRepository(dataSource);
    const gate = {
      enabled: false,
      assertAffordable: async () => undefined,
      spendable: async () => null,
    } as unknown as EscrowSpendGateService;
    balances = new BalancesService(
      ledger,
      new LedgerWithheldService(entries, paymentIntents),
      new DepositIntentRepository(dataSource),
      gate,
    );
    notifications = new NotificationsService(new NotificationRepository(dataSource), epochs);
    const agents = new AgentRepository(dataSource);
    const credentials = new AgentCredentialRepository(dataSource);
    const audit = new AuditLogWriter(dataSource);
    const config = { get: (_key: string, fallback?: unknown) => fallback } as ConfigService;
    agentsService = new AgentsService(agents, credentials, config, dataSource, audit);
    const agentCredentials = new AgentCredentialsService(
      credentials,
      agents,
      dataSource,
      audit,
      {} as never,
      new OAuthClientRepository(dataSource),
      { paymentClients: [], verifiedClients: [] },
      { pending: async () => new Map() } as unknown as LastSeenRecorder,
    );
    const debts = new (BuyerDebtService as unknown as new (
      payments: PaymentIntentRepository,
    ) => BuyerDebtService)(paymentIntents);
    const toolsetContext = toolsetTestContext({
      dataSource,
      redis,
      host: HOST,
      catalogue: new InMemoryToolCatalogue({ tools: [], bindings: [] }),
      chainId: CHAIN,
      tenantEpochs: epochs,
    });
    toolsets = toolsetContext.toolsets;
    const intents = new PaymentIntentService(
      paymentIntents,
      ledger,
      gate,
      noBlocks(),
      null,
      null,
      new FakeHeldPayments(),
      { emit: async () => undefined } as never,
    );
    disputes = new CallDisputeService(
      dataSource,
      new DisputeRepository(dataSource),
      paymentIntents,
      new VerificationRecordRepository(dataSource),
      intents,
      { forBuyer: async () => null } as never,
      audit,
      { notify: async () => ({ deliveredNow: true }) } as never,
      DEFAULT_CALL_DISPUTE_CONFIG,
      new FakeHeldPayments(),
      epochs,
    );
    payouts = new ProviderPayoutsService(entries);

    const moduleRef = await Test.createTestingModule({
      controllers: [
        BalancesController,
        ReceiptsController,
        MeStatusController,
        NotificationsController,
        AgentsController,
        ToolsetsController,
        CallDisputesController,
        ProviderCallDisputesController,
        ProviderPayoutsController,
        OperatorReferenceController,
        OperatorTestWriteController,
        OrgTestWriteController,
      ],
      providers: [
        { provide: MCP_SESSION_SOURCE, useValue: { resolve: async (t: string) => session(t) } },
        {
          provide: OPERATOR_SESSION_SOURCE,
          useValue: {
            resolve: async (token: string | null) => {
              if (token !== 'op1' && token !== 'op2') throw McpErrors.credentialInvalid();
              return {
                operatorId: token,
                subject: `${token}@`,
                displayName: token,
                email: `${token}@example.com`,
                roles: [],
              };
            },
          },
        },
        {
          provide: OperatorAuthThrottle,
          useValue: {
            assertNotBlocked: async () => undefined,
            recordFailure: async () => undefined,
          },
        },
        { provide: BalancesService, useValue: balances },
        {
          provide: ReceiptSummaryService,
          useValue: new ReceiptSummaryService(
            paymentIntents,
            new ToolCallRecordRepository(dataSource),
          ),
        },
        { provide: ReceiptService, useValue: {} },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: AccountBlockStatusService,
          useValue: new AccountBlockStatusService({
            organizationBlock: () => null,
            walletBlock: () => null,
          } as unknown as AccountBlocklistService),
        },
        { provide: BuyerDebtService, useValue: debts },
        { provide: AgentsService, useValue: agentsService },
        { provide: AgentCredentialsService, useValue: agentCredentials },
        AgentListService,
        { provide: ToolsetsService, useValue: toolsets },
        { provide: ToolsetPublishingService, useValue: toolsetContext.publishing },
        { provide: CallDisputeService, useValue: disputes },
        { provide: ProviderPayoutsService, useValue: payouts },
        { provide: PlatformHealthService, useValue: health },
        { provide: OperatorReferenceService, useValue: reference },
        { provide: getDataSourceToken('postgres'), useValue: dataSource },
        { provide: OAUTH_CLIENT_TRUST, useValue: { paymentClients: [], verifiedClients: [] } },
        { provide: REDIS_CACHE_CLIENT, useValue: redis },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    // In `bootstrapApi`'s order.
    const reflector = app.get(Reflector);
    const httpConfig = { get: (_key: string, fallback?: unknown) => fallback } as ConfigService;
    const singleFlight = new SingleFlightService(redis, pub, sub);
    app.useGlobalInterceptors(
      new TransformInterceptor(reflector),
      new CacheHeaderInterceptor(reflector, httpConfig),
      new TenantWriteEpochInterceptor(reflector, epochs),
      new SingleFlightInterceptor(reflector, singleFlight),
      new HttpCacheInterceptor(cache, reflector, httpConfig, epochs, singleFlight),
    );
    // Bound once, on 127.0.0.1 exactly: supertest then reuses this address
    // instead of an ephemeral wildcard listen per request, which another local
    // process holding the same port on 127.0.0.1 could answer.
    await app.listen(0, '127.0.0.1');

    const a = await agents.createWithOrganization({
      privyUserId: `did:privy:${randomUUID()}`,
      email: null,
      organizationName: 'cache a',
      createdVia: 'PRIVY_SIGNUP',
      label: 'Agent A',
    } as never);
    orgA = a.organizationId;
    agentA = a.id;
    agentA2 = randomUUID();
    const b = await agents.createWithOrganization({
      privyUserId: `did:privy:${randomUUID()}`,
      email: null,
      organizationName: 'cache b',
      createdVia: 'PRIVY_SIGNUP',
      label: 'Agent B',
    } as never);
    orgB = b.organizationId;
    agentB = b.id;

    await deposit(orgA, payerA, 1_000_000n);
    await deposit(orgB, payerB, 9_000_000n);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await Promise.all([redis, pub, sub].map((client) => client?.quit()));
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    health.getHealth.mockClear();
    reference.listPolicies.mockClear();
    await flushTenantCache();
  });

  /* ------------------------------------------------------------------------ */

  async function deposit(organizationId: string, account: AccountId, atomic: bigint) {
    await ledger.appendNow({
      organizationId,
      accountId: account,
      entryType: LedgerEntryType.DEPOSIT,
      money: MoneyUtil.of(atomic, USDC_ASSET, USDC_DECIMALS),
    });
  }

  /** What a TTL expiry does: every tenant entry gone, epochs untouched. */
  async function flushTenantCache() {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'http-cache:tenant:*', 'COUNT', 500);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }

  const get = (path: string, token: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set({ Authorization: `Bearer ${token}`, ...headers });

  const available = (body: { data: { balances: Array<{ available: { amount: string } }> } }) =>
    body.data.balances.reduce((sum, b) => sum + BigInt(b.available.amount), 0n);

  /* ------------------------------------------------------------------------ */

  describe('money: GET /balances, /receipts/summary, /me/status', () => {
    it('serves the second read from Redis, with the same ETag', async () => {
      const spy = jest.spyOn(balances, 'getBalances');
      const first = await get('/balances', 'personA').expect(200);
      const second = await get('/balances', 'personA').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(second.body).toEqual(first.body);
      expect(first.headers.etag).toMatch(/^W\/"tc-/);
      expect(second.headers.etag).toBe(first.headers.etag);
      // Never at the edge, always revalidated by the browser.
      expect(second.headers['cache-control']).toBe('private, no-cache');
      expect(second.headers['cdn-cache-control']).toBe('no-store');
    });

    it('a ledger write (the path every money writer takes) is visible on the next read', async () => {
      const spy = jest.spyOn(balances, 'getBalances');
      const before = available((await get('/balances', 'personA').expect(200)).body);
      await get('/balances', 'personA').expect(200);
      await deposit(orgA, payerA, 250_000n);
      const after = available((await get('/balances', 'personA').expect(200)).body);
      expect(after - before).toBe(250_000n);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('any signed-in write by the organization misses its cached reads at once', async () => {
      const spy = jest.spyOn(balances, 'getBalances');
      await get('/balances', 'personA').expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/notifications/read-all')
        .set({ Authorization: 'Bearer personA' })
        .expect((res) => expect(res.status).toBeLessThan(300));
      await get('/balances', 'personA').expect(200);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a rollback bumps nothing; a commit bumps after it, not before', async () => {
      const key = tenantEpochKey('money', orgA);
      const read = async () => (await epochs.read(orgA, ['money']))![0];
      const start = await read();
      await dataSource
        .transaction(async (manager) => {
          await epochs.bumpAfterCommit(manager, orgA, 'money');
          throw new Error('rolled back');
        })
        .catch(() => undefined);
      expect(await read()).toBe(start);
      let inside: string | null = null;
      // As a request does it: the commit hook starts the bump, the request
      // awaits it before answering.
      const bumps = { pending: [] as Promise<unknown>[] };
      await epochs.trackRequestBumps(bumps, () =>
        dataSource.transaction(async (manager) => {
          await epochs.bumpAfterCommit(manager, orgA, 'money');
          inside = await redis.get(key);
        }),
      );
      expect(bumps.pending).toHaveLength(1);
      await epochs.settleRequestBumps(bumps);
      expect(inside).toBe(start);
      expect(await read()).not.toBe(start);
    });

    it('two organizations never share an entry', async () => {
      const spy = jest.spyOn(balances, 'getBalances');
      const a = await get('/balances', 'personA').expect(200);
      const b = await get('/balances', 'personB').expect(200);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(available(b.body)).not.toBe(available(a.body));
      expect(b.headers.etag).not.toBe(a.headers.etag);
      // B's If-None-Match is never A's validator.
      await get('/balances', 'personB', { 'If-None-Match': a.headers.etag }).expect(200);
    });

    it('people of one organization share an org entry; an agent token does not', async () => {
      const spy = jest.spyOn(balances, 'getBalances');
      await get('/balances', 'personA').expect(200);
      await get('/balances', 'personA2').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      await get('/balances', 'machineA').expect(200);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a per-agent read is never shared between two agents of one organization', async () => {
      const spy = jest.spyOn(notifications, 'unreadCount');
      await get('/me/status', 'personA').expect(200);
      await get('/me/status', 'personA').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      await get('/me/status', 'personA2').expect(200);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('answers 304 without the handler only while the body is unchanged', async () => {
      const spy = jest.spyOn(balances, 'getBalances');
      const first = await get('/balances', 'personA').expect(200);
      const etag = first.headers.etag as string;

      const revalidated = await get('/balances', 'personA', { 'If-None-Match': etag }).expect(304);
      expect(revalidated.headers.etag).toBe(etag);
      expect(revalidated.headers['cache-control']).toBe('private, no-cache');
      expect(revalidated.headers['cdn-cache-control']).toBe('no-store');
      // Compared weakly: an edge that dropped the W/ still matches.
      await get('/balances', 'personA', { 'If-None-Match': etag.replace(/^W\//, '') }).expect(304);
      expect(spy).toHaveBeenCalledTimes(1);

      // Changed by a write: the old validator gets the new body.
      await deposit(orgA, payerA, 1n);
      const changed = await get('/balances', 'personA', { 'If-None-Match': etag }).expect(200);
      expect(changed.headers.etag).not.toBe(etag);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a change no epoch saw is served at most until the entry expires, then never 304', async () => {
      const first = await get('/balances', 'personA').expect(200);
      const etag = first.headers.etag as string;
      // A write that bumps nothing (straight SQL, as no production path does).
      await dataSource.query(
        `UPDATE account_balances SET available = available + 7 WHERE organization_id = $1`,
        [orgA],
      );
      await get('/balances', 'personA', { 'If-None-Match': etag }).expect(304);
      await flushTenantCache();
      const after = await get('/balances', 'personA', { 'If-None-Match': etag }).expect(200);
      expect(after.headers.etag).not.toBe(etag);
      expect(available(after.body) - available(first.body)).toBe(7n);
    });

    it('concurrent misses for one key run the handler once (single flight)', async () => {
      const real = balances.getBalances.bind(balances);
      const spy = jest.spyOn(balances, 'getBalances').mockImplementation(async (org) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return real(org);
      });
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => get('/balances', 'personA')),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(new Set(responses.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('never caches a failure', async () => {
      await get('/receipts/summary?from=not-a-date', 'personA').expect(400);
      await get('/receipts/summary?from=not-a-date', 'personA').expect(400);
      const window = 'from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z&groupBy=tool';
      await get(`/receipts/summary?${window}`, 'personA').expect(200);
    });
  });

  describe('notifications: GET /notifications/unread-count', () => {
    it("the person's own mark-read shows on the next read; other orgs keep theirs", async () => {
      await dataSource.query(
        `INSERT INTO notifications (organization_id, event, severity, title, body)
         VALUES ($1, 'balance.low', 'WARNING', 't', 'b'), ($2, 'balance.low', 'WARNING', 't', 'b')`,
        [orgA, orgB],
      );
      await epochs.bump([orgA, orgB], 'notifications');
      const spy = jest.spyOn(notifications, 'unreadCount');
      const before = (await get('/notifications/unread-count', 'personA').expect(200)).body.data
        .count as number;
      expect(before).toBeGreaterThan(0);
      const otherBefore = (await get('/notifications/unread-count', 'personB').expect(200)).body
        .data.count as number;
      await get('/notifications/unread-count', 'personA').expect(200);
      expect(spy).toHaveBeenCalledTimes(2);

      const list = await get('/notifications?unreadOnly=true', 'personA').expect(200);
      const id = list.body.data.items[0].id as string;
      await request(app.getHttpServer())
        .patch(`/api/v1/notifications/${id}/read`)
        .set({ Authorization: 'Bearer personA' })
        .expect(200);

      expect(
        (await get('/notifications/unread-count', 'personA').expect(200)).body.data.count,
      ).toBe(before - 1);
      expect(
        (await get('/notifications/unread-count', 'personB').expect(200)).body.data.count,
      ).toBe(otherBefore);
    });

    it('a new notification (NotificationService) is bumped like a read mark', async () => {
      // `NotificationService.notify` bumps the same scope after its insert;
      // the bump alone is what makes the next read fresh.
      const first = await get('/notifications/unread-count', 'personA').expect(200);
      await dataSource.query(
        `INSERT INTO notifications (organization_id, event, severity, title, body)
         VALUES ($1, 'balance.zero', 'WARNING', 't', 'b')`,
        [orgA],
      );
      await epochs.bump(orgA, 'notifications');
      const second = await get('/notifications/unread-count', 'personA').expect(200);
      expect(second.body.data.count).toBe(first.body.data.count + 1);
    });
  });

  describe('agents: GET /agents', () => {
    it('a rename via the API is visible at once', async () => {
      const spy = jest.spyOn(agentsService, 'list');
      await get('/agents', 'personA').expect(200);
      await get('/agents', 'personA').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      await request(app.getHttpServer())
        .patch(`/api/v1/agents/${agentA}`)
        .set({ Authorization: 'Bearer personA' })
        .send({ label: 'Renamed A' })
        .expect(200);
      const after = await get('/agents', 'personA').expect(200);
      expect(after.body.data.items.map((a: { label: string }) => a.label)).toContain('Renamed A');
      const other = await get('/agents', 'personB').expect(200);
      expect(other.body.data.items.map((a: { label: string }) => a.label)).not.toContain(
        'Renamed A',
      );
    });

    it("an agent token never gets a person's cached `include` answer", async () => {
      await get('/agents?include=health', 'personA').expect(200);
      await get('/agents?include=health', 'personA').expect(200);
      await get('/agents?include=health', 'machineA').expect(403);
    });
  });

  describe('toolsets: GET /toolsets', () => {
    it('a toolset created via the API is listed on the next read, only for its org', async () => {
      const spy = jest.spyOn(toolsets, 'list');
      await get('/toolsets', 'personA').expect(200);
      await get('/toolsets', 'personA').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      await request(app.getHttpServer())
        .post('/api/v1/toolsets')
        .set({ Authorization: 'Bearer personA' })
        .send({ name: `Cache set ${randomBytes(3).toString('hex')}` })
        .expect(201);
      const after = await get('/toolsets', 'personA').expect(200);
      expect(after.body.data.items.length).toBeGreaterThan(0);
      const other = await get('/toolsets', 'personB').expect(200);
      expect(other.body.data.items).toHaveLength(0);
    });
  });

  describe('disputes: buyer and provider see each other’s writes', () => {
    let disputeId: string;

    beforeAll(async () => {
      const [row] = (await dataSource.query(
        `INSERT INTO disputes (organization_id, subject_type, subject_id, state, claim_type, reason,
                               opened_by, intent_id, respondent_provider_id, evidence_snapshot)
         VALUES ($1, 'PAYMENT_INTENT', gen_random_uuid()::text, 'OPEN', 'OTHER', 'WRONG_RESULT',
                 'agent', gen_random_uuid(), $2, '{}'::jsonb)
         RETURNING id`,
        [orgA, orgB],
      )) as { id: string }[];
      disputeId = row.id;
    });

    it("the provider's reply is visible to the buyer's cached read at once", async () => {
      const spy = jest.spyOn(disputes, 'getForBuyer');
      const before = await get(`/call-disputes/${disputeId}`, 'personA').expect(200);
      await get(`/call-disputes/${disputeId}`, 'personA').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(before.body.data.providerResponse ?? null).toBeNull();

      await get('/providers/me/call-disputes', 'personB').expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/providers/me/call-disputes/${disputeId}/respond`)
        .set({ Authorization: 'Bearer personB' })
        .send({ response: 'We re-ran it.' })
        .expect((res) => expect(res.status).toBeLessThan(300));

      const after = await get(`/call-disputes/${disputeId}`, 'personA').expect(200);
      expect(after.body.data.providerResponse).toBe('We re-ran it.');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("the buyer's withdrawal is visible in the provider's cached list at once", async () => {
      const spy = jest.spyOn(disputes, 'listForProvider');
      const before = await get('/providers/me/call-disputes', 'personB').expect(200);
      await get('/providers/me/call-disputes', 'personB').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const state = (body: typeof before.body) =>
        body.data.items.find((d: { id: string }) => d.id === disputeId)?.state;
      expect(state(before.body)).toBe('OPEN');

      await request(app.getHttpServer())
        .post(`/api/v1/call-disputes/${disputeId}/withdraw`)
        .set({ Authorization: 'Bearer personA' })
        .expect((res) => expect(res.status).toBeLessThan(300));

      expect(state((await get('/providers/me/call-disputes', 'personB').expect(200)).body)).toBe(
        'WITHDRAWN',
      );
      // The buyer's own org cannot read the provider view of another org.
      const asBuyer = await get('/providers/me/call-disputes', 'personA').expect(200);
      expect(state(asBuyer.body)).toBeUndefined();
    });
  });

  describe('provider: GET /providers/me/payouts', () => {
    it('a provider credit (ledger) is visible on the next read', async () => {
      const spy = jest.spyOn(payouts, 'listPayouts');
      const before = await get('/providers/me/payouts', 'personB').expect(200);
      await get('/providers/me/payouts', 'personB').expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      await ledger.appendNow({
        organizationId: orgB,
        accountId: payerB,
        entryType: LedgerEntryType.PROVIDER_CREDIT,
        money: MoneyUtil.of(42n, USDC_ASSET, USDC_DECIMALS),
        chainTxRef: `0x${randomBytes(32).toString('hex')}`,
      });
      const after = await get('/providers/me/payouts', 'personB').expect(200);
      expect(after.body.data.items.length).toBe(before.body.data.items.length + 1);
      // Org A is not B's provider console.
      const a = await get('/providers/me/payouts', 'personA').expect(200);
      expect(a.body.data.items).toHaveLength(0);
    });
  });

  describe('operator: global key', () => {
    it('one entry for every operator, never for a session token', async () => {
      await get('/operator/health', 'op1').expect(200);
      await get('/operator/health', 'op2').expect(200);
      expect(health.getHealth).toHaveBeenCalledTimes(1);
      await get('/operator/health', 'personA').expect(401);
    });

    it("an operator's write, and an organization's, miss the console lists", async () => {
      await get('/operator/policies', 'op1').expect(200);
      await get('/operator/policies', 'op2').expect(200);
      expect(reference.listPolicies).toHaveBeenCalledTimes(1);
      await request(app.getHttpServer())
        .post('/api/v1/operator/test-write')
        .set({ Authorization: 'Bearer op1' })
        .expect(201);
      await get('/operator/policies', 'op2').expect(200);
      expect(reference.listPolicies).toHaveBeenCalledTimes(2);
      // An organization's write the console does not list leaves it cached …
      await request(app.getHttpServer())
        .post('/api/v1/test-org-write/unlisted')
        .set({ Authorization: 'Bearer personB' })
        .expect(201);
      await get('/operator/policies', 'op1').expect(200);
      expect(reference.listPolicies).toHaveBeenCalledTimes(2);
      // … one it lists does not.
      await request(app.getHttpServer())
        .post('/api/v1/test-org-write/listed')
        .set({ Authorization: 'Bearer personB' })
        .expect(201);
      await get('/operator/policies', 'op1').expect(200);
      expect(reference.listPolicies).toHaveBeenCalledTimes(3);
    });

    it('answers 304 to an operator whose validator still matches', async () => {
      const first = await get('/operator/policies', 'op1').expect(200);
      await get('/operator/policies', 'op2', { 'If-None-Match': first.headers.etag }).expect(304);
      expect(reference.listPolicies).toHaveBeenCalledTimes(1);
    });
  });

  describe('single flight: a follower never waits out a leader that already finished', () => {
    let followerRedis: Redis;
    let followerPub: Redis;
    let followerSub: Redis;
    let service: SingleFlightService;

    beforeAll(() => {
      const options = {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
      };
      followerRedis = new Redis(options);
      followerPub = new Redis(options);
      followerSub = new Redis(options);
      service = new SingleFlightService(followerRedis, followerPub, followerSub);
    });

    afterAll(async () => {
      await Promise.all([followerRedis, followerPub, followerSub].map((client) => client.quit()));
    });

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('the leader published before the follower subscribed: answers from what it left', async () => {
      const key = `race-${randomUUID()}`;
      let left: unknown;
      // Another instance holds the lock …
      await followerRedis.set(`lock:${key}`, '1', 'PX', 8000);
      const realSubscribe = followerSub.subscribe.bind(followerSub);
      jest.spyOn(followerSub, 'subscribe').mockImplementation((async (...args: [string]) => {
        // … and finishes while this follower is still subscribing.
        left = { from: 'leader' };
        await followerPub.publish(`sf:result:${key}`, JSON.stringify(left));
        await followerRedis.del(`lock:${key}`);
        await wait(100);
        return realSubscribe(...args);
      }) as never);
      const fn = jest.fn(async () => ({ from: 'follower' }));
      const started = Date.now();
      const result = await service.execute({
        key,
        fn,
        options: {
          lock: { lockTTLms: 8000 },
          wait: { maxWaitMs: 1500, recheck: async () => left },
        },
      });
      expect(result).toEqual({ from: 'leader' });
      expect(fn).not.toHaveBeenCalled();
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('the leader finished and left nothing: the follower stands for election at once', async () => {
      const key = `race-${randomUUID()}`;
      await followerRedis.set(`lock:${key}`, '1', 'PX', 8000);
      const realSubscribe = followerSub.subscribe.bind(followerSub);
      jest.spyOn(followerSub, 'subscribe').mockImplementation((async (...args: [string]) => {
        await followerRedis.del(`lock:${key}`);
        return realSubscribe(...args);
      }) as never);
      const fn = jest.fn(async () => ({ from: 'follower' }));
      const started = Date.now();
      const result = await service.execute({
        key,
        fn,
        options: { lock: { lockTTLms: 8000 }, wait: { maxWaitMs: 1500 } },
      });
      expect(result).toEqual({ from: 'follower' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('a subscriber that never answers costs the wait cap, then the caller runs itself', async () => {
      const key = `race-${randomUUID()}`;
      await followerRedis.set(`lock:${key}`, '1', 'PX', 8000);
      jest
        .spyOn(followerSub, 'subscribe')
        .mockImplementation((() => new Promise(() => undefined)) as never);
      const started = Date.now();
      await expect(
        service.execute({
          key,
          fn: async () => 'never',
          options: { lock: { lockTTLms: 8000 }, wait: { maxWaitMs: 1500 } },
        }),
      ).rejects.toBeInstanceOf(SingleFlightWaitTimeout);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
    });
  });
});
