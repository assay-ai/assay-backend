import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LastSeenRecorder } from '@shared/last-seen';
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
import { AccountBlockStatusController } from '@modules/account/controllers/account-block-status.controller';
import { AgentCredentialsController } from '@modules/account/controllers/agent-credentials.controller';
import { AgentDelegateController } from '@modules/account/controllers/agent-delegate.controller';
import { AgentsController } from '@modules/account/controllers/agents.controller';
import { NotificationsController } from '@modules/account/controllers/notifications.controller';
import { AccountBlockStatusService } from '@modules/account/services/account-block-status.service';
import { AgentCredentialsService } from '@modules/account/services/agent-credentials.service';
import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { AgentListService } from '@modules/account/services/agent-list.service';
import { AgentsService } from '@modules/account/services/agents.service';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { MeStatusController } from '@modules/dashboard/controllers/me-status.controller';
import { OverviewController } from '@modules/dashboard/controllers/overview.controller';
import { OverviewService } from '@modules/dashboard/services/overview.service';
import { loadCallDisputeConfig } from '@modules/dispute/constants/call-dispute.config';
import { RefundEligibilityService } from '@modules/dispute/services/refund-eligibility.service';
import { BalancesController } from '@modules/ledger/controllers/balances.controller';
import { DepositsController } from '@modules/ledger/controllers/deposits.controller';
import { HoldsController } from '@modules/ledger/controllers/holds.controller';
import { WithheldController } from '@modules/ledger/controllers/withheld.controller';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { BalancesService } from '@modules/ledger/services/balances.service';
import { DepositsService } from '@modules/ledger/services/deposits.service';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { HoldsService } from '@modules/ledger/services/holds.service';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerWithheldService } from '@modules/ledger/services/ledger-withheld.service';
import { MCP_SESSION_SOURCE, McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { EscrowController } from '@modules/payment/controllers/escrow.controller';
import { ToolCallsController } from '@modules/payment/controllers/tool-calls.controller';
import {
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { BuyerDebtService } from '@modules/payment/services/buyer-debt.service';
import { NextSeqService } from '@modules/payment/services/next-seq.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { ToolCallsService } from '@modules/payment/services/tool-calls.service';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';
import { ReceiptsController } from '@modules/verification/controllers/receipts.controller';
import { ReceiptService } from '@modules/verification/services/receipt.service';
import { ReceiptSummaryService } from '@modules/verification/services/receipt-summary.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';
import { MoneyUtil } from '@shared/utils/money.util';
import { ConfigService } from '@nestjs/config';
import { AuditLogWriter } from '@shared/audit';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { OAUTH_CLIENT_TRUST } from '@modules/oauth/domain/credential-client-view';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { getDataSourceToken } from '@nestjs/typeorm';

import { noBlocks } from '../../unit/helpers/blocklist';
import {
  USDC_ASSET,
  USDC_DECIMALS,
  ensureTestDatabase,
  resetSchemaIfMigrationsChanged,
  testConnectionOptions,
} from '../helpers/test-database';

const DAY_MS = 86_400_000;
const CHAIN = CHAIN_IDS.SOLANA_MAINNET;
const OTHER_ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
const TOOL_A = '0a000000-0000-4000-8000-00000000000a';
const TOOL_B = '0b000000-0000-4000-8000-00000000000b';
const TOOL_C = '0c000000-0000-4000-8000-00000000000c';
const TOOL_Z = '0f000000-0000-4000-8000-00000000000f';

/* ---------------------------------------------------------------------------
 * The browser's own window arithmetic, copied verbatim from the dashboard
 * (`features/buyer/period.ts` `monthPeriod` / `dayPeriod` / `recentDays`,
 * `libs/utc-time.ts` `utcDayBounds`). The old routes are asked with THESE
 * windows — exactly what `useOverview` sends — and `GET /overview`, given only
 * the anchor, must answer for the same ones.
 * ------------------------------------------------------------------------- */

function monthPeriod(anchor: Date) {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const from = new Date(Date.UTC(y, m, 1));
  const to = new Date(Date.UTC(y, m + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

function dayPeriod(anchor: Date) {
  const from = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()),
  );
  const to = new Date(from.getTime() + 86_400_000);
  const key = from.toISOString().slice(0, 10);
  return { from: from.toISOString(), to: to.toISOString(), key };
}

function recentDays(anchor: Date, count: number) {
  return Array.from({ length: count }, (_, i) =>
    dayPeriod(new Date(anchor.getTime() - (count - 1 - i) * 86_400_000)),
  );
}

function utcDayBounds(anchor: Date | number, options: { offsetDays?: number } = {}) {
  const at = typeof anchor === 'number' ? anchor : anchor.getTime();
  const day = Math.floor(at / DAY_MS) * DAY_MS + (options.offsetDays ?? 0) * DAY_MS;
  return { from: new Date(day).toISOString(), to: new Date(day + DAY_MS).toISOString() };
}

/* ---------------------------------------------------------------------------
 * What the dashboard derives from `GET /agents/:id/credentials` today, copied
 * from `agent-readiness.ts` (`credentialIsLive`, `lastCallAt`), `get-started.tsx`
 * (`liveKeys`, `firstCallSeen`, `firstCallAt`) and `agents-view.tsx`
 * (`latestUse`). `health` must say the same.
 * ------------------------------------------------------------------------- */

interface KeyRow {
  revokedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  delegateAccount?: string | null;
}

function browserHealth(keys: KeyRow[], nowMs: number) {
  const credentialIsLive = (c: KeyRow) =>
    !c.revokedAt && (!c.expiresAt || Date.parse(c.expiresAt) > nowMs);
  const live = keys.filter(credentialIsLive);
  const lastCallAt =
    live
      .map((c) => c.lastUsedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ?? null;
  const liveKeys = keys.filter((k) => !k.revokedAt);
  const firstCallAt =
    liveKeys
      .map((k) => k.lastUsedAt)
      .filter((v): v is string => Boolean(v))
      .sort()[0] ?? null;
  const used = keys.map((key) => key.lastUsedAt).filter((at): at is string => Boolean(at));
  const latestUse =
    used.length === 0 ? null : used.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  const bound = live.filter((c) => c.delegateAccount);
  return {
    liveKeyCount: live.length,
    unrevokedKeyCount: liveKeys.length,
    keyBound: bound.length > 0,
    boundKeyCount: bound.length,
    firstCallSeen: liveKeys.some((k) => k.lastUsedAt),
    lastUsedAt: lastCallAt,
    earliestLastUsedAt: firstCallAt,
    lastUsedAtAnyKey: latestUse,
  };
}

/**
 * The composite reads (`GET /overview`, `GET /receipts/summary/daily`,
 * `GET /me/status`, `GET /agents?include=`, `GET /deposits/:id`,
 * `GET /agents/me/delegate/status`) against the routes they stand for, over
 * real HTTP, on one seeded Postgres: every part must deep-equal the old
 * route's `data` for the same parameters. Only the chain is faked (the escrow
 * figure on `/balances`, the delegate list on `/agents/me/delegate`), and the
 * same fake serves both sides.
 */
// Stamps `LastSeenRecorder` holds and has not written yet; empty unless a test sets one.
const bufferedStamps = new Map<string, Date>();
const bufferedLastUse = {
  pending: async (_kind: unknown, keys: readonly string[]) =>
    new Map(
      keys.flatMap((key) => {
        const at = bufferedStamps.get('*');
        return at ? [[key, at] as const] : [];
      }),
    ),
};

describe('composite dashboard reads equal the routes they stand for', () => {
  const DATABASE = 'assay_dashboard_test';
  const AT = new Date('2026-10-20T10:30:00.000Z');
  let dataSource: DataSource;
  let app: INestApplication;
  let intents: PaymentIntentService;
  let ledgerService: LedgerService;
  let agents: AgentRepository;
  let organizationId: string;
  let otherOrganizationId: string;
  let agentId: string;
  const payer = toAccountId(CHAIN, `DashPayer${randomBytes(8).toString('hex')}`) as AccountId;
  let machineCredentialId: string;

  const blocklist = {
    organizationBlock: () => null,
    walletBlock: (account: string | null) =>
      account === payer
        ? {
            subjectKind: BlockSubjectKind.WALLET,
            subject: payer,
            reasonCode: 'TEST',
            blockedAt: '2026-10-01T00:00:00.000Z',
          }
        : null,
  } as unknown as AccountBlocklistService;

  function session(callerKind: McpCallerKind, org = organizationId): McpSession {
    return {
      credentialId: callerKind === McpCallerKind.AGENT ? machineCredentialId : 'cred-person',
      organizationId: org,
      agentId,
      agentAccount: payer,
      chainId: CHAIN,
      label: 'Dash agent',
      callerKind,
      paymentsAllowed: true,
      storedCredential: callerKind === McpCallerKind.AGENT,
    } as McpSession;
  }

  beforeAll(async () => {
    await ensureTestDatabase(DATABASE);
    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [join(__dirname, '../../../src/database/postgres/entities/*.entity.ts')],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });
    await dataSource.initialize();
    await resetSchemaIfMigrationsChanged(dataSource);
    await dataSource.runMigrations({ transaction: 'each' });

    const paymentIntents = new PaymentIntentRepository(dataSource);
    const entries = new LedgerEntryRepository(dataSource);
    const balanceRows = new AccountBalanceRepository(dataSource);
    const journal = new LedgerJournalService(entries, balanceRows, dataSource);
    const ledgerBalances = new LedgerBalanceService(balanceRows, journal);
    const ledgerHolds = new LedgerHoldService(
      new LedgerHoldRepository(dataSource),
      journal,
      dataSource,
    );
    const ledger = new LedgerService(journal, ledgerBalances, ledgerHolds);
    ledgerService = ledger;
    const gate = {
      enabled: false,
      assertAffordable: async () => undefined,
      // The chain half of `/balances`: one deterministic figure for both sides.
      spendable: async () => ({
        chain: MoneyUtil.of(7_000_000n, USDC_ASSET, USDC_DECIMALS),
        spendable: MoneyUtil.of(6_000_000n, USDC_ASSET, USDC_DECIMALS),
      }),
    } as unknown as EscrowSpendGateService;
    intents = new PaymentIntentService(paymentIntents, ledger, gate, noBlocks());
    agents = new AgentRepository(dataSource);
    const credentials = new AgentCredentialRepository(dataSource);

    const balances = new BalancesService(
      ledger,
      new LedgerWithheldService(entries, paymentIntents),
      new DepositIntentRepository(dataSource),
      gate,
    );
    const holds = new HoldsService(new LedgerHoldRepository(dataSource));
    const summaries = new ReceiptSummaryService(
      paymentIntents,
      new ToolCallRecordRepository(dataSource),
    );
    const toolCalls = new ToolCallsService(
      paymentIntents,
      new VerificationRecordRepository(dataSource),
    );
    const refunds = new RefundEligibilityService(
      new DisputeRepository(dataSource),
      loadCallDisputeConfig(),
      { holdLive: async () => false } as never,
    );
    const notifications = new NotificationsService(new NotificationRepository(dataSource));
    const blockStatus = new AccountBlockStatusService(blocklist);
    // `list` reads the repository alone; nothing else is reached.
    const debts = new (BuyerDebtService as unknown as new (
      payments: PaymentIntentRepository,
    ) => BuyerDebtService)(paymentIntents);
    const config = { get: (_key: string, fallback: string) => fallback } as ConfigService;
    const agentCredentials = new AgentCredentialsService(
      credentials,
      agents,
      dataSource,
      {} as AuditLogWriter,
      {} as AccessEpochService,
      new OAuthClientRepository(dataSource),
      { paymentClients: [], verifiedClients: [] },
      bufferedLastUse as unknown as LastSeenRecorder,
    );
    const delegate = new AgentDelegateService(
      credentials,
      {} as ChainAdapterRegistry,
      {} as never,
      { list: async () => [] } as unknown as EscrowDelegationService,
    );

    const sessions = {
      resolve: async (token: string | null) => {
        if (token === 'person') return session(McpCallerKind.HUMAN);
        if (token === 'machine') return session(McpCallerKind.AGENT);
        if (token === 'other') return session(McpCallerKind.HUMAN, otherOrganizationId);
        throw McpErrors.credentialInvalid();
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [
        BalancesController,
        HoldsController,
        WithheldController,
        DepositsController,
        ReceiptsController,
        ToolCallsController,
        NotificationsController,
        AccountBlockStatusController,
        EscrowController,
        AgentsController,
        AgentCredentialsController,
        AgentDelegateController,
        OverviewController,
        MeStatusController,
      ],
      providers: [
        { provide: MCP_SESSION_SOURCE, useValue: sessions },
        { provide: BalancesService, useValue: balances },
        { provide: HoldsService, useValue: holds },
        {
          provide: DepositsService,
          useValue: new DepositsService(
            new DepositIntentRepository(dataSource),
            new LedgerEntryRepository(dataSource),
          ),
        },
        { provide: ReceiptSummaryService, useValue: summaries },
        { provide: ReceiptService, useValue: {} },
        { provide: ToolCallsService, useValue: toolCalls },
        { provide: RefundEligibilityService, useValue: refunds },
        { provide: NotificationsService, useValue: notifications },
        { provide: AccountBlockStatusService, useValue: blockStatus },
        { provide: BuyerDebtService, useValue: debts },
        { provide: NextSeqService, useValue: {} },
        {
          provide: AgentsService,
          useValue: new AgentsService(
            agents,
            credentials,
            config,
            dataSource,
            {} as AuditLogWriter,
          ),
        },
        { provide: AgentCredentialsService, useValue: agentCredentials },
        AgentListService,
        { provide: AgentDelegateService, useValue: delegate },
        {
          provide: OverviewService,
          useValue: new OverviewService(
            balances,
            holds,
            summaries,
            toolCalls,
            refunds,
            notifications,
          ),
        },
        // Unused by the routes under test; present so the module compiles.
        { provide: getDataSourceToken('postgres'), useValue: dataSource },
        { provide: OAUTH_CLIENT_TRUST, useValue: { paymentClients: [], verifiedClients: [] } },
        { provide: REDIS_CACHE_CLIENT, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // As `bootstrapApi` wires it: the old routes go through the same pipe.
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

    await seed();

    // Every "now" a route reads in JS (a hold's age, the refund window, the
    // pending-deposit deadline, a key's expiry) is one instant for both sides.
    jest.useFakeTimers({
      now: Date.now(),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  }, 300_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  /* ------------------------------------------------------------------------ */

  async function fund(atomic: bigint): Promise<void> {
    await ledgerService.appendNow({
      organizationId,
      accountId: payer,
      entryType: LedgerEntryType.DEPOSIT,
      money: MoneyUtil.of(atomic, USDC_ASSET, USDC_DECIMALS),
    });
  }

  type Outcome = 'SETTLED' | 'REFUNDED' | 'VOIDED' | 'SECURED';

  /** A paid call by the payer, driven to `outcome`, then dated `createdAt`. */
  async function call(
    toolId: string,
    outcome: Outcome,
    createdAt: string,
    priceAtomic = 100_000n,
  ): Promise<string> {
    const provider = randomUUID();
    const intent = await intents.create({
      organizationId,
      agentId,
      agentAccount: payer,
      toolId,
      rail: PaymentRail.RAIL_B_VOUCHER,
      callId: randomUUID(),
      callClass: PaymentIntentCallClass.PAID,
      price: MoneyUtil.of(priceAtomic, USDC_ASSET, USDC_DECIMALS),
      platformFee: MoneyUtil.of(priceAtomic / 10n, USDC_ASSET, USDC_DECIMALS),
      requestHash: `sha256:${randomBytes(16).toString('hex')}`,
      chainId: CHAIN,
      voucherSeq: String(randomInt(1, 2 ** 47)),
    });
    await intents.secureFunds(organizationId, intent.id);
    if (outcome !== 'SECURED') {
      await intents.transition(
        organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        { reason: 'forwarded' },
      );
    }
    if (outcome === 'VOIDED') {
      await intents.resolve(
        organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VOIDED,
        { reason: 'provider error', providerId: provider },
      );
    } else if (outcome === 'SETTLED' || outcome === 'REFUNDED') {
      await intents.resolve(
        organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VERIFYING,
        {
          reason: 'data result',
          providerId: provider,
          providerAccount: toAccountId(CHAIN, `Provider${provider.slice(0, 8)}`) as AccountId,
        },
      );
      await intents.resolve(
        organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        outcome === 'SETTLED' ? PaymentIntentStatus.SETTLED : PaymentIntentStatus.REFUNDED,
        {
          reason: outcome === 'SETTLED' ? 'verification passed' : 'verification failed',
          verificationVerdict: outcome === 'SETTLED' ? 'PASS' : 'FAIL',
        },
      );
    }
    // A literal, so microseconds survive: the edge of a day is the case.
    await dataSource.query(
      `UPDATE payment_intents SET created_at = $2::timestamptz WHERE id = $1`,
      [intent.id, createdAt],
    );
    return intent.id;
  }

  async function credential(
    agent: string,
    fields: {
      createdAt?: string;
      lastUsedAt?: string | null;
      expiresAt?: string | null;
      revokedAt?: string | null;
      delegateAccount?: string | null;
      oauthClientId?: string | null;
      id?: string;
    } = {},
  ): Promise<string> {
    const id = fields.id ?? randomUUID();
    await dataSource.query(
      `INSERT INTO agent_credentials
         (id, organization_id, agent_id, name, prefix, token_hash, scopes, created_at,
          last_used_at, expires_at, revoked_at, delegate_account, delegate_bound_at,
          issued_via, oauth_client_id, revoked_by)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', COALESCE($7::timestamptz, now()), $8, $9, $10,
               $11, CASE WHEN $11::varchar IS NULL THEN NULL ELSE now() END,
               CASE WHEN $12::uuid IS NULL THEN 'API_KEY' ELSE 'OAUTH' END, $12,
               CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE 'test' END)`,
      [
        id,
        organizationId,
        agent,
        `key ${id.slice(0, 6)}`,
        fields.oauthClientId ? null : `assay_sk_${id.slice(0, 6)}`,
        fields.oauthClientId ? null : `hash-${id}`,
        fields.createdAt ?? null,
        fields.lastUsedAt ?? null,
        fields.expiresAt ?? null,
        fields.revokedAt ?? null,
        fields.delegateAccount ?? null,
        fields.oauthClientId ?? null,
      ],
    );
    return id;
  }

  let agentWithMany: string;
  let agentWithNone: string;
  let depositId: string;

  async function seed(): Promise<void> {
    const provisioned = await agents.createWithOrganization({
      privyUserId: `did:privy:${randomUUID()}`,
      email: null,
      organizationName: 'dash',
      createdVia: 'PRIVY_SIGNUP',
      label: 'Dash agent',
    } as never);
    organizationId = provisioned.organizationId;
    agentId = provisioned.id;
    const other = await agents.createWithOrganization({
      privyUserId: `did:privy:${randomUUID()}`,
      email: null,
      organizationName: 'other',
      createdVia: 'PRIVY_SIGNUP',
      label: 'Other agent',
    } as never);
    otherOrganizationId = other.organizationId;

    await fund(100_000_000n);

    // Around every edge the windows have: the month, the chart's first day,
    // yesterday/today, to the millisecond and below it.
    await call(TOOL_A, 'SETTLED', '2026-09-30 23:59:59.999+00');
    await call(TOOL_A, 'SETTLED', '2026-10-01 00:00:00+00');
    await call(TOOL_A, 'SETTLED', '2026-10-13 23:59:59.999999+00');
    await call(TOOL_B, 'SETTLED', '2026-10-14 00:00:00+00');
    await call(TOOL_C, 'SECURED', '2026-10-17 12:00:00+00');
    await call(TOOL_A, 'REFUNDED', '2026-10-19 23:59:59.999+00');
    await call(TOOL_B, 'VOIDED', '2026-10-19 23:59:59.9995+00');
    await call(TOOL_B, 'SETTLED', '2026-10-19 12:00:00.000123+00', 250_000n);
    await call(TOOL_A, 'SETTLED', '2026-10-20 00:00:00+00');
    await call(TOOL_C, 'SETTLED', '2026-10-20 00:00:00.000001+00', 300_000n);
    await call(TOOL_A, 'SETTLED', '2026-10-21 00:00:00+00');
    // An open buyer debt of this payer: what `/escrow/debts` lists.
    const owed = await call(TOOL_B, 'SETTLED', '2026-10-18 08:00:00+00');
    await dataSource.query(
      `UPDATE payment_intents
          SET redemption_last_error = 'DelegateIsRevoked',
              redemption_lapsed_at = now(), hold_released_at = NULL
        WHERE id = $1`,
      [owed],
    );

    for (const [event, read] of [
      ['balance.low', false],
      ['payment_intent.refunded', true],
      ['balance.zero', false],
    ] as const) {
      await dataSource.query(
        `INSERT INTO notifications (organization_id, event, severity, title, body, read_at)
         VALUES ($1, $2, 'WARNING', $2, 'body', CASE WHEN $3::boolean THEN now() ELSE NULL END)`,
        [organizationId, event, read],
      );
    }

    const [deposit] = (await dataSource.query(
      `INSERT INTO deposit_intents (organization_id, status, agent_id, agent_account, asset_id,
                                    decimals, requested_amount, chain_id, expires_at)
       VALUES ($1, 'CREATED', $2, $3, $4, 6, 5000000, $5, now() + interval '1 hour')
       RETURNING id`,
      [organizationId, agentId, payer, USDC_ASSET, CHAIN],
    )) as { id: string }[];
    depositId = deposit.id;

    // Credentials: live, bound, revoked-but-used-last, expired, an OAuth grant,
    // and two in the same millisecond (ordered by the microsecond).
    const [client] = (await dataSource.query(
      `INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris, metadata)
       VALUES ($1, 'DCR', 'Example client', ARRAY['http://127.0.0.1:33418/callback'], '{}')
       RETURNING id`,
      [`dcr_${randomBytes(11).toString('hex')}`],
    )) as { id: string }[];
    machineCredentialId = await credential(agentId, {
      createdAt: '2026-10-10 09:00:00.123456+00',
      lastUsedAt: '2026-10-19 08:00:00+00',
      delegateAccount: `${CHAIN_IDS.ROBINHOOD_TESTNET}:0x${randomBytes(20).toString('hex')}`,
    });
    await credential(agentId, {
      createdAt: '2026-10-10 09:00:00.123789+00',
      lastUsedAt: '2026-10-20 08:00:00+00',
      revokedAt: '2026-10-20 09:00:00+00',
    });
    await credential(agentId, {
      createdAt: '2026-10-11 09:00:00+00',
      lastUsedAt: '2026-10-12 08:00:00+00',
      expiresAt: '2026-10-15 00:00:00+00',
    });
    await credential(agentId, { createdAt: '2026-10-12 09:00:00+00', oauthClientId: client.id });
    // Soft-deleted, and the newest: it must not take a place in the ranked page.
    const deleted = await credential(agentId, { createdAt: '2026-10-19 09:00:00+00' });
    await dataSource.query(`UPDATE agent_credentials SET deleted_at = now() WHERE id = $1`, [
      deleted,
    ]);

    const [{ id: many }] = (await dataSource.query(
      `INSERT INTO agents (organization_id, privy_user_id, label) VALUES ($1, $2, 'Many keys')
       RETURNING id`,
      [organizationId, `did:privy:${randomUUID()}`],
    )) as { id: string }[];
    agentWithMany = many;
    for (let i = 0; i < 53; i += 1) {
      await credential(many, {
        // Three share one instant: the id breaks the tie.
        createdAt:
          i < 3 ? '2026-10-01 00:00:00+00' : `2026-10-01 00:${String(i).padStart(2, '0')}:00+00`,
        lastUsedAt: i % 2 === 0 ? `2026-10-0${(i % 9) + 1} 10:00:00+00` : null,
      });
    }
    const [{ id: none }] = (await dataSource.query(
      `INSERT INTO agents (organization_id, privy_user_id, label) VALUES ($1, $2, 'No keys')
       RETURNING id`,
      [organizationId, `did:privy:${randomUUID()}`],
    )) as { id: string }[];
    agentWithNone = none;
  }

  /* ------------------------------------------------------------------------ */

  async function get(path: string, query: Record<string, string> = {}, token = 'person') {
    const res = await request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
    return res;
  }

  async function data(path: string, query: Record<string, string> = {}, token = 'person') {
    const res = await get(path, query, token);
    expect({ path, status: res.status }).toEqual({ path, status: 200 });
    return res.body.data;
  }

  describe('GET /overview', () => {
    it('answers, part for part, what useOverview’s 14 requests answer', async () => {
      const month = monthPeriod(AT);
      const today = utcDayBounds(AT);
      const yesterday = utcDayBounds(AT, { offsetDays: -1 });
      const days = recentDays(AT, 7);

      const overview = await data('/overview', { at: AT.toISOString() });

      expect(overview.at).toBe(AT.toISOString());
      expect(overview.windows).toEqual({ month, today, yesterday, days });

      expect(overview.balances).toEqual(await data('/balances'));
      expect(overview.holds).toEqual(await data('/holds'));
      expect(overview.withheld).toEqual(await data('/withheld', month));
      expect(overview.monthSummary).toEqual(
        await data('/receipts/summary', { ...month, groupBy: 'day' }),
      );
      expect(overview.todaySummary).toEqual(
        await data('/receipts/summary', { ...today, groupBy: 'tool' }),
      );
      expect(overview.yesterdaySummary).toEqual(
        await data('/receipts/summary', { ...yesterday, groupBy: 'tool' }),
      );
      const perDay: unknown[] = [];
      for (const d of days) {
        perDay.push(await data('/receipts/summary', { from: d.from, to: d.to, groupBy: 'tool' }));
      }
      expect(overview.chart).toEqual({
        days: days.map((d, i) => ({ key: d.key, from: d.from, to: d.to, summary: perDay[i] })),
      });
      expect(overview.recentCalls).toEqual(
        await data('/tool-calls', { limit: '6', sort: 'createdAt', order: 'desc' }),
      );
      expect(overview.notifications).toEqual(
        await data('/notifications', { limit: '50', unreadOnly: 'true' }),
      );

      // The seed is not vacuous: every part has something in it.
      expect(overview.holds.items.length).toBeGreaterThan(0);
      expect(overview.monthSummary.groups.length).toBeGreaterThan(5);
      expect(overview.todaySummary.totals.calls).toBe(2);
      expect(overview.yesterdaySummary.totals.calls).toBe(3);
      expect(overview.chart.days.map((d: any) => d.summary.totals.calls)).toEqual([
        1, 0, 0, 1, 1, 3, 2,
      ]);
      expect(overview.recentCalls.items).toHaveLength(6);
      expect(overview.notifications.items).toHaveLength(2);
    });

    it('passes asset and the limits through exactly as the old routes take them', async () => {
      const today = utcDayBounds(AT);
      const overview = await data('/overview', {
        at: AT.toISOString(),
        asset: USDC_ASSET,
        callsLimit: '2',
        alertsLimit: '1',
      });
      expect(overview.todaySummary).toEqual(
        await data('/receipts/summary', { ...today, groupBy: 'tool', asset: USDC_ASSET }),
      );
      expect(overview.recentCalls).toEqual(
        await data('/tool-calls', { limit: '2', sort: 'createdAt', order: 'desc' }),
      );
      expect(overview.notifications).toEqual(
        await data('/notifications', { limit: '1', unreadOnly: 'true' }),
      );
      expect(overview.notifications.pageInfo.hasMore).toBe(true);
    });

    it('is scoped to the session’s organization', async () => {
      const overview = await data('/overview', { at: AT.toISOString() }, 'other');
      expect(overview.holds.items).toEqual([]);
      expect(overview.monthSummary.totals.calls).toBe(0);
      expect(overview.recentCalls.items).toEqual([]);
    });

    it('refuses a malformed anchor or limit through the global pipe', async () => {
      expect((await get('/overview', { at: 'yesterday' })).status).toBe(400);
      // ISO 8601 that `Date` cannot read: a 400 too, never a RangeError 500.
      expect((await get('/overview', { at: '2026-W43' })).status).toBe(400);
      expect((await get('/overview', { at: '2026-293' })).status).toBe(400);
      expect((await get('/overview', { callsLimit: '0' })).status).toBe(400);
      expect((await get('/overview', { callsLimit: '101' })).status).toBe(400);
      expect((await get('/overview', { extra: '1' })).status).toBe(400);
    });
  });

  describe('GET /receipts/summary/daily', () => {
    it.each(['tool', 'provider', 'status', 'verdict', 'day'])(
      'groupBy=%s equals one /receipts/summary call per UTC day, edges included',
      async (groupBy) => {
        const from = '2026-09-28T00:00:00.000Z';
        const to = '2026-10-22T00:00:00.000Z';
        const daily = await data('/receipts/summary/daily', { from, to, groupBy });
        expect(daily.days).toHaveLength(24);
        for (const day of daily.days) {
          expect(day.to).toBe(new Date(Date.parse(day.from) + DAY_MS).toISOString());
          expect(day.summary).toEqual(
            await data('/receipts/summary', { from: day.from, to: day.to, groupBy }),
          );
        }
      },
    );

    it('a day spanning two assets: the same refusal without asset, the same answer with it', async () => {
      const moved = await call(TOOL_Z, 'SETTLED', '2026-10-05 05:00:00+00');
      await call(TOOL_Z, 'SETTLED', '2026-10-05 06:00:00+00');
      await dataSource.query(`UPDATE payment_intents SET asset_id = $2 WHERE id = $1`, [
        moved,
        OTHER_ASSET,
      ]);
      const day = { from: '2026-10-05T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z' };

      const single = await get('/receipts/summary', { ...day, groupBy: 'tool' });
      const daily = await get('/receipts/summary/daily', { ...day, groupBy: 'tool' });
      expect(single.status).toBe(422);
      expect(daily.status).toBe(single.status);
      expect(daily.body.errorCode ?? daily.body.code).toBe(
        single.body.errorCode ?? single.body.code,
      );

      for (const asset of [USDC_ASSET, OTHER_ASSET]) {
        const answer = await data('/receipts/summary/daily', { ...day, groupBy: 'tool', asset });
        expect(answer.days[0].summary).toEqual(
          await data('/receipts/summary', { ...day, groupBy: 'tool', asset }),
        );
      }
    });

    it.each([
      ['not a midnight', '2026-10-01T00:00:00.001Z', '2026-10-02T00:00:00.000Z'],
      ['an empty window', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
      ['a reversed window', '2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
      ['more than 31 days', '2026-09-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z'],
    ])('refuses %s with 400', async (_name, from, to) => {
      const res = await get('/receipts/summary/daily', { from, to, groupBy: 'tool' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('VERIFICATION_SUMMARY_INVALID_RANGE');
    });
  });

  describe('GET /me/status', () => {
    it('is the three shell polls, each as its own route answers it', async () => {
      const status = await data('/me/status');
      expect(status).toEqual({
        blockStatus: await data('/account/block-status'),
        unreadCount: await data('/notifications/unread-count'),
        debts: await data('/escrow/debts'),
      });
      expect(status.blockStatus.blocked).toBe(true);
      expect(status.unreadCount.count).toBe(2);
      expect(status.debts.debts).toHaveLength(1);
    });

    it('answers an agent credential as the three routes do', async () => {
      expect(await data('/me/status', {}, 'machine')).toEqual({
        blockStatus: await data('/account/block-status', {}, 'machine'),
        unreadCount: await data('/notifications/unread-count', {}, 'machine'),
        debts: await data('/escrow/debts', {}, 'machine'),
      });
    });
  });

  describe('GET /agents?include=credentials,health', () => {
    it('nests each agent’s first credentials page and the health the dashboard derives', async () => {
      const plain = await data('/agents', { limit: '50' });
      const rich = await data('/agents', { limit: '50', include: 'credentials,health' });

      expect(rich.pageInfo).toEqual(plain.pageInfo);
      // The row itself is unchanged: only the two asked-for fields are added.
      expect(
        rich.items.map((agent: any) => {
          const row = { ...agent };
          delete row.credentials;
          delete row.health;
          return row;
        }),
      ).toEqual(plain.items);
      expect(rich.items.map((agent: any) => agent.agentId).sort()).toEqual(
        [agentId, agentWithMany, agentWithNone].sort(),
      );

      for (const agent of rich.items) {
        // `use-agents.ts`: limit 50 and a 1970 `from` that filters nothing.
        const old = await data(`/agents/${agent.agentId}/credentials`, {
          limit: '50',
          from: new Date(1).toISOString(),
        });
        expect(agent.credentials).toEqual({ items: old.items, hasMore: old.pageInfo.hasMore });
        const { evaluatedAt, ...health } = agent.health;
        expect(health).toEqual(browserHealth(old.items, Date.parse(evaluatedAt)));
      }

      const byId = new Map(rich.items.map((agent: any) => [agent.agentId, agent]));
      const mine: any = byId.get(agentId);
      expect(mine.health).toMatchObject({
        liveKeyCount: 2,
        unrevokedKeyCount: 3,
        keyBound: true,
        firstCallSeen: true,
        lastUsedAt: '2026-10-19T08:00:00.000Z',
        earliestLastUsedAt: '2026-10-12T08:00:00.000Z',
        lastUsedAtAnyKey: '2026-10-20T08:00:00.000Z',
      });
      expect(mine.credentials.items[0].oauthClient).toMatchObject({ name: 'Example client' });
      const many: any = byId.get(agentWithMany);
      expect(many.credentials.items).toHaveLength(50);
      expect(many.credentials.hasMore).toBe(true);
      expect(byId.get(agentWithNone)).toMatchObject({
        credentials: { items: [], hasMore: false },
        health: { liveKeyCount: 0, keyBound: false, lastUsedAt: null },
      });
    });

    it('overlays a last use not yet written exactly as the credentials route does', async () => {
      bufferedStamps.set('*', new Date('2026-10-21T00:00:00.000Z'));
      try {
        const rich = await data('/agents', { limit: '50', include: 'credentials,health' });
        for (const agent of rich.items) {
          const old = await data(`/agents/${agent.agentId}/credentials`, {
            limit: '50',
            from: new Date(1).toISOString(),
          });
          expect(agent.credentials).toEqual({ items: old.items, hasMore: old.pageInfo.hasMore });
          if (old.items.length > 0) {
            expect(old.items.every((k: any) => k.lastUsedAt === '2026-10-21T00:00:00.000Z')).toBe(
              true,
            );
          }
        }
      } finally {
        bufferedStamps.clear();
      }
    });

    it('adds only what was asked for', async () => {
      const onlyHealth = await data('/agents', { include: 'health' });
      expect(onlyHealth.items.every((a: any) => a.health && !('credentials' in a))).toBe(true);
    });

    it('gives an agent credential its own agent only, as the credentials route does', async () => {
      // BUG-DEMO-02: an agent reads its own agent's credential metadata.
      const page = await data('/agents', { include: 'health' }, 'machine');
      expect(page.items.length).toBeGreaterThan(0);
      for (const row of page.items) expect('health' in row).toBe(row.agentId === agentId);
      expect((await get(`/agents/${agentId}/credentials`, {}, 'machine')).status).toBe(200);
      // Without include the list is open to it, as before.
      expect((await get('/agents', {}, 'machine')).status).toBe(200);
      expect((await get('/agents', { include: 'secrets' })).status).toBe(400);
    });
  });

  describe('GET /deposits/:depositId', () => {
    it('is the row GET /deposits lists', async () => {
      const list = await data('/deposits');
      const row = list.items.find((item: any) => item.id === depositId);
      expect(row).toBeDefined();
      expect(await data(`/deposits/${depositId}`)).toEqual(row);
    });

    it('is a 404 in another organization and for an unknown id, a 400 for a non-uuid', async () => {
      const elsewhere = await get(`/deposits/${depositId}`, {}, 'other');
      expect(elsewhere.status).toBe(404);
      expect(JSON.stringify(elsewhere.body)).toContain('PAYMENT_DEPOSIT_NOT_FOUND');
      expect((await get(`/deposits/${randomUUID()}`)).status).toBe(404);
      expect((await get('/deposits/not-a-uuid')).status).toBe(400);
    });
  });

  describe('deposit finality', () => {
    // After the composite reads on purpose: it moves money into this payer's
    // pending and available buckets, which they compare.
    it('says PENDING while the finality sweep is out, then CONFIRMED or REJECTED', async () => {
      const settled = async (): Promise<string> => {
        const txRef = `tx-${randomBytes(8).toString('hex')}`;
        const [row] = (await dataSource.query(
          `INSERT INTO deposit_intents (organization_id, status, agent_id, agent_account, asset_id,
                                        decimals, requested_amount, settled_amount, chain_id,
                                        chain_tx_ref, expires_at)
           VALUES ($1, 'SETTLED', $2, $3, $4, 6, 1000000, 1000000, $5, $6,
                   now() + interval '1 hour')
           RETURNING id`,
          [organizationId, agentId, payer, USDC_ASSET, CHAIN, txRef],
        )) as { id: string }[];
        await ledgerService.appendNow({
          organizationId,
          accountId: payer,
          entryType: LedgerEntryType.DEPOSIT_PENDING,
          money: MoneyUtil.of(1_000_000n, USDC_ASSET, USDC_DECIMALS),
          intentId: row.id,
          chainTxRef: txRef,
        });
        return row.id;
      };
      const resolve = (id: string, entryType: LedgerEntryType) =>
        ledgerService.appendNow({
          organizationId,
          accountId: payer,
          entryType,
          money: MoneyUtil.of(1_000_000n, USDC_ASSET, USDC_DECIMALS),
          intentId: id,
          chainTxRef: `final-${id}`,
        });

      const confirmed = await settled();
      const rejected = await settled();
      expect((await data(`/deposits/${confirmed}`)).finality).toBe('PENDING');
      expect((await data(`/deposits/${depositId}`)).finality).toBeNull();

      await resolve(confirmed, LedgerEntryType.DEPOSIT_CONFIRM);
      await resolve(rejected, LedgerEntryType.DEPOSIT_REJECT);

      expect((await data(`/deposits/${confirmed}`)).finality).toBe('CONFIRMED');
      expect((await data(`/deposits/${rejected}`)).finality).toBe('REJECTED');
      const listed = await data('/deposits');
      const byId = Object.fromEntries(listed.items.map((item: any) => [item.id, item.finality]));
      expect(byId).toMatchObject({
        [confirmed]: 'CONFIRMED',
        [rejected]: 'REJECTED',
        [depositId]: null,
      });
    });
  });

  describe('GET /agents/me/delegate/status', () => {
    it('is GET /agents/me/delegate without its chain read', async () => {
      const full = await data('/agents/me/delegate', {}, 'machine');
      const status = await data('/agents/me/delegate/status', {}, 'machine');
      const { paidCalls, paidCallsUnknown, ...binding } = full;
      expect(status).toEqual({ ...binding, bound: true });
      expect(status.delegate).toMatch(/^eip155:/);
      expect(paidCalls).toBeDefined();
      expect(paidCallsUnknown).toBe(false);
    });

    it('refuses a person, as the full route does', async () => {
      const full = await get('/agents/me/delegate');
      const status = await get('/agents/me/delegate/status');
      expect(status.status).toBe(full.status);
      expect(status.status).toBe(403);
      expect(JSON.stringify(status.body)).toContain('ACCOUNT_DELEGATE_BINDING_AGENT_ONLY');
    });
  });
});
