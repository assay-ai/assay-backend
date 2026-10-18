import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import {
  CallDisputeConfig,
  DEFAULT_CALL_DISPUTE_CONFIG,
} from '@modules/dispute/constants/call-dispute.config';
import { CallDisputeDecision, CallDisputeReason } from '@modules/dispute/domain/call-dispute';
import {
  CallDisputeDetailDto,
  CallDisputeSubjectType,
  OperatorCallDisputeDetailDto,
} from '@modules/dispute/dto/call-dispute.dto';
import { DisputeErrorCode } from '@modules/dispute/errors/dispute.errors';
import { CallDisputeRetentionService } from '@modules/dispute/services/call-dispute-retention.service';
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import {
  CallDisputeSlaService,
  SYSTEM_SLA_OPERATOR_ID,
} from '@modules/dispute/services/call-dispute-sla.service';
import { HeldStatus } from '@modules/payment/ports/held-payments.port';
import { HeldCollectionService } from '@modules/payment/services/held-collection.service';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  NotificationPort,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import {
  CALL_DISPUTE_DECIDE_APPROVAL_ACTION,
  OperatorCallDisputeService,
} from '@modules/operator/services/operator-call-dispute.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { ProviderEarningsGroupBy } from '@modules/provider/dto/get-provider-earnings.dto';
import { ProviderEarningsService } from '@modules/provider/services/provider-earnings.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';
import { AuditLogWriter } from '@shared/audit';
import { MoneyUtil } from '@shared/utils/money.util';

