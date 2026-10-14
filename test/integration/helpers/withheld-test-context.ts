import { VoucherDelegate1759600000000 } from '@database/postgres/migrations/1759600000000-voucher-delegate';
import { VoucherAdmissionIndex1759600000003 } from '@database/postgres/migrations/1759600000003-voucher-admission-index';
import { PaymentIntentCredential1759600000004 } from '@database/postgres/migrations/1759600000004-payment-intent-credential';
import { VoucherAdmissionPause1759600000005 } from '@database/postgres/migrations/1759600000005-voucher-admission-pause';
import { PaymentIntentRedemptionTxRefs1760200000000 } from '@database/postgres/migrations/1760200000000-payment-intent-redemption-tx-refs';
import { VoucherAdmissionPausePerRequest1759600000006 } from '@database/postgres/migrations/1759600000006-voucher-admission-pause-per-request';
import { randomBytes, randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { CreatePaymentIntents1755200000000 } from '@database/postgres/migrations/1755200000000-create-payment-intents';
import { AddVoucherNonce1755300000000 } from '@database/postgres/migrations/1755300000000-add-voucher-nonce';
import { VoucherRedemptionFields1759100000002 } from '@database/postgres/migrations/1759100000002-voucher-redemption-fields';
import { CreateApiSurfaceTables1756000000000 } from '@database/postgres/migrations/1756000000000-create-api-surface-tables';
import { RoutedPaymentIntents1755600000000 } from '@database/postgres/migrations/1755600000000-routed-payment-intents';
import { CallIdAndCallClass1756800000000 } from '@database/postgres/migrations/1756800000000-call-id-and-call-class';
import { CreateToolBindingTables1756900000000 } from '@database/postgres/migrations/1756900000000-create-tool-binding-tables';
import { BindingTrafficControls1757200000000 } from '@database/postgres/migrations/1757200000000-binding-traffic-controls';
import { NotificationsLimitsAndFreeTier1757500000000 } from '@database/postgres/migrations/1757500000000-notifications-limits-and-free-tier';
import { SettledIntentsNamePayee1758100000000 } from '@database/postgres/migrations/1758100000000-settled-intents-name-payee';
import { BuyerEscrowsAndVoucherSeq1759100000000 } from '@database/postgres/migrations/1759100000000-buyer-escrows-and-voucher-seq';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerWriterService } from '@modules/ledger/services/ledger-writer.service';
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  TEST_POOL_SIZE,
  USDC_ASSET,
  USDC_DECIMALS,
  ensureTestDatabase,
  testConnectionOptions,
} from './test-database';
import { noBlocks } from '../../unit/helpers/blocklist';

loadEnv();

export { USDC_ASSET, USDC_DECIMALS };

/**
 * `PaymentIntentService.secureFunds` calls the escrow spend gate
 * before `createHold`. This context is about `withheld`, not the gate —
 * `ESCROW_SPEND_GATE_ENABLED` ships off, and a disabled stub is what that
 * looks like: present, never consulted for a decision.
 */
const DISABLED_ESCROW_GATE = {
  enabled: false,
  assertAffordable: async () => undefined,
} as unknown as EscrowSpendGateService;

/**
 * The harness for the `withheld` invariant.
 *
 * Deliberately **not** built on `createPaymentTestContext`, and the difference
 * is the whole point of the suite it serves. That context drives one intent at a
 * time through a path the test names. This one exists to run several thousand
 * intents down randomly chosen paths and then ask a question about the
 * aggregate — so it needs the migration that made `provider_id` nullable,
 * a pool of funded accounts rather than one, and, above all, an
 * independent way to compute `Σ HOLD_RELEASE`.
 *
 * **`holdReleaseTotal` folds the journal here, in the test, rather than calling
 * the service under test.** A reconciliation whose two sides come from the same
 * code proves that the code is self-consistent, which is not the claim. The
 * claim is that the ledger and the payment records agree, and the only way to
 * check it is to compute each side by a different route and compare.
 */
export interface WithheldTestContext {
  readonly intents: PaymentIntentService;
  readonly ledger: LedgerService;
  readonly repository: PaymentIntentRepository;
  readonly dataSource: DataSource;
  /** Rotated by `reset()` — read it fresh in every test. */
  organizationId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  usdc(atomic: bigint): Money;
  account(label: string): AccountId;
  fund(accountId: AccountId, atomic: bigint): Promise<void>;
  createIntent(input: {
    agentAccount: AccountId;
    toolId: string;
    priceAtomic: bigint;
  }): Promise<PaymentIntent>;
  /** Every intent this organization owns, as rows. */
  allIntents(): Promise<PaymentIntentEntity[]>;
  /**
   * `Σ HOLD_RELEASE` for this organization, folded from the journal.
   *
   * The independent side of the reconciliation. See the interface comment.
   */
  holdReleaseTotal(): Promise<bigint>;
  /**
   * Hold ids whose `HOLD_RELEASE` belongs to no intent that references them.
   *
   * The orphan term of `reconcileWithheld`, computed the slow honest way: read
   * every release, look up its hold, and ask whether the intent that hold names
   * actually points back at it.
   */
  orphanedReleases(): Promise<{ holdIds: string[]; total: bigint }>;
}

