import { PaymentIntentDisputeHold1761800000000 } from '@database/postgres/migrations/1761800000000-payment-intent-dispute-hold';
import { VerificationRecordDisputeOutcome1761800000001 } from '@database/postgres/migrations/1761800000001-verification-record-dispute-outcome';
import { VoucherDelegate1759600000000 } from '@database/postgres/migrations/1759600000000-voucher-delegate';
import { VoucherAdmissionIndex1759600000003 } from '@database/postgres/migrations/1759600000003-voucher-admission-index';
import { PaymentIntentCredential1759600000004 } from '@database/postgres/migrations/1759600000004-payment-intent-credential';
import { VoucherAdmissionPause1759600000005 } from '@database/postgres/migrations/1759600000005-voucher-admission-pause';
import { VoucherAdmissionPausePerRequest1759600000006 } from '@database/postgres/migrations/1759600000006-voucher-admission-pause-per-request';
import { PaymentIntentRedemptionTxRefs1760200000000 } from '@database/postgres/migrations/1760200000000-payment-intent-redemption-tx-refs';
import { PaymentIntentRedemptionLastError1760600000000 } from '@database/postgres/migrations/1760600000000-payment-intent-redemption-last-error';
import { PaymentIntentRedemptionLapsed1760700000000 } from '@database/postgres/migrations/1760700000000-payment-intent-redemption-lapsed';
import { PaymentIntentDebtReplacing1760800000000 } from '@database/postgres/migrations/1760800000000-payment-intent-debt-replacing';
import { VoucherSeqDebtReplacement1760900000000 } from '@database/postgres/migrations/1760900000000-voucher-seq-debt-replacement';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { EvidenceBodyEntity } from '@database/postgres/entities/evidence-body.entity';
import { EvidencePackEntity } from '@database/postgres/entities/evidence-pack.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { CreatePaymentIntents1755200000000 } from '@database/postgres/migrations/1755200000000-create-payment-intents';
import { AddVoucherNonce1755300000000 } from '@database/postgres/migrations/1755300000000-add-voucher-nonce';
import { VoucherRedemptionFields1759100000002 } from '@database/postgres/migrations/1759100000002-voucher-redemption-fields';
import { RoutedPaymentIntents1755600000000 } from '@database/postgres/migrations/1755600000000-routed-payment-intents';
import { CreateVerificationPolicies1755700000000 } from '@database/postgres/migrations/1755700000000-create-verification-policies';
import { CreateVerificationRecords1755800000000 } from '@database/postgres/migrations/1755800000000-create-verification-records';
import { TimestamptzTimestamps1755900000000 } from '@database/postgres/migrations/1755900000000-timestamptz-timestamps';
import { CallIdAndCallClass1756800000000 } from '@database/postgres/migrations/1756800000000-call-id-and-call-class';
import { CreateToolBindingTables1756900000000 } from '@database/postgres/migrations/1756900000000-create-tool-binding-tables';
import { ToolBindingAuthMode1762000000002 } from '@database/postgres/migrations/1762000000002-tool-binding-auth-mode';
import { BindingTrafficControls1757200000000 } from '@database/postgres/migrations/1757200000000-binding-traffic-controls';
import { CreateEvidencePacks1757400000000 } from '@database/postgres/migrations/1757400000000-create-evidence-packs';
import { CreateApiSurfaceTables1756000000000 } from '@database/postgres/migrations/1756000000000-create-api-surface-tables';
import { NotificationsLimitsAndFreeTier1757500000000 } from '@database/postgres/migrations/1757500000000-notifications-limits-and-free-tier';
import { SettledIntentsNamePayee1758100000000 } from '@database/postgres/migrations/1758100000000-settled-intents-name-payee';
import { BuyerEscrowsAndVoucherSeq1759100000000 } from '@database/postgres/migrations/1759100000000-buyer-escrows-and-voucher-seq';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import type { AccountId } from '@modules/chains/ports/caip.types';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { DEFAULT_EVIDENCE_RETENTION } from '@modules/verification/config/evidence-retention.config';
import { DEFAULT_VERIFICATION_BUDGET } from '@modules/verification/domain/sampling';
import { EvidencePackSealerService } from '@modules/verification/services/evidence-pack-sealer.service';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';
import { VerificationAggregatorService } from '@modules/verification/services/verification-aggregator.service';
import { VerificationJudgePublisher } from '@modules/verification/publishers/verification-judge.publisher';
import { VerificationSettlementService } from '@modules/verification/services/verification-settlement.service';

