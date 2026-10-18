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
import { REDEEM_GRACE_SECONDS } from '@modules/payment/constants/voucher-redemption.constants';
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
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { ProviderEarningsGroupBy } from '@modules/provider/dto/get-provider-earnings.dto';
import { ProviderEarningsService } from '@modules/provider/services/provider-earnings.service';
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
  let payments: PaymentIntentRepository;
  let retention: CallDisputeRetentionService;

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
    payments = new PaymentIntentRepository(dataSource);
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
    retention = new CallDisputeRetentionService(dataSource, config);

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

  /**
   * `HELD`: inside the dispute hold (`collectable_at` an hour away).
   * `PAST_WINDOW`: past it and not redeemed yet. `REDEEMED`: collected.
   * `DEBT` / `WRITTEN_OFF`: the voucher lapsed (buyer debt).
   */
  type Collection = 'HELD' | 'PAST_WINDOW' | 'REDEEMED' | 'DEBT' | 'WRITTEN_OFF';

  /**
   * A served, paid rail-B call settled a minute ago: the buyer funded, its
   * hold opened, the intent SETTLED, and a verification record — then taken
   * to the collection state the test names.
   */
  async function seedCall(
    collection: Collection,
    options: { settledAgoMs?: number; callClass?: string } = {},
  ): Promise<{ intentId: string; verdictId: string; holdId: string; seq: number }> {
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
         voucher_signature, voucher_resource_hash, voucher_issued_at, collectable_at)
       VALUES ($1, $2, 'SETTLED', $3, $4, $5, $6, $7, $8, 'RAIL_B_VOUCHER', $9, $10, $11, 6,
               $12, $13, $14, $15, $16, now() + interval '4 minutes', $20, $17, $18, $19, $21)`,
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
        String(seq),
        collection === 'HELD' ? new Date(Date.now() + 3_600_000) : new Date(Date.now() - 60_000),
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
      case 'HELD':
      case 'PAST_WINDOW':
        break;
      case 'REDEEMED':
        await redeem(intentId);
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
    return { intentId, verdictId, holdId: hold.id, seq };
  }

  /** The intent ids the redemption job would take now, for this buyer. */
  async function queued(): Promise<string[]> {
    const rows = await payments.findAwaitingRedemption(ASSET, 'SETTLED', 'RAIL_B_VOUCHER', 500);
    return rows.filter((row) => row.agentAccount === payer).map((row) => row.id);
  }

  /** What the redemption job does once `redeem_voucher` lands. */
  async function redeem(intentId: string): Promise<void> {
    await intents.commitRedeemedHold(buyer, intentId, `0x${randomUUID().replace(/-/g, '')}`);
  }

  /** Moves a held call's window into the past, as time would. */
  async function endWindow(intentId: string): Promise<void> {
    await dataSource.query(
      `UPDATE payment_intents SET collectable_at = now() - interval '1 second' WHERE id = $1`,
      [intentId],
    );
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
      `SELECT entry_type FROM ledger_entries WHERE intent_id = $1 ORDER BY entry_type`,
      [intentId],
    )) as { entry_type: string }[];
    return rows.map((row) => row.entry_type);
  }

  const COLLECTED = ['HOLD_COMMIT', 'HOLD_CREATE', 'PLATFORM_FEE', 'PROVIDER_CREDIT'];
  const REFUNDED = ['HOLD_CREATE', 'HOLD_RELEASE'];

  async function intentRow(intentId: string) {
    const [row] = (await dataSource.query(
      `SELECT redemption_last_error, hold_released_at, dispute_outcome, collectable_at, expires_at
         FROM payment_intents WHERE id = $1`,
      [intentId],
    )) as {
      redemption_last_error: string | null;
      hold_released_at: Date | null;
      dispute_outcome: string | null;
      collectable_at: Date | null;
      expires_at: Date;
    }[];
    return row;
  }

  async function assertBooksBalance(): Promise<void> {
    expect((await ledger.verifySnapshots(buyer)).ok).toBe(true);
    expect((await ledger.verifySnapshots(provider)).ok).toBe(true);
  }

  /** The buyer charged and the provider credited for one call. */
  async function assertCollected(intentId: string): Promise<void> {
    expect(await journalTypes(intentId)).toEqual(COLLECTED);
    expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: 0n });
    expect(await balance(PAYEE, provider)).toEqual({ available: PROVIDER_AMOUNT, held: 0n });
    await assertBooksBalance();
  }

  /** The buyer whole, nobody credited, the voucher never redeemed. */
  async function assertRefunded(intentId: string): Promise<void> {
    expect(await journalTypes(intentId)).toEqual(REFUNDED);
    expect(await balance(payer)).toEqual({ available: FUNDED, held: 0n });
    expect(await balance(PAYEE, provider)).toEqual({ available: 0n, held: 0n });
    expect(await queued()).not.toContain(intentId);
    await assertBooksBalance();
  }

  // ── The dispute hold ────────────────────────────────────────────────────

  describe('the dispute hold', () => {
    it('no dispute: the voucher waits out the window, then is redeemed', async () => {
      const { intentId } = await seedCall('HELD');
      expect(await queued()).not.toContain(intentId);
      // Held, not payable: still in the buyer's held bucket, nothing credited.
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: PRICE });
      expect(await balance(PAYEE, provider)).toEqual({ available: 0n, held: 0n });

      const earnings = () =>
        new ProviderEarningsService(payments).getEarnings(provider, {
          from: new Date(Date.now() - 3_600_000).toISOString(),
          to: new Date(Date.now() + 3_600_000).toISOString(),
          groupBy: ProviderEarningsGroupBy.TOOL,
        } as never);
      expect((await earnings()).totals).toMatchObject({
        pendingInWindow: { amount: PROVIDER_AMOUNT.toString() },
        pendingInWindowCalls: 1,
        earned: { amount: '0' },
        debtOutstandingCalls: 0,
      });

      await endWindow(intentId);
      expect(await queued()).toContain(intentId);
      await redeem(intentId);
      await assertCollected(intentId);
      expect((await earnings()).totals).toMatchObject({
        pendingInWindowCalls: 0,
        earned: { amount: PROVIDER_AMOUNT.toString() },
      });
    });

    it('upheld inside the window: a full refund, and nothing is ever redeemed', async () => {
      const { intentId } = await seedCall('HELD');
      const dispute = await file(intentId);
      expect(dispute).toMatchObject({ refundGuaranteed: true });
      expect(dispute.refundNotice).toMatch(/refunded in full/);
      expect((await intentRow(intentId)).dispute_outcome).toBe('OPEN');

      // The window ends while the dispute is open: still not collected.
      await endWindow(intentId);
      expect(await queued()).not.toContain(intentId);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;
      expect(decided).toMatchObject({
        state: 'UPHELD',
        refundGuaranteed: true,
        refundSource: 'UNCOLLECTED_EARNINGS',
        refundState: 'REFUNDED',
        restoredAmount: { amount: PRICE.toString() },
      });
      expect(await intentRow(intentId)).toMatchObject({
        redemption_last_error: 'voided:DISPUTE_UPHELD',
        dispute_outcome: 'UPHELD',
      });
      await assertRefunded(intentId);
    });

    it('rejected: the held voucher goes back to the queue and is redeemed after the decision', async () => {
      const { intentId } = await seedCall('HELD');
      const dispute = await file(intentId);
      await endWindow(intentId);
      expect(await queued()).not.toContain(intentId);

      await decide(dispute.id, CallDisputeDecision.REJECT);

      expect((await intentRow(intentId)).dispute_outcome).toBe('REJECTED');
      expect(await queued()).toContain(intentId);
      await redeem(intentId);
      await assertCollected(intentId);
    });

    it('withdrawn: the hold is lifted and collection proceeds', async () => {
      const { intentId } = await seedCall('HELD');
      const dispute = await file(intentId);
      await endWindow(intentId);

      await disputes.withdraw(session(), dispute.id);

      expect((await intentRow(intentId)).dispute_outcome).toBeNull();
      expect(await queued()).toContain(intentId);
    });

    it('filed after the window: a quality signal; a collected call is not refunded', async () => {
      const { intentId } = await seedCall('PAST_WINDOW');
      const dispute = await file(intentId);
      expect(dispute.refundGuaranteed).toBe(false);
      expect(dispute.refundNotice).toMatch(/after the dispute window/);
      // Nothing holds it: collection goes on during the dispute.
      expect((await intentRow(intentId)).dispute_outcome).toBeNull();
      expect(await queued()).toContain(intentId);
      // Upholding while the redemption is in flight waits.
      await expect(decide(dispute.id, CallDisputeDecision.UPHOLD)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_COLLECTION_IN_PROGRESS,
      });

      await redeem(intentId);
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
      expect((await intentRow(intentId)).dispute_outcome).toBe('UPHELD');
      await assertCollected(intentId);
    });

    it('filed after the window on uncollected money (buyer debt): still refunded', async () => {
      const { intentId } = await seedCall('DEBT');
      expect(await balance(payer)).toEqual({ available: FUNDED - PRICE, held: PRICE });
      const dispute = await file(intentId);
      expect(dispute.refundGuaranteed).toBe(false);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided).toMatchObject({ refundState: 'REFUNDED', secondedBy: null });
      expect(decided.history).toEqual([
        expect.objectContaining({ code: 'S-14', action: 'call_dispute.decided' }),
      ]);
      expect((await intentRow(intentId)).redemption_last_error).toBe('voided:DISPUTE_UPHELD');
      await assertRefunded(intentId);
      expect(notified.filter((n) => n.event === 'call_dispute.decided')).toHaveLength(2);
    });

    it('voids a written-off debt: the buyer no longer owes it, and no money moves again', async () => {
      const { intentId } = await seedCall('WRITTEN_OFF');
      const dispute = await file(intentId);

      const decided = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(decided.refundState).toBe('REFUNDED');
      expect((await intentRow(intentId)).redemption_last_error).toBe('voided:DISPUTE_UPHELD');
      await assertRefunded(intentId);
    });
  });

  describe('voucher expiry safety', () => {
    it('stamps a window capped below the voucher’s on-chain deadline on the move to SETTLED', async () => {
      const intentId = randomUUID();
      await dataSource.query(
        `INSERT INTO payment_intents (
           id, organization_id, status, agent_id, agent_account, provider_id, provider_account,
           tool_id, rail, call_id, call_class, asset_id, decimals, price_amount,
           provider_amount, platform_fee, request_hash, chain_id, expires_at, voucher_seq,
           voucher_signature, voucher_resource_hash, voucher_issued_at)
         VALUES ($1, $2, 'VERIFYING', $3, $4, $5, $6, $7, 'RAIL_B_VOUCHER', $8, 'PAID', $9, 6,
                 $10, $11, $12, $13, $14, now() + interval '5 minutes', $15, $16, $17, $18)`,
        [
          intentId,
          buyer,
          randomUUID(),
          payer,
          provider,
          PAYEE,
          TOOL,
          randomUUID(),
          ASSET,
          PRICE.toString(),
          PROVIDER_AMOUNT.toString(),
          FEE.toString(),
          `sha256:${'ab'.repeat(32)}`,
          CHAIN,
          String((voucherSeq += 1)),
          `0x${'12'.repeat(65)}`,
          `sha256:${'cd'.repeat(32)}`,
          String(Math.floor(Date.now() / 1000)),
        ],
      );

      // The default window is an hour; the voucher dies 35 minutes from now.
      await intents.resolve(
        buyer,
        intentId,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      );

      const row = await intentRow(intentId);
      const deadline = row.expires_at.getTime() + REDEEM_GRACE_SECONDS * 1000;
      expect(row.collectable_at).not.toBeNull();
      const collectable = (row.collectable_at as Date).getTime();
      expect(collectable).toBeLessThan(Date.now() + 3_600_000 - 60_000);
      // At least ten minutes left between the window's end and the chain's deadline.
      expect(deadline - collectable).toBeGreaterThanOrEqual(600_000);
    });

    it('keeps seq order across the window: a later voucher waits for an earlier held one', async () => {
      const earlier = await seedCall('HELD');
      const later = await seedCall('PAST_WINDOW');
      expect(await queued()).not.toContain(later.intentId);

      await endWindow(earlier.intentId);
      expect(await queued()).toEqual([earlier.intentId, later.intentId]);
    });

    it('a disputed voucher does not hold the buyer’s later vouchers past their deadline', async () => {
      const disputed = await seedCall('HELD');
      const later = await seedCall('PAST_WINDOW');
      await file(disputed.intentId);

      expect(await queued()).toEqual([later.intentId]);
      await redeem(later.intentId);

      // The disputed voucher is now unredeemable on chain (a higher seq landed):
      // rejected, it is queued, the chain refuses it and it becomes buyer debt
      // through the existing flow — the provider is never paid by the platform.
      await endWindow(disputed.intentId);
      const [dispute] = (await disputes.listForBuyer(buyer, { limit: 5 } as never)).items;
      await decide(dispute.id, CallDisputeDecision.REJECT);
      expect(await queued()).toContain(disputed.intentId);
      await payments.lapseRedemption(buyer, disputed.intentId, 'VoucherSeqNotIncreasing');
      expect(await queued()).not.toContain(disputed.intentId);
      expect(await balance(payer)).toEqual({
        available: 2n * FUNDED - 2n * PRICE,
        held: PRICE,
      });
      await assertBooksBalance();
    });
  });

  // ── Filing ──────────────────────────────────────────────────────────────

  describe('filing', () => {
    it('snapshots the evidence, tells the provider, and scrubs the bodies after retention', async () => {
      const { intentId, verdictId } = await seedCall('HELD');

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

      await decide(dispute.id, CallDisputeDecision.REJECT);
      expect(await retention.sweep()).toBe(0);
      const later = new Date(Date.now() + config.snapshotRetentionMs + 60_000);
      expect(await retention.sweep(later)).toBeGreaterThanOrEqual(1);
      const scrubbed = await disputes.getForBuyer(buyer, dispute.id);
      expect(scrubbed.evidence).not.toHaveProperty('request');
      expect(scrubbed.evidence).not.toHaveProperty('response');
      expect(scrubbed.evidence).toMatchObject({ call: { intentId }, verdict: { id: verdictId } });
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

  // ── Decisions ───────────────────────────────────────────────────────────

  describe('deciding', () => {
    it('is idempotent: deciding again or re-running the refund moves nothing twice', async () => {
      const { intentId } = await seedCall('HELD');
      const dispute = await file(intentId);
      await decide(dispute.id, CallDisputeDecision.UPHOLD);

      await expect(decide(dispute.id, CallDisputeDecision.UPHOLD)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_NOT_DECIDABLE,
      });
      await expect(decide(dispute.id, CallDisputeDecision.REJECT)).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_NOT_DECIDABLE,
      });
      await disputes.settleRefund(dispute.id);
      await expect(intents.releaseDisputedHold(buyer, intentId, 'DISPUTE_UPHELD')).resolves.toBe(
        false,
      );
      await assertRefunded(intentId);
    });

    it('finishes a refund whose money step never ran (a crash after the decision committed)', async () => {
      const { intentId } = await seedCall('HELD');
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
      // Upheld but not yet released: still out of the redemption queue.
      await endWindow(intentId);
      expect(await queued()).not.toContain(intentId);

      const finished = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as OperatorCallDisputeDetailDto;

      expect(finished.refundState).toBe('REFUNDED');
      await assertRefunded(intentId);
    });

    it('needs a second operator at or above the threshold, and refuses self-approval', async () => {
      config.twoPersonThresholdMinor = PRICE.toString();
      const { intentId } = await seedCall('HELD');
      const dispute = await file(intentId);

      const queuedApproval = (await decide(
        dispute.id,
        CallDisputeDecision.UPHOLD,
      )) as ApprovalQueuedDto;
      expect(queuedApproval).toMatchObject({ status: 'PENDING' });
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
      await assertRefunded(intentId);
    });

    it('rejects with a reason and marks the call; a held voucher is then collected', async () => {
      const { intentId } = await seedCall('HELD');
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
  });

  describe('abuse', () => {
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
