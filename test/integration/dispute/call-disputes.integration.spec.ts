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
import { CallDisputeService } from '@modules/dispute/services/call-dispute.service';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerWriterService } from '@modules/ledger/services/ledger-writer.service';
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
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';
import { AuditLogWriter } from '@shared/audit';
import { MoneyUtil } from '@shared/utils/money.util';

import { noBlocks } from '../../unit/helpers/blocklist';
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
    ledger = new LedgerService(
      journal,
      new LedgerWriterService(journal, dataSource),
      balances,
      holds,
    );
    const payments = new PaymentIntentRepository(dataSource);
    intents = new PaymentIntentService(payments, ledger, DISABLED_ESCROW_GATE, noBlocks());

    notified = [];
    const notifications: NotificationPort = {
      notify: async (request) => {
        notified.push(request);
        return { deliveredNow: true };
      },
    } as NotificationPort;
    const evidence = { forBuyer: async () => null } as unknown as EvidencePackService;
    config = { ...DEFAULT_CALL_DISPUTE_CONFIG, twoPersonThresholdMinor: '5000000' };

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

    adjudicator = await seedOperator('adj-a', [OperatorRole.ADJ]);
    second = await seedOperator('adj-b', [OperatorRole.ADJL]);
  }, 300_000);

  afterAll(async () => dataSource?.destroy());

  beforeEach(() => {
    buyer = randomUUID();
    provider = randomUUID();
    payer = toAccountId(CHAIN, `buyer-${randomUUID()}`) as AccountId;
    notified = [];
    config.twoPersonThresholdMinor = '5000000';
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

  type Collection = 'AWAITING' | 'REDEEMED' | 'DEBT' | 'WRITTEN_OFF';

  /**
   * A served, paid rail-B call settled a minute ago: the buyer funded, its
   * hold opened, the intent SETTLED, and a verification record — then taken
   * to the collection state the test names.
   */
  async function seedCall(
    collection: Collection,
    options: { settledAgoMs?: number; callClass?: string } = {},
  ): Promise<{ intentId: string; verdictId: string; holdId: string }> {
    const intentId = randomUUID();
    const verdictId = randomUUID();
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
       VALUES ($1, $2, 'SETTLED', $3, $4, $5, $6, $7, $8, 'RAIL_B_VOUCHER', $9, $10, $11, 6,
               $12, $13, $14, $15, $16, now() - interval '1 hour', $20, $17, $18, $19)`,
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
        `0x${'12'.repeat(65)}`,
        `sha256:${'cd'.repeat(32)}`,
        String(Math.floor(Date.now() / 1000)),
        String((voucherSeq += 1)),
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

    switch (collection) {
      case 'AWAITING':
        break;
      case 'REDEEMED':
        await intents.commitRedeemedHold(buyer, intentId, `0x${'77'.repeat(32)}`);
        break;
      case 'DEBT':
        await dataSource.query(
          `UPDATE payment_intents
              SET redemption_lapsed_at = now() - interval '2 days',
                  redemption_last_error = 'DelegateIsRevoked'
            WHERE id = $1`,
          [intentId],
        );
        break;
      case 'WRITTEN_OFF':
        await dataSource.query(
          `UPDATE payment_intents
              SET redemption_lapsed_at = now() - interval '40 days',
                  redemption_last_error = 'DelegateIsRevoked'
            WHERE id = $1`,
          [intentId],
        );
        await expect(
          intents.writeOffDebt(
            { organizationId: buyer, id: intentId, payer, holdId: hold.id },
            'uncollected:DelegateIsRevoked',
            new Date(),
          ),
        ).resolves.toBe(true);
        break;
    }
    return { intentId, verdictId, holdId: hold.id };
  }

  async function file(
    intentId: string,
    reason = CallDisputeReason.WRONG_DATA,
  ): Promise<CallDisputeDetailDto> {
    return disputes.file(session(), {
      subjectType: CallDisputeSubjectType.PAYMENT_INTENT,
      subjectId: intentId,
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

  async function balance(account: string, organizationId = buyer) {
    const value = await ledger.getBalance(organizationId, account as AccountId, ASSET);
    return {
      available: MoneyUtil.toAtomic(value.available),
      held: MoneyUtil.toAtomic(value.held),
    };
  }

  async function journalTypes(intentId: string): Promise<string[]> {
    const rows = (await dataSource.query(
      `SELECT entry_type FROM ledger_entries WHERE intent_id = $1 ORDER BY seq`,
      [intentId],
    )) as { entry_type: string }[];
    return rows.map((row) => row.entry_type);
  }

  async function intentRow(intentId: string) {
    const [row] = (await dataSource.query(
      `SELECT redemption_last_error, hold_released_at, dispute_outcome
         FROM payment_intents WHERE id = $1`,
      [intentId],
    )) as {
      redemption_last_error: string | null;
      hold_released_at: Date | null;
      dispute_outcome: string | null;
    }[];
    return row;
  }

  async function assertBooksBalance(): Promise<void> {
    expect((await ledger.verifySnapshots(buyer)).ok).toBe(true);
    expect((await ledger.verifySnapshots(provider)).ok).toBe(true);
  }

  // ── Filing ──────────────────────────────────────────────────────────────

  describe('filing', () => {
    it('files a dispute over a paid call, snapshots its evidence and tells the provider', async () => {
      const { intentId, verdictId } = await seedCall('REDEEMED');

      const dispute = await disputes.file(session(), {
        subjectType: CallDisputeSubjectType.VERDICT,
        subjectId: verdictId,
        reason: CallDisputeReason.EMPTY_OR_GARBAGE,
      });

      expect(dispute).toMatchObject({
        state: 'OPEN',
        intentId,
        verdictId,
        providerId: provider,
        reason: 'EMPTY_OR_GARBAGE',
        note: null,
        amount: { amount: PRICE.toString() },
        canRespond: true,
      });
      expect(dispute.evidence).toMatchObject({
        call: { intentId, amount: PRICE.toString() },
        verdict: { id: verdictId, status: 'UNVERIFIED' },
        request: { city: 'Paris' },
        response: { temperature: null },
      });
      expect(notified).toEqual([
        expect.objectContaining({ organizationId: provider, event: 'call_dispute.opened' }),
      ]);
      const [audit] = (await dataSource.query(
        `SELECT action FROM audit_log_entries WHERE resource_id = $1`,
        [dispute.id],
      )) as { action: string }[];
      expect(audit.action).toBe('call_dispute.filed');
    });

    it('allows one open dispute per call, and a new one once it is withdrawn', async () => {
      const { intentId } = await seedCall('REDEEMED');
      const first = await file(intentId);

      await expect(file(intentId)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_ALREADY_OPEN,
      });

      await disputes.withdraw(session(), first.id);
      await expect(file(intentId)).resolves.toMatchObject({ state: 'OPEN' });
    });

    it('refuses a call outside the filing window, a free call, and another tenant’s call', async () => {
      const old = await seedCall('REDEEMED', { settledAgoMs: 8 * 24 * 3_600_000 });
      await expect(file(old.intentId)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_FILING_WINDOW_CLOSED,
      });

      const free = await seedCall('REDEEMED', { callClass: 'FREE' });
      await expect(file(free.intentId)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_CALL_NOT_DISPUTABLE,
      });

      const mine = await seedCall('REDEEMED');
      await expect(
        disputes.file(session(randomUUID()), {
          subjectType: CallDisputeSubjectType.PAYMENT_INTENT,
          subjectId: mine.intentId,
          reason: CallDisputeReason.OTHER,
        }),
      ).rejects.toMatchObject({ errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND });
    });

    it('lets the provider reply once, before the decision, and never shows it other providers’ disputes', async () => {
      const { intentId } = await seedCall('REDEEMED');
      const dispute = await file(intentId);

      await expect(
        disputes.respond(session(randomUUID()), dispute.id, 'Not mine'),
      ).rejects.toMatchObject({ errorCode: DisputeErrorCode.DISPUTE_NOT_FOUND });

      const answered = await disputes.respond(
        session(provider),
        dispute.id,
        'Upstream had no data.',
      );
      expect(answered).toMatchObject({
        providerResponse: 'Upstream had no data.',
        canRespond: false,
      });
      await expect(disputes.respond(session(provider), dispute.id, 'Again')).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_ALREADY_RESPONDED,
      });

      const page = await disputes.listForProvider(provider, { limit: 20 } as never);
      expect(page.items.map((row) => row.id)).toEqual([dispute.id]);
      const theirs = await disputes.listForProvider(randomUUID(), { limit: 20 } as never);
      expect(theirs.items).toEqual([]);
    });
  });

  // ── Decisions and money ────────────────────────────────────────────────

  describe('upholding', () => {
    it('voids an outstanding debt: the buyer is made whole, the provider is not paid', async () => {
      const { intentId } = await seedCall('DEBT');
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: PRICE });
      const dispute = await file(intentId);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided).toMatchObject({
        state: 'UPHELD',
        refundSource: 'UNCOLLECTED_EARNINGS',
        refundState: 'REFUNDED',
        refundAmount: { amount: PRICE.toString() },
        restoredAmount: { amount: PRICE.toString() },
        resolvedBy: adjudicator.operatorId,
        secondedBy: null,
      });
      expect(decided.history).toEqual([
        expect.objectContaining({ code: 'S-14', action: 'call_dispute.decided' }),
      ]);
      // Double entry: the hold opened and was released — nothing else moved.
      expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
      expect(await journalTypes(intentId)).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
      expect(await balance(PAYEE, provider)).toEqual({ available: 0n, held: 0n });
      expect(await intentRow(intentId)).toMatchObject({
        redemption_last_error: 'voided:DISPUTE_UPHELD',
        dispute_outcome: 'UPHELD',
      });
      const [verdict] = (await dataSource.query(
        `SELECT dispute_outcome FROM verification_records WHERE intent_id = $1`,
        [intentId],
      )) as { dispute_outcome: string }[];
      expect(verdict.dispute_outcome).toBe('UPHELD');
      expect(notified.filter((n) => n.event === 'call_dispute.decided')).toHaveLength(2);
      await assertBooksBalance();
    });

    it('is idempotent: deciding again or re-running the refund moves nothing twice', async () => {
      const { intentId } = await seedCall('DEBT');
      const dispute = await file(intentId);
      await decide(dispute.id, CallDisputeDecision.UPHOLD);

      await expect(decide(dispute.id, CallDisputeDecision.UPHOLD)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_NOT_DECIDABLE,
      });
      await expect(decide(dispute.id, CallDisputeDecision.REJECT)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_NOT_DECIDABLE,
      });
      await disputes.settleRefund(dispute.id);
      await expect(intents.voidDebt(buyer, intentId, 'DISPUTE_UPHELD')).resolves.toBe(false);

      expect(await journalTypes(intentId)).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
      expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
      await assertBooksBalance();
    });

    it('finishes a refund whose money step never ran (a crash after the decision committed)', async () => {
      const { intentId } = await seedCall('DEBT');
      const dispute = await file(intentId);
      // The decision commits, the process dies before `settleRefund`.
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
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: PRICE });

      const finished = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(finished.refundState).toBe('REFUNDED');
      expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
      expect(await journalTypes(intentId)).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
      await assertBooksBalance();
    });

    it('voids a written-off debt: the buyer no longer owes it, and no money moves again', async () => {
      const { intentId } = await seedCall('WRITTEN_OFF');
      expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
      const dispute = await file(intentId);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided.refundState).toBe('REFUNDED');
      expect(await intentRow(intentId)).toMatchObject({
        redemption_last_error: 'voided:DISPUTE_UPHELD',
      });
      expect(await journalTypes(intentId)).toEqual(['HOLD_CREATE', 'HOLD_RELEASE']);
      expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
      await assertBooksBalance();
    });

    it('opens a claim on the provider’s stake when the provider was already paid — the platform books nothing', async () => {
      const { intentId } = await seedCall('REDEEMED');
      const before = await journalTypes(intentId);
      expect([...before].sort()).toEqual([
        'HOLD_COMMIT',
        'HOLD_CREATE',
        'PLATFORM_FEE',
        'PROVIDER_CREDIT',
      ]);
      const providerBefore = await balance(PAYEE, provider);
      const dispute = await file(intentId);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided).toMatchObject({
        state: 'UPHELD',
        refundSource: 'PROVIDER_STAKE',
        refundState: 'STAKE_CLAIM_OPEN',
        refundAmount: { amount: PRICE.toString() },
        restoredAmount: null,
      });
      expect(await journalTypes(intentId)).toEqual(before);
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: 0n });
      expect(await balance(PAYEE, provider)).toEqual(providerBefore);
      expect((await intentRow(intentId)).dispute_outcome).toBe('UPHELD');
      await assertBooksBalance();
    });

    it('waits while the voucher is still being collected, and leaves the dispute open', async () => {
      const { intentId } = await seedCall('AWAITING');
      const dispute = await file(intentId);

      await expect(decide(dispute.id, CallDisputeDecision.UPHOLD)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_COLLECTION_IN_PROGRESS,
      });

      expect((await disputes.requireAny(dispute.id)).state).toBe('OPEN');
      expect(await journalTypes(intentId)).toEqual(['HOLD_CREATE']);
      expect((await intentRow(intentId)).dispute_outcome).toBeNull();
    });

    it('needs a second operator at or above the threshold, and refuses self-approval', async () => {
      config.twoPersonThresholdMinor = PRICE.toString();
      const { intentId } = await seedCall('DEBT');
      const dispute = await file(intentId);

      const queued = (await decide(dispute.id, CallDisputeDecision.UPHOLD)) as ApprovalQueuedDto;
      expect(queued).toMatchObject({ status: 'PENDING' });
      expect((await disputes.requireAny(dispute.id)).state).toBe('OPEN');
      expect(await journalTypes(intentId)).toEqual(['HOLD_CREATE']);

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
      expect((await disputes.requireAny(dispute.id)).state).toBe('OPEN');

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

      expect(decided).toMatchObject({
        state: 'UPHELD',
        refundState: 'REFUNDED',
        resolvedBy: adjudicator.operatorId,
        secondedBy: second.operatorId,
      });
      expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
      await assertBooksBalance();
    });
  });

  describe('rejecting, and abuse', () => {
    it('rejects with a reason, moves no money and marks the call', async () => {
      const { intentId } = await seedCall('DEBT');
      const dispute = await file(intentId);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.REJECT,
      )) as OperatorCallDisputeDetailDto;

      expect(decided).toMatchObject({
        state: 'REJECTED',
        resolutionNote: 'Checked the captured output against the contract.',
        refundSource: null,
        refundState: null,
      });
      expect((await intentRow(intentId)).dispute_outcome).toBe('REJECTED');
      expect(await journalTypes(intentId)).toEqual(['HOLD_CREATE']);
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: PRICE });
    });

    it('flags a buyer whose disputes are mostly rejected, and tightens its daily limit', async () => {
      for (let i = 0; i < config.abuseRejectedThreshold; i += 1) {
        const { intentId } = await seedCall('REDEEMED');
        const dispute = await file(intentId);
        await decide(dispute.id, CallDisputeDecision.REJECT);
      }
      // Filed today already exceeds the tighter limit.
      const { intentId } = await seedCall('REDEEMED');
      await expect(file(intentId)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_RATE_LIMITED,
        statusCode: 429,
      });

      const history = await disputes.buyerHistory(buyer);
      expect(history).toMatchObject({
        rejectedLast30Days: config.abuseRejectedThreshold,
        flagged: true,
        dailyLimit: config.abuseMaxFilingsPerDay,
      });
      const flagged = await disputes.listForOperator({ limit: 50, flaggedOnly: true } as never);
      expect(flagged.items.length).toBeGreaterThanOrEqual(config.abuseRejectedThreshold);
      expect(flagged.items.every((row) => row.buyerHistory.flagged)).toBe(true);
      const clean = await disputes.listForOperator({
        limit: 50,
        flaggedOnly: true,
        buyerOrganizationId: randomUUID(),
      } as never);
      expect(clean.items).toEqual([]);
    });

    it('rate-limits filings per organization per day', async () => {
      config.maxFilingsPerDay = 2;
      try {
        await file((await seedCall('REDEEMED')).intentId);
        await file((await seedCall('REDEEMED')).intentId);
        await expect(file((await seedCall('REDEEMED')).intentId)).rejects.toMatchObject({
          errorCode: DisputeErrorCode.DISPUTE_RATE_LIMITED,
        });
      } finally {
        config.maxFilingsPerDay = DEFAULT_CALL_DISPUTE_CONFIG.maxFilingsPerDay;
      }
    });
  });
});