import {
  USDC_ASSET,
  USDC_DECIMALS,
  ensureTestDatabase,
  resetSchemaIfMigrationsChanged,
  testConnectionOptions,
} from './test-database';
import { noBlocks } from '../../unit/helpers/blocklist';

/**
 * `PaymentIntentService.secureFunds` calls the escrow spend gate
 * before `createHold`. This context is about verification/judging, not the
 * gate — `ESCROW_SPEND_GATE_ENABLED` ships off, and a disabled stub is what
 * that looks like: present, never consulted for a decision.
 */
const DISABLED_ESCROW_GATE = {
  enabled: false,
  assertAffordable: async () => undefined,
} as unknown as EscrowSpendGateService;

/**
 * The real worker path — money included — against a real Postgres.
 *
 * The evidence pack needed this and did not have it: every other proof of "a judged
 * verdict always has evidence" either drove the two statements `judge()` issues
 * directly, or asserted the wiring with fakes. Neither answers the question a
 * reader actually has, which is whether the thing that runs in production
 * leaves a pack behind.
 *
 * So this context builds the ledger, the intent service and
 * `VerificationSettlementService` for real, and stubs exactly two collaborators:
 *
 * - **`VerificationAggregatorService.decide`** — the verdict itself. Its
 *   behaviour belongs to the aggregator and is tested there; here it is the *input* to the
 *   thing under test, and a test that had to configure a policy store to
 *   produce a FAIL would be testing policy resolution.
 * - **`VerificationJudgePublisher.publishJudge`** — a BullMQ wakeup. The worker
 *   loop is not what is being asserted; this context calls `judgeAndSettle`
 *   itself, which is what the queue would have done.
 *
 * Everything else is production code: the hold, the transition table, the
 * compare-and-swap, the transaction, the sealer and the chain.
 */
export interface JudgePathTestContext {
  readonly dataSource: DataSource;
  readonly settlement: VerificationSettlementService;
  readonly evidence: EvidencePackService;
  readonly intents: PaymentIntentService;
  readonly ledger: LedgerService;
  readonly records: VerificationRecordRepository;
  /** What `decide()` will answer. Set it per test. */
  readonly decide: jest.Mock;
  /** Rotated by `reset()` — one organization per test. */
  organizationId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  /**
   * Drives a call all the way to the point a verdict is owed: funds an agent,
   * creates the intent, secures the hold, walks the transition table to
   * `VERIFYING`, and enqueues the verification record.
   */
  callReadyToJudge(input?: { priceAtomic?: bigint; providerId?: string }): Promise<PaymentIntent>;
}