import { addBlock, blocklistOf, noBlocks } from '../../unit/helpers/blocklist';
import { BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { FakeHeldPayments } from '../helpers/fake-held-payments';
import { approvalFor } from '../helpers/operator-approval';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { USDC_ASSET } from '../helpers/test-database';

/**
 * Buyer call disputes (G3.B1) end to end against a real Postgres built from
 * every migration, a real ledger and the real override log: filing, the
 * provider's reply, the operator's decision and — the part that touches money —
 * each refund path, with the ledger balances asserted after every one.
 */
const DATABASE = 'x402_call_disputes_test';
const CHAIN = CHAIN_IDS.SOLANA_MAINNET;
const ASSET = USDC_ASSET;
const PAYEE = toAccountId(CHAIN, 'call-dispute-payee');
const PRICE = 1_000_000n;
const PROVIDER_AMOUNT = 900_000n;
const FEE = 100_000n;
const FUNDED = 10_000_000n;
const TOOL = '7d3c1e8a-2b4f-4c6d-9e0a-1f2b3c4d5e6f';
let voucherSeq = 0;

const DISABLED_ESCROW_GATE = {
  enabled: false,
  assertAffordable: async () => undefined,
} as unknown as EscrowSpendGateService;

describe('call disputes, against a real database', () => {
  let dataSource: DataSource;
  let ledger: LedgerService;
  let intents: PaymentIntentService;
  let disputes: CallDisputeService;
  let operatorDisputes: OperatorCallDisputeService;
  let notified: NotificationRequest[];
  let config: { -readonly [K in keyof CallDisputeConfig]: CallDisputeConfig[K] };
  let adjudicator: OperatorSession;
  let second: OperatorSession;
  let payments: PaymentIntentRepository;
  let retention: CallDisputeRetentionService;
  let held: FakeHeldPayments;
  let collection: HeldCollectionService;
  let sla: CallDisputeSlaService;
  const alerts: Array<{ name: string; summary: string }> = [];
  let blocklist: ReturnType<typeof blocklistOf>;

  let buyer: string;
  let provider: string;
  let payer: AccountId;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    // Seeded as rows: the tool and binding foreign keys are not what these
    // tests are about. Every user trigger the migrations define still runs.
    for (const table of ['payment_intents', 'verification_records']) {
      await dataSource.query(`ALTER TABLE ${table} DISABLE TRIGGER ALL`);
      await dataSource.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }

    const balanceRepository = new AccountBalanceRepository(dataSource);
    const journal = new LedgerJournalService(
      new LedgerEntryRepository(dataSource),
      balanceRepository,
      dataSource,
    );
    const balances = new LedgerBalanceService(balanceRepository, journal);
    const holds = new LedgerHoldService(new LedgerHoldRepository(dataSource), journal, dataSource);
    ledger = new LedgerService(journal, balances, holds);
    payments = new PaymentIntentRepository(dataSource);
    held = new FakeHeldPayments();
    const alertSink = {
      emit: async (alert: { name: string; summary: string }) => {
        alerts.push(alert);
      },
    } as never;
    intents = new PaymentIntentService(
      payments,
      ledger,
      DISABLED_ESCROW_GATE,
      noBlocks(),
      null,
      null,
      held,
      alertSink,
    );
    blocklist = blocklistOf();
    collection = new HeldCollectionService(payments, intents, blocklist, alertSink, held, null);

    notified = [];
    const notifications: NotificationPort = {
      notify: async (request) => {
        notified.push(request);
        return { deliveredNow: true };
      },
    } as NotificationPort;
    const evidence = { forBuyer: async () => null } as unknown as EvidencePackService;
    config = { ...DEFAULT_CALL_DISPUTE_CONFIG, twoPersonThresholdUnits: '5' };

    disputes = new CallDisputeService(
      dataSource,
      new DisputeRepository(dataSource),
      payments,
      new VerificationRecordRepository(dataSource),
      intents,
      evidence,
      new AuditLogWriter(dataSource),
      notifications,
      config,
      held,
    );
    const approvalRepository = new OperatorApprovalRepository(dataSource);
    const overrides = new OverrideLogService(
      dataSource,
      new OverrideLogEntryRepository(dataSource),
      approvalRepository,
    );
    const approvals = new OperatorApprovalService(
      approvalRepository,
      new OperatorRepository(dataSource),
      {} as OperatorService,
    );
    operatorDisputes = new OperatorCallDisputeService(disputes, overrides, approvals);
    retention = new CallDisputeRetentionService(dataSource, config);
    sla = new CallDisputeSlaService(dataSource, disputes, overrides, alertSink, config);

    adjudicator = await seedOperator('adj-a', [OperatorRole.ADJ]);
    second = await seedOperator('adj-b', [OperatorRole.ADJL]);
  }, 300_000);

  afterAll(async () => dataSource?.destroy());

  beforeEach(() => {
    buyer = randomUUID();
    provider = randomUUID();
    payer = toAccountId(CHAIN, `buyer-${randomUUID()}`) as AccountId;
    notified = [];
    alerts.length = 0;
    config.twoPersonThresholdUnits = '5';
    config.maxPerProviderPerDay = DEFAULT_CALL_DISPUTE_CONFIG.maxPerProviderPerDay;
    config.maxAutoUpholdsPerProviderPerDay =
      DEFAULT_CALL_DISPUTE_CONFIG.maxAutoUpholdsPerProviderPerDay;
    held.live = true;
    held.readMode = 'normal';
    held.failRefunds = false;
  });

  // ── Seeding ─────────────────────────────────────────────────────────────

  async function seedOperator(subject: string, roles: OperatorRole[]): Promise<OperatorSession> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO operators (id, subject, display_name, email, roles, status)
       VALUES ($1, $2, $2, $3, $4::jsonb, 'ACTIVE')`,
      [id, subject, `${subject}@example.test`, JSON.stringify(roles)],
    );
    return {
      operatorId: id,
      subject,
      displayName: subject,
      email: `${subject}@example.test`,
      roles,
      authorityLimitMinor: null,
    };
  }

  function session(organizationId = buyer): McpSession {
    return {
      credentialId: 'cred-test',
      organizationId,
      agentId: randomUUID(),
      agentAccount: payer,
      chainId: CHAIN,
      callerKind: McpCallerKind.AGENT,
    } as unknown as McpSession;
  }

  // ── Seeding: a served call, then its payment ────────────────────────────

  interface Call {
    readonly intentId: string;
    readonly verdictId: string;
    readonly holdId: string;
    readonly seq: number;
  }

  /**
   * A served, paid rail-B call settled a minute ago: the buyer funded, its
   * hold opened, the intent SETTLED, and a verification record. Its voucher is
   * not redeemed yet.
   */
  async function seedSettled(
    options: { settledAgoMs?: number; callClass?: string; railA?: boolean } = {},
  ): Promise<Call> {
    const intentId = randomUUID();
    const verdictId = randomUUID();
    const seq = (voucherSeq += 1);
    await ledger.appendNow({
      organizationId: buyer,
      accountId: payer,
      entryType: LedgerEntryType.DEPOSIT,
      money: MoneyUtil.of(FUNDED, ASSET, 6),
    });
    await dataSource.query(
      `INSERT INTO payment_intents (
         id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
         tool_id, binding_id, rail, call_id, call_class, asset_id, decimals, price_amount,
         provider_amount, platform_fee, request_hash, chain_id, expires_at, voucher_seq,
         voucher_signature, voucher_resource_hash, voucher_issued_at)
       VALUES ($1, $2, $21, $3, $4, $5, $6, $7, $8, $22, $9, $10, $11, 6,
               $12, $13, $14, $15, $16, now() + interval '4 minutes', $20, $17, $18, $19)`,
      [
        intentId,
        buyer,
        randomUUID(),
        payer,
        provider,
        PAYEE,
        TOOL,
        randomUUID(),
        randomUUID(),
        options.callClass ?? 'PAID',
        ASSET,
        PRICE.toString(),
        PROVIDER_AMOUNT.toString(),
        FEE.toString(),
        `sha256:${'ab'.repeat(32)}`,
        CHAIN,
        options.railA ? null : `0x${'12'.repeat(65)}`,
        options.railA ? null : `sha256:${'cd'.repeat(32)}`,
        options.railA ? null : String(Math.floor(Date.now() / 1000)),
        options.railA ? null : String(seq),
        options.railA ? 'VERIFYING' : 'SETTLED',
        options.railA ? 'RAIL_A_PER_CALL' : 'RAIL_B_VOUCHER',
      ],
    );
    const hold = await ledger.createHold({
      organizationId: buyer,
      accountId: payer,
      money: MoneyUtil.of(PRICE, ASSET, 6),
      intentId,
    });
    await dataSource.query(`UPDATE payment_intents SET hold_id = $2 WHERE id = $1`, [
      intentId,
      hold.id,
    ]);
    const settledAt = new Date(Date.now() - (options.settledAgoMs ?? 60_000));
    await dataSource.query(
      `INSERT INTO verification_records
         (id, organization_id, intent_id, tool_id, provider_id, state, request, response,
          verdict_status, decision_policy_id, decision_policy_version,
          evaluated_at, stages, settled_at, settlement_outcome)
       VALUES ($1, $2, $3, $6, $4, 'SETTLED', '{"city":"Paris"}'::jsonb,
               '{"temperature":null}'::jsonb, 'UNVERIFIED', 'none', 0, $5, '[]'::jsonb, $5,
               'SETTLE')`,
      [verdictId, buyer, intentId, provider, settledAt, TOOL],
    );
    return { intentId, verdictId, holdId: hold.id, seq };
  }

  const keyOf = (call: Call) => ({ payer, seq: String(call.seq) });

  /**
   * `redeemVoucher` lands: the escrow holds the payment (`PaymentHeld`) until
   * `collectableAt`, and the redemption job books it.
   */
  async function redeem(call: Call, collectableInMs = 3_600_000): Promise<void> {
    held.redeemInto(ASSET, keyOf(call), PRICE, new Date(Date.now() + collectableInMs));
    await intents.commitRedeemedHold(buyer, call.intentId, `0x${'77'.repeat(32)}`);
  }

  async function seedHeld(collectableInMs = 3_600_000, options = {}): Promise<Call> {
    const call = await seedSettled(options);
    await redeem(call, collectableInMs);
    return call;
  }

  /** Time passes: the call's window ends (on chain and in the mirror). */
  async function endWindow(call: Call, agoMs = 1_000): Promise<void> {
    const at = new Date(Date.now() - agoMs);
    held.setCollectableAt(keyOf(call), at);
    await dataSource.query(`UPDATE payment_intents SET collectable_at = $2 WHERE id = $1`, [
      call.intentId,
      at,
    ]);
  }

  /** Runs `body` with the test's provider blocked on the platform, then lifts the block. */
  async function withProviderBlocked(body: () => Promise<void>): Promise<void> {
    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
    try {
      await body();
    } finally {
      await blocklist.applied({
        kind: 'unblocked',
        subjectKind: BlockSubjectKind.ORGANIZATION,
        subjectKey: subjectKey(BlockSubjectKind.ORGANIZATION, provider) as string,
      } as never);
    }
  }

  /** Time passes: the row's held back-off ends. */
  async function elapseBackOff(call: Call): Promise<void> {
    await dataSource.query(`UPDATE payment_intents SET held_retry_at = NULL WHERE id = $1`, [
      call.intentId,
    ]);
  }

  /** A call whose payment was collected (held, window over, the job ran). */
  async function seedCollected(options = {}): Promise<Call> {
    const call = await seedHeld(3_600_000, options);
    await endWindow(call);
    await collection.run();
    return call;
  }

  async function seedDebt(writtenOff = false): Promise<Call> {
    const call = await seedSettled();
    await dataSource.query(
      `UPDATE payment_intents
          SET redemption_lapsed_at = now() - $2::interval, redemption_last_error = 'DelegateIsRevoked'
        WHERE id = $1`,
      [call.intentId, writtenOff ? '40 days' : '2 days'],
    );
    if (writtenOff) {
      await expect(
        intents.writeOffDebt(
          { organizationId: buyer, id: call.intentId, payer, holdId: call.holdId },
          'uncollected:DelegateIsRevoked',
          new Date(),
        ),
      ).resolves.toBe(true);
    }
    return call;
  }

  async function file(
    call: Call,
    reason = CallDisputeReason.WRONG_DATA,
  ): Promise<CallDisputeDetailDto> {
    return disputes.file(session(), {
      subjectType: CallDisputeSubjectType.PAYMENT_INTENT,
      subjectId: call.intentId,
      reason,
      note: 'The temperature came back null for a city that exists.',
    });
  }

  function decide(
    id: string,
    decision: CallDisputeDecision,
    operator: OperatorSession = adjudicator,
  ): Promise<OperatorCallDisputeDetailDto | ApprovalQueuedDto> {
    return operatorDisputes.decide({
      operator,
      disputeId: id,
      decision,
      note: 'Checked the captured output against the contract.',
    });
  }

  /** The scheduler's refund job runs; the dispute as it then stands. */
  async function upholdAndRefundDone(id: string): Promise<OperatorCallDisputeDetailDto> {
    await sla.refundPending();
    return operatorDisputes.detail(id);
  }

  /** Upheld by an operator (API: refund PENDING), then the scheduler's refund job runs. */
  async function upholdAndRefund(id: string): Promise<OperatorCallDisputeDetailDto> {
    await decide(id, CallDisputeDecision.UPHOLD);
    await sla.refundPending();
    return operatorDisputes.detail(id);
  }

  async function balance(account: string, organizationId = buyer) {
    const value = await ledger.getBalance(organizationId, account as AccountId, ASSET);
    return {
      available: MoneyUtil.toAtomic(value.available),
      held: MoneyUtil.toAtomic(value.held),
    };
  }

  async function journalTypes(intentId: string): Promise<string[]> {
    const rows = (await dataSource.query(
      `SELECT entry_type FROM ledger_entries WHERE intent_id = $1 ORDER BY entry_type`,
      [intentId],
    )) as { entry_type: string }[];
    return rows.map((row) => row.entry_type);
  }

  const COLLECTED = ['HOLD_COMMIT', 'HOLD_CREATE', 'PLATFORM_FEE', 'PROVIDER_CREDIT'];
  const REFUNDED = ['HOLD_CREATE', 'HOLD_RELEASE'];

  async function intentRow(intentId: string) {
    const [row] = (await dataSource.query(
      `SELECT redemption_last_error, hold_released_at, dispute_outcome, collectable_at,
              held_status, held_tx_ref
         FROM payment_intents WHERE id = $1`,
      [intentId],
    )) as {
      redemption_last_error: string | null;
      hold_released_at: Date | null;
      dispute_outcome: string | null;
      collectable_at: Date | null;
      held_status: string | null;
      held_tx_ref: string | null;
    }[];
    return row;
  }

  /** The chain transactions this test's payer was in. */
  const sentFor = (op: 'collect' | 'refund') =>
    held.sent.filter((s) => s.op === op && s.keys.some((key) => key.payer === payer));

  async function chainStatus(call: Call): Promise<HeldStatus | undefined> {
    return (await held.readHeld(ASSET, keyOf(call)))?.status;
  }

  async function assertBooksBalance(): Promise<void> {
    expect((await ledger.verifySnapshots(buyer)).ok).toBe(true);
    expect((await ledger.verifySnapshots(provider)).ok).toBe(true);
  }

  /** The buyer charged and the provider credited — once — for `calls` calls. */
  async function assertCollected(call: Call, calls = 1n): Promise<void> {
    expect(await journalTypes(call.intentId)).toEqual(COLLECTED);
    expect((await intentRow(call.intentId)).held_status).toBe('COLLECTED');
    expect(await balance(PAYEE, provider)).toEqual({
      available: PROVIDER_AMOUNT * calls,
      held: 0n,
    });
    await assertBooksBalance();
  }

  /** The buyer whole, nobody credited, the escrow's record refunded. */
  async function assertRefunded(call: Call): Promise<void> {
    expect(await journalTypes(call.intentId)).toEqual(REFUNDED);
    expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
    expect(await balance(PAYEE, provider)).toEqual({ available: 0n, held: 0n });
    await assertBooksBalance();
  }

  const earnings = () =>
    new ProviderEarningsService(payments).getEarnings(provider, {
      from: new Date(Date.now() - 3_600_000).toISOString(),
      to: new Date(Date.now() + 3_600_000).toISOString(),
      groupBy: ProviderEarningsGroupBy.TOOL,
    } as never);

  // ── Redeem into hold ────────────────────────────────────────────────────

  describe('redeem into hold', () => {
    it('holds the redeemed payment: out of the buyer’s spendable balance, not yet the provider’s', async () => {
      const call = await seedHeld();

      const row = await intentRow(call.intentId);
      expect(row.held_status).toBe('HELD');
      expect(row.collectable_at).not.toBeNull();
      // The buyer's ledger hold stays open; the escrow balance no longer has it,
      // so the spend gate must not subtract it a second time.
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: PRICE });
      expect(await new LedgerHoldRepository(dataSource).sumOpenByAccount(payer, ASSET)).toBe(0n);
      expect(await balance(PAYEE, provider)).toEqual({ available: 0n, held: 0n });
      // Not redeemed again.
      const queue = await payments.findAwaitingRedemption(ASSET, 'SETTLED', 'RAIL_B_VOUCHER', 500);
      expect(queue.map((r) => r.id)).not.toContain(call.intentId);
      // Reconciler inputs: the mirror of `totalHeld()`, per payer and in all.
      expect((await payments.sumHeldOnChainByAccounts(ASSET, [payer])).get(payer)).toBe(PRICE);
      expect(await payments.sumHeldOnChain(ASSET)).toBe((await held.totalHeld(ASSET)) as bigint);
      // Earnings: pending in the window, not earned.
      expect((await earnings()).totals).toMatchObject({
        pendingInWindow: { amount: PROVIDER_AMOUNT.toString() },
        pendingInWindowCalls: 1,
        earned: { amount: '0' },
      });
    });

    it('no dispute: collected after the window, the provider credited on HeldCollected', async () => {
      const call = await seedHeld();
      expect(await collection.run()).toBe(0);
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);

      await endWindow(call);
      expect(await collection.run()).toBe(1);

      expect(await chainStatus(call)).toBe(HeldStatus.COLLECTED);
      expect((await intentRow(call.intentId)).held_tx_ref).toMatch(/^0x/);
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: 0n });
      await assertCollected(call);
      expect((await earnings()).totals).toMatchObject({
        pendingInWindowCalls: 0,
        earned: { amount: PROVIDER_AMOUNT.toString() },
      });
      expect((await payments.sumHeldOnChainByAccounts(ASSET, [payer])).get(payer)).toBeUndefined();
      expect(await payments.sumHeldOnChain(ASSET)).toBe((await held.totalHeld(ASSET)) as bigint);
      // Collected once: a second pass books nothing.
      expect(await collection.run()).toBe(0);
      await assertCollected(call);
    });

    it('a held seq n does not delay seq n+1, and a failed batch is collected singly', async () => {
      const first = await seedHeld();
      const second = await seedHeld();
      await file(first);
      await endWindow(first);
      await endWindow(second);
      held.failNextCollect = true;

      expect(await collection.run()).toBe(1);

      expect(await chainStatus(first)).toBe(HeldStatus.HELD);
      expect(await chainStatus(second)).toBe(HeldStatus.COLLECTED);
      await assertCollected(second);
    });
  });

  // ── Disputes and the money ──────────────────────────────────────────────

  describe('deciding a held payment', () => {
    it('upheld inside the window: refundHeld, a full refund, nothing collected', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      expect(dispute).toMatchObject({ refundGuaranteed: true });
      expect(dispute.refundNotice).toMatch(/refunded in full/);
      // The window ends while the dispute is open: still held.
      await endWindow(call);
      expect(await collection.run()).toBe(0);

      // The API decides; it holds no redeemer key, so the refund is PENDING
      // until the scheduler's refund job sends `refundHeld` (review P1-2).
      const pending = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;
      expect(pending.refundState).toBe('PENDING');
      expect(sentFor('refund')).toEqual([]);
      expect(await collection.run()).toBe(0);

      const decided = await upholdAndRefundDone(dispute.id);
      expect(decided).toMatchObject({
        state: 'UPHELD',
        refundSource: 'UNCOLLECTED_EARNINGS',
        refundState: 'REFUNDED',
        restoredAmount: { amount: PRICE.toString() },
      });
      expect(await chainStatus(call)).toBe(HeldStatus.REFUNDED);
      expect(await intentRow(call.intentId)).toMatchObject({
        held_status: 'REFUNDED',
        redemption_last_error: 'voided:DISPUTE_UPHELD',
        dispute_outcome: 'UPHELD',
      });
      await assertRefunded(call);
      // A refund does not give the caps back (I5).
      const spent = await payments.sumSpendByAgent(
        buyer,
        (await payments.findOneBy({ organizationId: buyer, id: call.intentId }))!.agentId,
        ASSET,
        new Date(Date.now() - 3_600_000),
        new Date(Date.now() - 86_400_000),
        new Date(Date.now() - 30 * 86_400_000),
      );
      expect(spent.thisHour).toBe(PRICE);
      expect((await payments.sumHeldOnChainByAccounts(ASSET, [payer])).get(payer)).toBeUndefined();
      expect(await payments.sumHeldOnChain(ASSET)).toBe((await held.totalHeld(ASSET)) as bigint);
    });

    it('rejected past the window: collected at once', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      await endWindow(call);

      await decide(dispute.id, CallDisputeDecision.REJECT);

      expect((await intentRow(call.intentId)).dispute_outcome).toBe('REJECTED');
      // Back in the collection queue: collected on the job's next pass.
      expect(await collection.run()).toBe(1);
      await assertCollected(call);
    });

    it('rejected inside the window: collected when the window ends', async () => {
      const call = await seedHeld();
      const dispute = await file(call);

      await decide(dispute.id, CallDisputeDecision.REJECT);
      expect(await collection.run()).toBe(0);
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);

      await endWindow(call);
      expect(await collection.run()).toBe(1);
      await assertCollected(call);
    });

    it('withdrawn: the hold is lifted and collection proceeds', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      await endWindow(call);

      await disputes.withdraw(session(), dispute.id);

      expect((await intentRow(call.intentId)).dispute_outcome).toBeNull();
      expect(await collection.run()).toBe(1);
      await assertCollected(call);
    });

    it('guarantees a filing up to collectableAt − 60 s: at −61 s yes, at −59 s and −1 s no', async () => {
      for (const [seconds, guaranteed] of [
        [61, true],
        [59, false],
        [1, false],
      ] as const) {
        const call = await seedHeld(seconds * 1000);
        const dispute = await file(call);
        expect({ seconds, guaranteed: dispute.refundGuaranteed }).toEqual({ seconds, guaranteed });
        expect((await intentRow(call.intentId)).dispute_outcome).toBe(guaranteed ? 'OPEN' : null);
      }
    });

    it('a filing before the redemption is held the same way, and refunded when upheld', async () => {
      const call = await seedSettled();
      const dispute = await file(call);
      expect(dispute.refundGuaranteed).toBe(true);
      // Not redeemed yet: the decision waits for the voucher to reach the hold.
      await expect(decide(dispute.id, CallDisputeDecision.UPHOLD)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_COLLECTION_IN_PROGRESS,
      });

      await redeem(call);
      expect((await intentRow(call.intentId)).dispute_outcome).toBe('OPEN');
      await upholdAndRefund(dispute.id);
      await assertRefunded(call);
    });

    it('filed after the window: a quality signal; the collected call is not refunded', async () => {
      const call = await seedHeld();
      await endWindow(call);
      const dispute = await file(call);
      expect(dispute.refundGuaranteed).toBe(false);
      expect(dispute.refundNotice).toMatch(/after the dispute window/);
      // Held but about to be collected: the decision waits for it.
      await expect(decide(dispute.id, CallDisputeDecision.UPHOLD)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_COLLECTION_IN_PROGRESS,
      });

      await collection.run();
      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided).toMatchObject({
        state: 'UPHELD',
        refundSource: 'NONE',
        refundState: 'NOT_REFUNDABLE',
        refundAmount: null,
        restoredAmount: null,
      });
      await assertCollected(call);
    });

    it('filed after the window on uncollected money (buyer debt): still refunded', async () => {
      const call = await seedDebt();
      const dispute = await file(call);
      expect(dispute.refundGuaranteed).toBe(false);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided).toMatchObject({ refundState: 'REFUNDED', secondedBy: null });
      expect(decided.history).toEqual([
        expect.objectContaining({ code: 'S-14', action: 'call_dispute.decided' }),
      ]);
      expect((await intentRow(call.intentId)).redemption_last_error).toBe('voided:DISPUTE_UPHELD');
      await assertRefunded(call);
    });

    it('voids a written-off debt: the buyer no longer owes it, and no money moves again', async () => {
      const call = await seedDebt(true);
      const dispute = await file(call);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided.refundState).toBe('REFUNDED');
      await assertRefunded(call);
    });

    it('collect/refund race: a payment the chain already collected is booked once, not refunded', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      // Someone collects it on chain first (the timeout, or a racing pass).
      held.collectAsAnyone(keyOf(call));

      const decided = await upholdAndRefund(dispute.id);

      expect(decided).toMatchObject({ state: 'UPHELD', refundState: 'NOT_REFUNDABLE' });
      await assertCollected(call);
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: 0n });
    });

    it('a refund that keeps failing until the timeout: never collected by the platform, paged, booked once someone collects', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      await decide(dispute.id, CallDisputeDecision.UPHOLD);
      held.failRefunds = true;

      expect(await sla.refundPending()).toBe(0);
      const backedOff = await payments.findOneBy({ organizationId: buyer, id: call.intentId });
      expect(backedOff?.heldAttempts).toBe(1);
      expect(backedOff?.heldRetryAt?.getTime()).toBeGreaterThan(Date.now());
      expect((await disputes.requireAny(dispute.id)).refundState).toBe('PENDING');

      // Past the chain's timeout: refundHeld is closed; the platform does not
      // collect a payment an upheld dispute still claims — it pages.
      await endWindow(call, 8 * 86_400_000);
      await dataSource.query(`UPDATE payment_intents SET held_retry_at = NULL WHERE id = $1`, [
        call.intentId,
      ]);
      await collection.run();
      expect(sentFor('collect')).toEqual([]);
      expect(alerts.map((a) => a.name)).toContain('held_payment_past_timeout');
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);

      // Synced only, so backed off: it does not head the queue every minute.
      expect(
        (await payments.findOneBy({ organizationId: buyer, id: call.intentId }))?.heldRetryAt,
      ).not.toBeNull();

      // Anyone collects it for the provider: booked once (after the back-off), and NOT_REFUNDABLE.
      held.collectAsAnyone(keyOf(call));
      await elapseBackOff(call);
      await collection.run();
      await sla.sweep();
      await assertCollected(call);
      expect((await disputes.requireAny(dispute.id)).refundState).toBe('NOT_REFUNDABLE');
    });

    it('the API process sends no refund: it holds no redeemer key', async () => {
      const call = await seedHeld();
      const dispute = await file(call);

      await decide(dispute.id, CallDisputeDecision.UPHOLD);
      await disputes.settleRefund(dispute.id);

      expect(sentFor('refund')).toEqual([]);
      expect((await disputes.requireAny(dispute.id)).refundState).toBe('PENDING');
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);
    });

    it('finishes a refund whose money step never ran (a crash after the decision)', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await disputes.decideWithin(runner, {
        disputeId: dispute.id,
        decision: CallDisputeDecision.UPHOLD,
        note: 'Checked the captured output against the contract.',
        operatorId: adjudicator.operatorId,
      });
      await runner.commitTransaction();
      await runner.release();
      expect((await disputes.requireAny(dispute.id)).refundState).toBe('PENDING');
      // Upheld, not yet refunded: the job still leaves it alone.
      await endWindow(call);
      expect(await collection.run()).toBe(0);

      const finished = await upholdAndRefund(dispute.id);

      expect(finished.refundState).toBe('REFUNDED');
      await assertRefunded(call);
      // And again: nothing moves twice.
      await disputes.settleRefund(dispute.id, { chain: true });
      await sla.refundPending();
      await expect(
        intents.refundHeldForDispute(buyer, call.intentId, 'DISPUTE_UPHELD'),
      ).resolves.toBe('REFUNDED');
      expect(sentFor('refund')).toHaveLength(1);
      await assertRefunded(call);
    });

    it('needs a second operator at or above the threshold, and refuses self-approval', async () => {
      config.twoPersonThresholdUnits = '1';
      const call = await seedHeld();
      const dispute = await file(call);

      const queuedApproval = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as ApprovalQueuedDto;
      expect(queuedApproval).toMatchObject({ status: 'PENDING' });
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);

      const self = await approvalFor(
        dataSource,
        adjudicator,
        adjudicator,
        CALL_DISPUTE_DECIDE_APPROVAL_ACTION,
      );
      await expect(
        operatorDisputes.decide(
          {
            operator: adjudicator,
            disputeId: dispute.id,
            decision: CallDisputeDecision.UPHOLD,
            note: 'Checked the captured output against the contract.',
          },
          self,
        ),
      ).rejects.toBeDefined();

      const approver = await approvalFor(
        dataSource,
        adjudicator,
        second,
        CALL_DISPUTE_DECIDE_APPROVAL_ACTION,
      );
      const decided = (await operatorDisputes.decide(
        {
          operator: adjudicator,
          disputeId: dispute.id,
          decision: CallDisputeDecision.UPHOLD,
          note: 'Checked the captured output against the contract.',
        },
        approver,
      )) as OperatorCallDisputeDetailDto;
      expect(decided.refundState).toBe('PENDING');
      await sla.refundPending();

      expect(await operatorDisputes.detail(dispute.id)).toMatchObject({
        state: 'UPHELD',
        refundState: 'REFUNDED',
        resolvedBy: adjudicator.operatorId,
        secondedBy: second.operatorId,
      });
      await assertRefunded(call);
    });
  });

  // ── The decision SLA ────────────────────────────────────────────────────

  describe('the decision SLA', () => {
    async function age(disputeId: string, hours: number): Promise<void> {
      await dataSource.query(
        `UPDATE disputes SET created_at = now() - make_interval(hours => $2), sla_due_at = now()
          WHERE id = $1`,
        [disputeId, hours],
      );
    }

    it('auto-upholds at 72 h when the provider stayed silent, and refunds', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      await age(dispute.id, 25);
      await sla.sweep();
      expect((await disputes.requireAny(dispute.id)).providerSilentAt).not.toBeNull();
      // Silent past 24 h: too late to reply.
      await expect(
        disputes.respond(session(provider), dispute.id, 'Late reply'),
      ).rejects.toMatchObject({ errorCode: DisputeErrorCode.DISPUTE_ALREADY_RESPONDED });

      await age(dispute.id, 49);
      await sla.sweep();
      expect(alerts.map((a) => a.summary)).toEqual([expect.stringMatching(/48 hours/)]);

      await age(dispute.id, 73);
      expect(await sla.sweep()).toMatchObject({ autoUpheld: 1 });

      const after = await disputes.requireAny(dispute.id);
      expect(after).toMatchObject({
        state: 'UPHELD',
        resolutionKind: 'AUTO_PLATFORM_MISS',
        refundState: 'REFUNDED',
      });
      await assertRefunded(call);
      // Logged in the override register as S-14, under the system actor.
      expect((await operatorDisputes.detail(dispute.id)).history).toEqual([
        expect.objectContaining({
          code: 'S-14',
          actorOperatorId: SYSTEM_SLA_OPERATOR_ID,
        }),
      ]);
    });

    it('pages instead of auto-upholding above the two-person threshold or without a guaranteed refund', async () => {
      config.twoPersonThresholdUnits = '1';
      const big = await seedHeld();
      const bigDispute = await file(big);
      const late = await seedHeld();
      await endWindow(late);
      const lateDispute = await file(late);
      expect(lateDispute.refundGuaranteed).toBe(false);
      await age(bigDispute.id, 73);
      await age(lateDispute.id, 73);

      expect(await sla.sweep()).toMatchObject({ autoUpheld: 0 });

      expect((await disputes.requireAny(bigDispute.id)).state).toBe('OPEN');
      expect((await disputes.requireAny(lateDispute.id)).state).toBe('OPEN');
      expect(alerts.map((a) => a.summary)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/two-person threshold/),
          expect.stringMatching(/not guaranteed/),
        ]),
      );
    });

    it('does not starve: 500 disputes with nothing due do not hide one that is', async () => {
      await dataSource.query(
        `INSERT INTO disputes (organization_id, subject_type, subject_id, state, claim_type, reason,
                               opened_by, intent_id, respondent_provider_id, evidence_snapshot,
                               provider_response, provider_responded_at, provider_silent_at,
                               paged_48h_at, paged_72h_at, paged_6d_at, created_at)
         SELECT gen_random_uuid(), 'PAYMENT_INTENT', gen_random_uuid()::text, 'OPEN', 'OTHER', '',
                'agent', gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, 'replied', now(),
                now(), now(), now(), now(), now() - interval '30 days' - n * interval '1 second'
           FROM generate_series(1, 500) AS n`,
      );
      const call = await seedHeld();
      const dispute = await file(call);
      await age(dispute.id, 49);

      await sla.sweep();

      expect(alerts.map((a) => a.summary)).toContain(
        `Call dispute ${dispute.id}: 48 hours undecided`,
      );
      await dataSource.query(
        `UPDATE disputes SET state = 'WITHDRAWN' WHERE provider_response = 'replied'`,
      );
    });

    it('caps auto-upholds per provider per day, and pages past the cap', async () => {
      config.maxAutoUpholdsPerProviderPerDay = 1;
      const first = await file(await seedHeld());
      const secondCall = await seedHeld();
      const second = await file(secondCall);
      await age(first.id, 73);
      await age(second.id, 73);

      expect(await sla.sweep()).toMatchObject({ autoUpheld: 1 });

      expect((await disputes.requireAny(second.id)).state).toBe('OPEN');
      expect(alerts.map((a) => a.summary)).toEqual(
        expect.arrayContaining([expect.stringMatching(/daily auto-uphold cap/)]),
      );
      expect(await chainStatus(secondCall)).toBe(HeldStatus.HELD);
    });

    it('every row leaves the due set: a deferring auto-uphold is retried later, then paged', async () => {
      const call = await seedSettled(); // filed before redemption: the uphold defers
      const dispute = await file(call);
      await age(dispute.id, 73);

      await sla.sweep();
      const deferred = await disputes.requireAny(dispute.id);
      expect(deferred.state).toBe('OPEN');
      // Retried in about 15 minutes, not on every pass; the 48 h page was not skipped.
      expect(deferred.slaDueAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
      expect(deferred.paged48hAt).not.toBeNull();

      await age(dispute.id, 6 * 24 + 1);
      await sla.sweep();
      const stopped = await disputes.requireAny(dispute.id);
      expect(stopped.paged72hAt).not.toBeNull();
      expect(stopped.paged6dAt).not.toBeNull();
      expect(stopped.slaDueAt).toBeNull();
      expect(alerts.map((a) => a.summary)).toEqual(
        expect.arrayContaining([expect.stringMatching(/kept deferring/)]),
      );
    });

    it('pages an upheld refund still pending at collectable_at + 5 d and + 6 d', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      await decide(dispute.id, CallDisputeDecision.UPHOLD);
      held.failRefunds = true;
      await sla.refundPending();

      await endWindow(call, 5 * 86_400_000 + 60_000);
      await sla.sweep();
      expect(alerts.map((a) => a.summary)).toEqual([
        expect.stringMatching(/refund still pending 5 days after the window/),
      ]);

      await endWindow(call, 6 * 86_400_000 + 60_000);
      await sla.sweep();
      await sla.sweep();
      expect(alerts.map((a) => a.summary)).toEqual([
        expect.stringMatching(/5 days after the window/),
        expect.stringMatching(/6 days after the window/),
      ]);
    });

    it('keeps holding when the provider replied, and pages at 72 h and 6 d', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      await disputes.respond(session(provider), dispute.id, 'Upstream had no data.');

      await age(dispute.id, 73);
      expect(await sla.sweep()).toMatchObject({ autoUpheld: 0 });
      await age(dispute.id, 6 * 24 + 1);
      await sla.sweep();

      expect((await disputes.requireAny(dispute.id)).state).toBe('OPEN');
      expect(alerts.map((a) => a.summary)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/72 hours undecided; held — the provider replied/),
          expect.stringMatching(/six days/),
        ]),
      );
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);
    });

    it('past the chain’s 7-day timeout: collected to the provider, marked NOT_REFUNDABLE', async () => {
      const call = await seedHeld();
      const dispute = await file(call);
      await disputes.respond(session(provider), dispute.id, 'Upstream had no data.');
      await endWindow(call, 7 * 86_400_000 + 60_000);
      // The platform never collects a disputed payment; anyone may, after the timeout.
      await collection.run();
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);
      held.collectAsAnyone(keyOf(call));
      await elapseBackOff(call);

      await collection.run();
      await sla.sweep();

      await assertCollected(call);
      expect(await disputes.requireAny(dispute.id)).toMatchObject({
        state: 'OPEN',
        refundSource: 'NONE',
        refundState: 'NOT_REFUNDABLE',
      });
    });
  });

  // ── Review fixes: deciding from the receipt, liveness, stuck rows ──────

  describe('deciding a redemption from its receipt (P0-1, P1-1)', () => {
    it('a lagging node (held() reads null or throws) never credits the provider on a live hold', async () => {
      for (const mode of ['null', 'throw'] as const) {
        const call = await seedSettled();
        held.redeemInto(ASSET, keyOf(call), PRICE, new Date(Date.now() + 3_600_000));
        held.receiptSays(keyOf(call), { kind: 'UNKNOWN' });
        held.readMode = mode;

        await expect(
          intents.commitRedeemedHold(buyer, call.intentId, `0x${'77'.repeat(32)}`),
        ).rejects.toBeDefined();
        held.readMode = 'normal';

        expect(await journalTypes(call.intentId)).toEqual(['HOLD_CREATE']);
        expect((await intentRow(call.intentId)).held_status).toBeNull();
        expect(await balance(PAYEE, provider)).toEqual({ available: 0n, held: 0n });
      }
    });

    it('a redemption nothing can classify is counted and paged, never credited', async () => {
      const call = await seedSettled();
      held.receiptSays(keyOf(call), { kind: 'UNKNOWN' });
      for (let i = 0; i < 5; i += 1) {
        await expect(
          intents.commitRedeemedHold(buyer, call.intentId, `unobserved:seq=${call.seq}`),
        ).rejects.toBeDefined();
      }
      expect(
        (await payments.findOneBy({ organizationId: buyer, id: call.intentId }))?.heldAttempts,
      ).toBe(5);
      expect(await journalTypes(call.intentId)).toEqual(['HOLD_CREATE']);
    });

    it('a receipt that cannot be read is retried, never guessed', async () => {
      const call = await seedSettled();
      held.receiptSays(keyOf(call), 'THROW');
      await expect(
        intents.commitRedeemedHold(buyer, call.intentId, `0x${'77'.repeat(32)}`),
      ).rejects.toBeDefined();
      expect(await journalTypes(call.intentId)).toEqual(['HOLD_CREATE']);
    });

    it('a voucher redeemed just before the upgrade (bare VoucherRedeemed) is credited, and does not block the next', async () => {
      const before = await seedSettled();
      held.receiptSays(keyOf(before), { kind: 'PAID' });
      const next = await seedSettled();

      await intents.commitRedeemedHold(buyer, before.intentId, `0x${'77'.repeat(32)}`);

      // Paid at redemption, the old way: committed and credited, no hold.
      expect(await journalTypes(before.intentId)).toEqual(COLLECTED);
      expect((await intentRow(before.intentId)).held_status).toBeNull();
      expect(await balance(PAYEE, provider)).toEqual({ available: PROVIDER_AMOUNT, held: 0n });
      await assertBooksBalance();
      const queue = await payments.findAwaitingRedemption(ASSET, 'SETTLED', 'RAIL_B_VOUCHER', 500);
      expect(queue.map((row) => row.id)).toContain(next.intentId);
      expect(queue.map((row) => row.id)).not.toContain(before.intentId);
    });
  });

  describe('stuck rows, blocked parties and liveness (P1-3, P2-1, P2-2, P2-3)', () => {
    it('a stuck row backs off and does not stop the rest; a blocked party is never sent', async () => {
      const stuck = await seedHeld();
      const fine = await seedHeld();
      await endWindow(stuck);
      await endWindow(fine);
      held.stick(keyOf(stuck));
      held.failNextCollect = true;

      expect(await collection.run()).toBe(1);
      await assertCollected(fine);
      const row = await payments.findOneBy({ organizationId: buyer, id: stuck.intentId });
      expect(row?.heldAttempts).toBe(1);
      expect(row?.heldLastError).toMatch(/refused/);
      // Backing off: not retried on the next pass.
      const sent = held.sent.length;
      await collection.run();
      expect(held.sent.length).toBe(sent);

      const blockedBuyer = await seedHeld();
      await endWindow(blockedBuyer);
      addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: buyer });
      try {
        await collection.run();
        expect(await chainStatus(blockedBuyer)).toBe(HeldStatus.HELD);
      } finally {
        await blocklist.applied({
          kind: 'unblocked',
          subjectKind: BlockSubjectKind.ORGANIZATION,
          subjectKey: subjectKey(BlockSubjectKind.ORGANIZATION, buyer) as string,
        } as never);
      }
    });

    it('a blocked provider: every held payment refunded at once, the dispute too, none collected', async () => {
      const inWindow = await seedHeld();
      const pastWindow = await seedHeld();
      const disputed = await seedHeld();
      await endWindow(pastWindow);
      await file(disputed);
      addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
      try {
        await collection.run();

        expect(sentFor('collect')).toEqual([]);
        expect(sentFor('refund')).toHaveLength(1);
        expect(sentFor('refund')[0].keys).toHaveLength(3);
        for (const call of [inWindow, pastWindow, disputed]) {
          expect(await chainStatus(call)).toBe(HeldStatus.REFUNDED);
          expect(await journalTypes(call.intentId)).toEqual(REFUNDED);
          expect(await intentRow(call.intentId)).toMatchObject({
            held_status: 'REFUNDED',
            redemption_last_error: 'provider_forfeit:ProviderBlocked',
            held_tx_ref: expect.stringMatching(/^0x/),
          });
        }
        expect(await balance(payer)).toEqual({ available: 3n * FUNDED, held: 0n });
        expect(await balance(PAYEE, provider)).toEqual({ available: 0n, held: 0n });
        await assertBooksBalance();

        // Idempotent: nothing is sent or booked again.
        await collection.run();
        expect(sentFor('refund')).toHaveLength(1);
        expect(await journalTypes(inWindow.intentId)).toEqual(REFUNDED);
      } finally {
        await blocklist.applied({
          kind: 'unblocked',
          subjectKind: BlockSubjectKind.ORGANIZATION,
          subjectKey: subjectKey(BlockSubjectKind.ORGANIZATION, provider) as string,
        } as never);
      }
    });

    it('a blocked provider: an unrefunded payment near the timeout is paged; past it, never collected', async () => {
      const call = await seedHeld();
      await endWindow(call, 7 * 86_400_000 - 3_600_000);
      held.failRefunds = true;
      addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: provider });
      try {
        await collection.run();
        expect(alerts.map((a) => a.name)).toContain('held_payment_blocked_provider_unrefunded');
        expect(
          (await payments.findOneBy({ organizationId: buyer, id: call.intentId }))?.heldAttempts,
        ).toBe(1);

        // Past the timeout: the refund is closed, and the platform never collects it.
        await endWindow(call, 7 * 86_400_000 + 60_000);
        await dataSource.query(`UPDATE payment_intents SET held_retry_at = NULL WHERE id = $1`, [
          call.intentId,
        ]);
        alerts.length = 0;
        await collection.run();
        expect(sentFor('collect')).toEqual([]);
        expect(await chainStatus(call)).toBe(HeldStatus.HELD);
        expect(alerts.map((a) => a.name)).toContain('held_payment_blocked_provider_unrefunded');

        // Anyone collects it for the provider: booked once.
        held.collectAsAnyone(keyOf(call));
        await collection.run();
        await assertCollected(call);
      } finally {
        await blocklist.applied({
          kind: 'unblocked',
          subjectKind: BlockSubjectKind.ORGANIZATION,
          subjectKey: subjectKey(BlockSubjectKind.ORGANIZATION, provider) as string,
        } as never);
      }
    });

    it('past the timeout: collected one by one, and a record a stranger collected is booked', async () => {
      const calls = [await seedHeld(), await seedHeld(), await seedHeld()];
      for (const call of calls) await endWindow(call, 7 * 86_400_000 + 60_000);
      held.collectAsAnyone(keyOf(calls[0]));
      const collect = held.collect.bind(held);
      const spy = jest.spyOn(held, 'collect').mockImplementation(async (asset, keys) => {
        // A stranger collects the second one just before our transaction.
        if (keys.some((key) => key.seq === String(calls[1].seq))) {
          held.collectAsAnyone(keys[0]);
        }
        return collect(asset, keys);
      });
      try {
        await collection.run();
      } finally {
        spy.mockRestore();
      }

      expect(sentFor('collect').map((s) => s.keys.length)).toEqual([1]);
      for (const call of calls) {
        expect(await chainStatus(call)).toBe(HeldStatus.COLLECTED);
        expect(await journalTypes(call.intentId)).toEqual(COLLECTED);
      }
      expect(await balance(PAYEE, provider)).toEqual({ available: 3n * PROVIDER_AMOUNT, held: 0n });
      const failed = await payments.findOneBy({ organizationId: buyer, id: calls[1].intentId });
      expect(failed?.heldAttempts).toBe(0);
      await assertBooksBalance();
    });

    it('finds a blocked provider’s held payments by organization, payout key or on-chain account', async () => {
      const call = await seedHeld();
      const none = { organizationIds: [], walletKeys: [], chainAccounts: [] };
      const ids = async (exclude: typeof none) =>
        (await payments.findHeldOfBlockedProviders('RAIL_B_VOUCHER', exclude, 7 * 86_400, 500)).map(
          (row) => row.id,
        );
      const near = async (exclude: typeof none) =>
        (
          await payments.findBlockedHeldNearTimeout(
            'RAIL_B_VOUCHER',
            exclude,
            7 * 86_400,
            86_400,
            86_400,
            500,
          )
        ).map((row) => row.id);
      const byOrg = { ...none, organizationIds: [provider] };

      expect(await ids(none)).toEqual([]);
      expect(await ids(byOrg)).toContain(call.intentId);
      expect(
        await ids({
          ...none,
          walletKeys: [subjectKey(BlockSubjectKind.WALLET, PAYEE) as string],
        }),
      ).toContain(call.intentId);
      expect(await ids({ ...none, chainAccounts: [PAYEE] })).toContain(call.intentId);
      // The payer's side is not the provider's.
      expect(await ids({ ...none, organizationIds: [buyer] })).not.toContain(call.intentId);
      expect(await payments.findHeldAssetIds('RAIL_B_VOUCHER')).toContain(ASSET);

      // A day before the timeout: still refundable, not paged yet.
      await endWindow(call, 7 * 86_400_000 - 25 * 3_600_000);
      expect(await ids(byOrg)).toContain(call.intentId);
      expect(await near(byOrg)).not.toContain(call.intentId);
      // Inside the last 24 h: refundable and paged.
      await endWindow(call, 7 * 86_400_000 - 23 * 3_600_000);
      expect(await ids(byOrg)).toContain(call.intentId);
      expect(await near(byOrg)).toContain(call.intentId);
      // Past the timeout: refundHeld is closed; still paged, for a day.
      await endWindow(call, 7 * 86_400_000 + 60_000);
      expect(await ids(byOrg)).not.toContain(call.intentId);
      expect(await near(byOrg)).toContain(call.intentId);
      await endWindow(call, 8 * 86_400_000 + 60_000);
      expect(await near(byOrg)).not.toContain(call.intentId);
    });

    it('the open dispute of a blocked provider’s refunded call reads refunded, and stays refunded when decided', async () => {
      const upheld = await seedHeld();
      const rejected = await seedHeld();
      const first = await file(upheld);
      const second = await file(rejected);
      await withProviderBlocked(async () => {
        await collection.run();
      });

      for (const id of [first.id, second.id]) {
        expect(await disputes.requireAny(id)).toMatchObject({
          state: 'OPEN',
          refundSource: 'UNCOLLECTED_EARNINGS',
          refundState: 'REFUNDED',
          refundAmount: PRICE.toString(),
        });
      }
      expect(await upholdAndRefund(first.id)).toMatchObject({
        state: 'UPHELD',
        refundState: 'REFUNDED',
      });
      await decide(second.id, CallDisputeDecision.REJECT);
      expect(await disputes.requireAny(second.id)).toMatchObject({
        state: 'REJECTED',
        refundState: 'REFUNDED',
      });
      // Refunded once each: nothing moved twice.
      expect(sentFor('refund')).toHaveLength(1);
      expect(await journalTypes(upheld.intentId)).toEqual(REFUNDED);
      expect(await journalTypes(rejected.intentId)).toEqual(REFUNDED);
      await assertBooksBalance();
    });

    it('a chain refund nothing explains any more (the block was lifted) is still booked', async () => {
      const call = await seedHeld();
      await dataSource.query(
        `UPDATE payment_intents SET redemption_last_error = 'ProviderBlocked' WHERE id = $1`,
        [call.intentId],
      );
      // The refund landed; the block was lifted before the booking.
      await held.refund(ASSET, [keyOf(call)]);
      await endWindow(call);

      await collection.run();

      await assertRefunded(call);
      expect((await intentRow(call.intentId)).redemption_last_error).toBe(
        'provider_forfeit:ProviderBlocked',
      );
    });

    it('past the timeout: rows that are never sent leave the collect queue, and synced ones back off', async () => {
      const undisputed = await seedHeld();
      const disputed = await seedHeld();
      await file(disputed);
      const blocked = await seedHeld();
      for (const call of [undisputed, disputed, blocked]) {
        await endWindow(call, 7 * 86_400_000 + 60_000);
      }
      // Another provider's call, and that provider blocked.
      const other = randomUUID();
      await dataSource.query(`UPDATE payment_intents SET provider_id = $2 WHERE id = $1`, [
        blocked.intentId,
        other,
      ]);
      const exclude = { organizationIds: [other], walletKeys: [], chainAccounts: [] };
      const none = { organizationIds: [], walletKeys: [], chainAccounts: [] };
      const timedOut = async (e: typeof none) =>
        (await payments.findTimedOutCollectable('RAIL_B_VOUCHER', e, 7 * 86_400 - 900, 500)).map(
          (row) => row.id,
        );
      const toSync = async (e: typeof none) =>
        (await payments.findHeldPastTimeout('RAIL_B_VOUCHER', e, 7 * 86_400, 500)).map(
          (row) => row.id,
        );
      const collectable = async () =>
        (await payments.findCollectable('RAIL_B_VOUCHER', 500, none, 7 * 86_400 - 900)).map(
          (row) => row.id,
        );

      // Unblocked: the undisputed one is collected singly, the disputed one synced.
      expect(await timedOut(none)).toEqual(
        expect.arrayContaining([undisputed.intentId, blocked.intentId]),
      );
      expect(await timedOut(none)).not.toContain(disputed.intentId);
      expect(await toSync(none)).toContain(disputed.intentId);
      expect(await toSync(none)).not.toContain(undisputed.intentId);
      // Never in the batched queue past the timeout.
      expect(await collectable()).not.toEqual(expect.arrayContaining([undisputed.intentId]));
      // A blocked provider's: out of the collect queue, into the sync one.
      expect(await timedOut(exclude)).not.toContain(blocked.intentId);
      expect(await toSync(exclude)).toEqual(
        expect.arrayContaining([disputed.intentId, blocked.intentId]),
      );

      addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: other });
      try {
        await collection.run();
      } finally {
        await blocklist.applied({
          kind: 'unblocked',
          subjectKind: BlockSubjectKind.ORGANIZATION,
          subjectKey: other,
        } as never);
      }
      // Synced and still held: backed off, so they leave the head of the queue.
      expect(await toSync(exclude)).not.toEqual(expect.arrayContaining([disputed.intentId]));
      expect(await toSync(exclude)).not.toEqual(expect.arrayContaining([blocked.intentId]));
      expect(await chainStatus(blocked)).toBe(HeldStatus.HELD);
      expect(await chainStatus(disputed)).toBe(HeldStatus.HELD);
      await assertCollected(undisputed);
    });

    it('a held row whose record reads as nothing backs off', async () => {
      const call = await seedHeld();
      await endWindow(call);
      held.readMode = 'null';
      await collection.run();
      held.readMode = 'normal';
      const row = await payments.findOneBy({ organizationId: buyer, id: call.intentId });
      expect(row?.heldAttempts).toBe(1);
      expect(row?.heldRetryAt?.getTime()).toBeGreaterThan(Date.now());
      expect(await chainStatus(call)).toBe(HeldStatus.HELD);
    });

    it('guarantees a refund only where the hold is live', async () => {
      held.live = false;
      const call = await seedSettled();
      const dispute = await file(call);
      expect(dispute.refundGuaranteed).toBe(false);
      expect((await intentRow(call.intentId)).dispute_outcome).toBeNull();
    });

    it('refuses a new filing on a call whose dispute was decided, and never flips its outcome', async () => {
      const call = await seedCollected();
      const first = await file(call);
      await decide(first.id, CallDisputeDecision.REJECT);

      await expect(file(call)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_ALREADY_DECIDED,
      });
      expect((await intentRow(call.intentId)).dispute_outcome).toBe('REJECTED');
    });

    it('caps the open disputes against one provider in a day', async () => {
      config.maxPerProviderPerDay = 1;
      await file(await seedHeld());
      await expect(file(await seedHeld())).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_RATE_LIMITED,
      });
      // Per (buyer, provider): another buyer is not blocked by this one.
      const otherBuyer = buyer;
      buyer = randomUUID();
      payer = toAccountId(CHAIN, `buyer-${randomUUID()}`) as AccountId;
      await expect(file(await seedHeld())).resolves.toMatchObject({ state: 'OPEN' });
      expect(otherBuyer).not.toBe(buyer);
    });
  });

  // ── Rail A ──────────────────────────────────────────────────────────────

  describe('rail A (the facilitator settled at call time)', () => {
    async function seedRailA(): Promise<Call> {
      const call = await seedSettled({ railA: true });
      await intents.resolve(
        buyer,
        call.intentId,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      );
      return call;
    }

    it('withholds the provider’s credit for the window, then credits it', async () => {
      const call = await seedRailA();
      expect((await intentRow(call.intentId)).held_status).toBe('HELD');
      expect(await journalTypes(call.intentId)).toEqual(['HOLD_CREATE']);
      expect(await collection.run()).toBe(0);

      await endWindow(call);
      expect(await collection.run()).toBe(1);

      await assertCollected(call);
      const [credit] = (await dataSource.query(
        `SELECT chain_tx_ref FROM ledger_entries WHERE intent_id = $1 AND entry_type = 'PROVIDER_CREDIT'`,
        [call.intentId],
      )) as { chain_tx_ref: string }[];
      expect(credit.chain_tx_ref).toBe('legacy:pooled-vault-no-chain-transfer');
    });

    it('rail A: a blocked provider’s withheld credit is released to the buyer, never credited', async () => {
      const call = await seedRailA();
      await withProviderBlocked(async () => {
        await collection.run();
        await endWindow(call);
        await collection.run();
      });

      expect(sentFor('refund')).toEqual([]);
      await assertRefunded(call);
      expect(await intentRow(call.intentId)).toMatchObject({
        held_status: 'REFUNDED',
        redemption_last_error: 'provider_forfeit:ProviderBlocked',
      });
    });

    it('an upheld dispute in the window refunds the buyer from the uncredited amount', async () => {
      const call = await seedRailA();
      const dispute = await file(call);
      expect(dispute.refundGuaranteed).toBe(true);

      await decide(dispute.id, CallDisputeDecision.UPHOLD);

      expect((await intentRow(call.intentId)).held_status).toBe('REFUNDED');
      expect(sentFor('refund')).toEqual([]);
      expect(sentFor('collect')).toEqual([]);
      await assertRefunded(call);
    });
  });

  // ── Filing ──────────────────────────────────────────────────────────────

  describe('filing', () => {
    it('snapshots the evidence, tells the provider, and scrubs the bodies after retention', async () => {
      const call = await seedHeld();

      const dispute = await disputes.file(session(), {
        subjectType: CallDisputeSubjectType.VERDICT,
        subjectId: call.verdictId,
        reason: CallDisputeReason.EMPTY_OR_GARBAGE,
      });

      expect(dispute).toMatchObject({
        state: 'OPEN',
        intentId: call.intentId,
        verdictId: call.verdictId,
        providerId: provider,
        reason: 'EMPTY_OR_GARBAGE',
        note: null,
        amount: { amount: PRICE.toString() },
        canRespond: true,
      });
      expect(dispute.evidence).toMatchObject({
        call: { intentId: call.intentId, amount: PRICE.toString() },
        verdict: { id: call.verdictId, status: 'UNVERIFIED' },
        request: { city: 'Paris' },
        response: { temperature: null },
      });
      expect(notified).toEqual([
        expect.objectContaining({ organizationId: provider, event: 'call_dispute.opened' }),
      ]);

      await decide(dispute.id, CallDisputeDecision.REJECT);
      expect(await retention.sweep()).toBe(0);
      const later = new Date(Date.now() + config.snapshotRetentionMs + 60_000);
      expect(await retention.sweep(later)).toBeGreaterThanOrEqual(1);
      const scrubbed = await disputes.getForBuyer(buyer, dispute.id);
      expect(scrubbed.evidence).not.toHaveProperty('request');
      expect(scrubbed.evidence).toMatchObject({ call: { intentId: call.intentId } });
    });

    it('allows one open dispute per call, and a new one once it is withdrawn', async () => {
      const call = await seedCollected();
      const first = await file(call);

      await expect(file(call)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_ALREADY_OPEN,
      });

      await disputes.withdraw(session(), first.id);
      await expect(file(call)).resolves.toMatchObject({ state: 'OPEN' });
    });

    it('refuses a call outside the filing window, a free call, and another tenant’s call', async () => {
      const old = await seedSettled({ settledAgoMs: 8 * 24 * 3_600_000 });
      await expect(file(old)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_FILING_WINDOW_CLOSED,
      });

      const free = await seedSettled({ callClass: 'FREE' });
      await expect(file(free)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_CALL_NOT_DISPUTABLE,
      });

      const mine = await seedSettled();
      await expect(
        disputes.file(session(randomUUID()), {
          subjectType: CallDisputeSubjectType.PAYMENT_INTENT,
          subjectId: mine.intentId,
          reason: CallDisputeReason.OTHER,
        }),
      ).rejects.toMatchObject({ errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND });
    });

    it('lets the provider reply once, and never shows it other providers’ disputes', async () => {
      const call = await seedHeld();
      const dispute = await file(call);

      await expect(
        disputes.respond(session(randomUUID()), dispute.id, 'Not mine'),
      ).rejects.toMatchObject({ errorCode: DisputeErrorCode.DISPUTE_NOT_FOUND });

      const answered = await disputes.respond(session(provider), dispute.id, 'No data upstream.');
      expect(answered).toMatchObject({ providerResponse: 'No data upstream.', canRespond: false });
      await expect(disputes.respond(session(provider), dispute.id, 'Again')).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_ALREADY_RESPONDED,
      });

      const page = await disputes.listForProvider(provider, { limit: 20 } as never);
      expect(page.items.map((row) => row.id)).toEqual([dispute.id]);
      const theirs = await disputes.listForProvider(randomUUID(), { limit: 20 } as never);
      expect(theirs.items).toEqual([]);
    });
  });

  describe('abuse', () => {
    it('flags a buyer whose disputes are mostly rejected, and tightens its daily limit', async () => {
      for (let i = 0; i < config.abuseRejectedThreshold; i += 1) {
        const dispute = await file(await seedCollected());
        await decide(dispute.id, CallDisputeDecision.REJECT);
      }
      await expect(file(await seedCollected())).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_RATE_LIMITED,
        statusCode: 429,
      });

      expect(await disputes.buyerHistory(buyer)).toMatchObject({
        rejectedLast30Days: config.abuseRejectedThreshold,
        flagged: true,
        dailyLimit: config.abuseMaxFilingsPerDay,
      });
      const flagged = await disputes.listForOperator({ limit: 50, flaggedOnly: true } as never);
      expect(flagged.items.every((row) => row.buyerHistory.flagged)).toBe(true);
    });

    it('rate-limits filings per organization per day', async () => {
      config.maxFilingsPerDay = 2;
      try {
        await file(await seedCollected());
        await file(await seedCollected());
        await expect(file(await seedCollected())).rejects.toMatchObject({
          errorCode: DisputeErrorCode.DISPUTE_RATE_LIMITED,
        });
      } finally {
        config.maxFilingsPerDay = DEFAULT_CALL_DISPUTE_CONFIG.maxFilingsPerDay;
      }
    });
  });
});