export async function createWithheldTestContext(): Promise<WithheldTestContext> {
  const database = await ensureTestDatabase(
    process.env.WITHHELD_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_withheld_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [LedgerEntryEntity, LedgerHoldEntity, AccountBalanceEntity, PaymentIntentEntity],
    migrations: [
      CreateLedger1755100000000,
      CreatePaymentIntents1755200000000,
      AddVoucherNonce1755300000000,
      // The routed-intents migration made `provider_id` nullable and added the two CHECKs that keep
      // the payee columns honest. Without it every intent here would have to
      // name a provider before the router had run, which is not the shape the
      // MCP path produces and therefore not the shape worth reconciling.
      RoutedPaymentIntents1755600000000,
      // `call_id` / `call_class` are `NOT NULL`, so every intent this
      // context creates needs the migration in before the first insert.
      CallIdAndCallClass1756800000000,
      // The traffic-controls migration adds `payment_intents.binding_id`, which
      // `PaymentIntentEntity` maps — and TypeORM names every mapped column in its INSERT and its
      // SELECT, so the column has to exist before the first intent here. The
      // migration also alters `tool_bindings`, hence its CREATE tagging along;
      // no binding is written by this suite.
      CreateToolBindingTables1756900000000,
      BindingTrafficControls1757200000000,
      // The spend-limits migration adds `payment_intents.spend_policy_version`, which
      // `PaymentIntentEntity` maps — so without it every `create()` here failed
      // on a column that does not exist, and this suite had been red since.
      // It alters `spend_policies`, hence the api-surface CREATE tagging along.
      CreateApiSurfaceTables1756000000000,
      NotificationsLimitsAndFreeTier1757500000000,
      // `chk_payment_intents_settled_names_payee`, which this suite's
      // own `VERIFYING` paths must satisfy.
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
      // `payment_intents.redemption_tx_refs`, mapped by `PaymentIntentEntity`.
      PaymentIntentRedemptionTxRefs1760200000000,
    ],
    synchronize: false,
    logging: process.env.WITHHELD_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  const balanceRepository = new AccountBalanceRepository(dataSource);
  const entries = new LedgerEntryRepository(dataSource);
  const journal = new LedgerJournalService(entries, balanceRepository, dataSource);
  const balances = new LedgerBalanceService(balanceRepository, journal);
  const holds = new LedgerHoldService(new LedgerHoldRepository(dataSource), journal, dataSource);
  const ledger = new LedgerService(
    journal,
    new LedgerWriterService(journal, dataSource),
    balances,
    holds,
  );

  const repository = new PaymentIntentRepository(dataSource);
  const intents = new PaymentIntentService(repository, ledger, DISABLED_ESCROW_GATE, noBlocks());

  const context: WithheldTestContext = {
    intents,
    ledger,
    repository,
    dataSource,
    organizationId: randomUUID(),

    async reset(): Promise<void> {
      context.organizationId = randomUUID();
    },

    async close(): Promise<void> {
      await dataSource.destroy();
    },

    usdc(atomic: bigint): Money {
      return MoneyUtil.of(atomic, USDC_ASSET, USDC_DECIMALS);
    },

    account(label: string): AccountId {
      return toAccountId(CHAIN_IDS.SOLANA_MAINNET, label) as AccountId;
    },

    async fund(accountId: AccountId, atomic: bigint): Promise<void> {
      await ledger.appendNow({
        organizationId: context.organizationId,
        accountId,
        entryType: LedgerEntryType.DEPOSIT,
        money: context.usdc(atomic),
      });
    },

    async createIntent(input): Promise<PaymentIntent> {
      const price = context.usdc(input.priceAtomic);
      // A tenth, floored — the same split `McpToolCallService.platformFee`
      // computes, and the one the table's CHECK insists adds back up.
      const platformFee = context.usdc(input.priceAtomic / 10n);

      return intents.create({
        organizationId: context.organizationId,
        agentId: randomUUID(),
        agentAccount: input.agentAccount,
        toolId: input.toolId,
        rail: PaymentRail.RAIL_B_VOUCHER,
        callId: randomUUID(),
        callClass: PaymentIntentCallClass.PAID,
        price,
        platformFee,
        requestHash: `sha256:${randomBytes(16).toString('hex')}`,
        chainId: CHAIN_IDS.SOLANA_MAINNET,
        voucherNonce: randomBytes(16).toString('hex'),
      });
    },

    async allIntents(): Promise<PaymentIntentEntity[]> {
      return repository.findBy({ organizationId: context.organizationId });
    },

    async holdReleaseTotal(): Promise<bigint> {
      const entries = await ledger.readJournal(context.organizationId);
      return entries
        .filter((entry) => entry.entryType === LedgerEntryType.HOLD_RELEASE)
        .reduce((total, entry) => total + MoneyUtil.toAtomic(entry.money), 0n);
    },

    async orphanedReleases(): Promise<{ holdIds: string[]; total: bigint }> {
      const journalEntries = await ledger.readJournal(context.organizationId);
      const releases = journalEntries.filter(
        (entry) => entry.entryType === LedgerEntryType.HOLD_RELEASE,
      );

      const intentRows = await context.allIntents();
      const holdByIntent = new Map(intentRows.map((row) => [row.id, row.holdId]));

      const holdIds: string[] = [];
      let total = 0n;

      for (const release of releases) {
        if (!release.holdId) continue;
        const hold = await ledger.getHold(context.organizationId, release.holdId);
        // The hold names an intent; the intent must name this hold back. When
        // it does not, `secureFunds` opened the hold and then lost the
        // compare-and-swap that would have written `hold_id` — a real release
        // belonging to no withheld intent. See `reconcileWithheld`.
        if (holdByIntent.get(hold.intentId) !== release.holdId) {
          holdIds.push(release.holdId);
          total += MoneyUtil.toAtomic(release.money);
        }
      }

      return { holdIds, total };
    },
  };

  return context;
}