export async function createJudgePathTestContext(): Promise<JudgePathTestContext> {
  const database = await ensureTestDatabase(
    process.env.JUDGE_PATH_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_judge_path_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [
      LedgerEntryEntity,
      LedgerHoldEntity,
      AccountBalanceEntity,
      PaymentIntentEntity,
      VerificationRecordEntity,
      VerificationPolicyEntity,
      EvidencePackEntity,
      EvidenceBodyEntity,
    ],
    migrations: [
      CreateLedger1755100000000,
      CreatePaymentIntents1755200000000,
      AddVoucherNonce1755300000000,
      RoutedPaymentIntents1755600000000,
      CreateVerificationPolicies1755700000000,
      CreateVerificationRecords1755800000000,
      TimestamptzTimestamps1755900000000,
      CallIdAndCallClass1756800000000,
      CreateToolBindingTables1756900000000,
      BindingTrafficControls1757200000000,
      CreateEvidencePacks1757400000000,
      // The spend-limits migration adds `payment_intents.spend_policy_version`, which
      // `PaymentIntentEntity` maps — so without it every `create()` here failed
      // on a column that does not exist. It alters `spend_policies`, hence the
      // api-surface CREATE tagging along.
      CreateApiSurfaceTables1756000000000,
      NotificationsLimitsAndFreeTier1757500000000,
      // The payee CHECK this context's own seeding must now satisfy.
      SettledIntentsNamePayee1758100000000,
      // `payment_intents.voucher_seq`, which `PaymentIntentEntity`
      // maps. TypeORM names every mapped column in its INSERT and its SELECT,
      // so without this migration every intent this context writes fails on a
      // column that does not exist.
      BuyerEscrowsAndVoucherSeq1759100000000,
      // `voucher_signature`, `voucher_resource_hash` and
      // `voucher_issued_at`, all three mapped by `PaymentIntentEntity`. TypeORM
      // names every mapped column in its INSERT and its SELECT, so a context
      // that omits this migration fails on the column rather than on its
      // subject — which is exactly how it shipped: no context listed it.
      VoucherRedemptionFields1759100000002,
      // `payment_intents.voucher_delegate`, which `PaymentIntentEntity` maps
      // (agent payment delegation).
      VoucherDelegate1759600000000,
      VoucherAdmissionIndex1759600000003,
      PaymentIntentCredential1759600000004,
      // `voucher_admission_pauses`, which the voucher admission reads (BUG-D1-07).
      VoucherAdmissionPause1759600000005,
      VoucherAdmissionPausePerRequest1759600000006,
      // `redemption_tx_refs`, `redemption_last_error`, `redemption_lapsed_at`,
      // `redemption_replaced_at` and `voucher_resource`, all mapped by
      // `PaymentIntentEntity` (redemption tracking and buyer debt).
      PaymentIntentRedemptionTxRefs1760200000000,
      PaymentIntentRedemptionLastError1760600000000,
      PaymentIntentRedemptionLapsed1760700000000,
      PaymentIntentDebtReplacing1760800000000,
      VoucherSeqDebtReplacement1760900000000,
      // `collectable_at` and `dispute_outcome` (G3.B1), mapped by `PaymentIntentEntity`.
      PaymentIntentDisputeHold1761800000000,
      // `dispute_outcome` (G3.B1), mapped by `VerificationRecordEntity`.
      VerificationRecordDisputeOutcome1761800000001,
      ToolBindingAuthMode1762000000002,
    ],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  await resetSchemaIfMigrationsChanged(dataSource);
  await dataSource.runMigrations();

  const balanceRepository = new AccountBalanceRepository(dataSource);
  const entries = new LedgerEntryRepository(dataSource);
  const journal = new LedgerJournalService(entries, balanceRepository, dataSource);
  const balances = new LedgerBalanceService(balanceRepository, journal);
  const holds = new LedgerHoldService(new LedgerHoldRepository(dataSource), journal, dataSource);
  const ledger = new LedgerService(journal, balances, holds);

  const paymentIntents = new PaymentIntentRepository(dataSource);
  const intents = new PaymentIntentService(
    paymentIntents,
    ledger,
    DISABLED_ESCROW_GATE,
    noBlocks(),
  );
  const records = new VerificationRecordRepository(dataSource);
  const packs = new EvidencePackRepository(dataSource);
  const bodies = new EvidenceBodyRepository(dataSource);

  const sealer = new EvidencePackSealerService(
    packs,
    bodies,
    new VerificationPolicyRepository(dataSource),
    DEFAULT_EVIDENCE_RETENTION,
  );

  const decide = jest.fn();
  const publishJudge = jest.fn().mockResolvedValue(undefined);
  // The SLA window service added a tenth constructor argument and this call site was never
  // updated, which is why every test on this context failed to compile. A
  // recording double rather than the real service: SLA windows are their own
  // suite, and what matters here is that `settle()` gets far enough to post at
  // all — the post is the last thing it does, so a missing one is the signature
  // of an exception thrown before it.
  const postCall = jest.fn().mockResolvedValue(undefined);

  const settlement = new VerificationSettlementService(
    records,
    paymentIntents,
    intents,
    ledger,
    { decide } as unknown as VerificationAggregatorService,
    { publishJudge } as unknown as VerificationJudgePublisher,
    sealer,
    dataSource,
    { secret: 'judge-path-test-secret', budget: DEFAULT_VERIFICATION_BUDGET },
    { postCall },
  );

  const usdc = (atomic: bigint): Money => MoneyUtil.of(atomic, USDC_ASSET, USDC_DECIMALS);

  const context: JudgePathTestContext = {
    dataSource,
    settlement,
    evidence: new EvidencePackService(packs, bodies),
    intents,
    ledger,
    records,
    decide,
    organizationId: randomUUID(),

    async reset() {
      context.organizationId = randomUUID();
      decide.mockReset();
    },

    async close() {
      await dataSource.destroy();
    },

    async callReadyToJudge(input = {}) {
      const priceAtomic = input.priceAtomic ?? 1_000_000n;
      const providerId = input.providerId ?? randomUUID();
      const providerAccount = toAccountId(
        CHAIN_IDS.SOLANA_MAINNET,
        `Provider${randomBytes(8).toString('hex')}`,
      ) as AccountId;
      const agentAccount = toAccountId(
        CHAIN_IDS.SOLANA_MAINNET,
        `Agent${randomBytes(8).toString('hex')}`,
      ) as AccountId;

      await ledger.appendNow({
        organizationId: context.organizationId,
        accountId: agentAccount,
        entryType: LedgerEntryType.DEPOSIT,
        money: usdc(priceAtomic * 10n),
      });

      const intent = await intents.create({
        organizationId: context.organizationId,
        agentId: randomUUID(),
        agentAccount,
        toolId: randomUUID(),
        rail: PaymentRail.RAIL_B_VOUCHER,
        callId: randomUUID(),
        callClass: PaymentIntentCallClass.PAID,
        price: usdc(priceAtomic),
        platformFee: usdc(priceAtomic / 10n),
        requestHash: `sha256:${randomBytes(16).toString('hex')}`,
        chainId: CHAIN_IDS.SOLANA_MAINNET,
        voucherSeq: String(randomInt(1, 2 ** 47)),
      });

      // The real transition table, in the real order: the hold first, then the
      // upstream call, then verification. Skipping a step here would test a
      // state the MCP path cannot produce.
      await intents.secureFunds(context.organizationId, intent.id);
      await intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
      );
      // **On the edge that leaves `PROVIDER_EXECUTING`**, which is where
      // `McpToolCallService.resolveDataResult` writes them and — since the payee fix —
      // where the pair actually is in production. This used to write them one
      // edge earlier with a comment claiming that *was* production; it was not,
      // and the difference is the reason a whole class of defect was invisible
      // here. `chk_payment_intents_paying_states_name_payee` and
      // `chk_payment_intents_settled_names_payee` both bite at `VERIFYING`, so
      // this is also the last edge at which they can be satisfied.
      const verifying = await intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VERIFYING,
        { providerId, providerAccount },
      );

      await settlement.enqueue({
        organizationId: context.organizationId,
        intentId: intent.id,
        toolId: intent.toolId,
        providerId,
        request: { city: 'Paris', days: 3 },
        response: { tempC: 31, summary: 'clear' },
        outputSchema: { type: 'object', required: ['tempC'] },
      });

      return verifying;
    },
  };

  return context;
}
