import { VoucherDelegate1759600000000 } from '@database/postgres/migrations/1759600000000-voucher-delegate';
import { VoucherAdmissionIndex1759600000003 } from '@database/postgres/migrations/1759600000003-voucher-admission-index';
import { PaymentIntentCredential1759600000004 } from '@database/postgres/migrations/1759600000004-payment-intent-credential';
import { randomBytes, randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { BuyerEscrowEntity } from '@database/postgres/entities/buyer-escrow.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { CreatePaymentIntents1755200000000 } from '@database/postgres/migrations/1755200000000-create-payment-intents';
import { AddVoucherNonce1755300000000 } from '@database/postgres/migrations/1755300000000-add-voucher-nonce';
import { VoucherRedemptionFields1759100000002 } from '@database/postgres/migrations/1759100000002-voucher-redemption-fields';
import { RoutedPaymentIntents1755600000000 } from '@database/postgres/migrations/1755600000000-routed-payment-intents';
import { TimestamptzTimestamps1755900000000 } from '@database/postgres/migrations/1755900000000-timestamptz-timestamps';
import { CreateApiSurfaceTables1756000000000 } from '@database/postgres/migrations/1756000000000-create-api-surface-tables';
import { CreateProviderRegistrationTables1756600000000 } from '@database/postgres/migrations/1756600000000-create-provider-registration-tables';
import { ProviderEarningsAndPayouts1756700000000 } from '@database/postgres/migrations/1756700000000-provider-earnings-and-payouts';
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
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerWriterService } from '@modules/ledger/services/ledger-writer.service';
import {
  CreatePaymentIntentInput,
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentExpiryService } from '@modules/payment/services/payment-intent-expiry.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  TEST_POOL_SIZE,
  USDC_ASSET,
  USDC_DECIMALS,
  ensureTestDatabase,
  testConnectionOptions,
  uuidFromLabel,
  BuyerEscrowAccountColumnsSlice1759300000000,
} from './test-database';

loadEnv();

export { USDC_ASSET, USDC_DECIMALS };

export const SOLANA_MAINNET: ChainId = CHAIN_IDS.SOLANA_MAINNET;

/**
 * `PaymentIntentService.secureFunds` calls the escrow spend gate
 * before `createHold`. This context is the general-purpose payment-intent
 * harness, not the gate's own — `ESCROW_SPEND_GATE_ENABLED` ships off, and a
 * disabled stub is what that looks like: present, never consulted for a
 * decision.
 */
const DISABLED_ESCROW_GATE = {
  enabled: false,
  assertAffordable: async () => undefined,
} as unknown as EscrowSpendGateService;

/** What a test overrides on the way to `createIntent`; everything else is filled in. */
export type IntentOverrides = Partial<Omit<CreatePaymentIntentInput, 'organizationId'>>;

export interface PaymentTestContext {
  readonly intents: PaymentIntentService;
  readonly expiry: PaymentIntentExpiryService;
  readonly ledger: LedgerService;
  readonly repository: PaymentIntentRepository;
  readonly dataSource: DataSource;
  /** Rotated by `reset()`; read it fresh in every test. */
  organizationId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  fund(accountId: AccountId, atomic: bigint): Promise<void>;
  usdc(atomic: bigint): Money;
  account(label: string): AccountId;
  /** Deterministic uuid for a readable label — the id columns are `uuid`. */
  id(label: string): string;
  createIntent(label: string, overrides?: IntentOverrides): Promise<PaymentIntent>;
  /** `available` on the agent's USDC balance, as atomic units. */
  available(accountId: AccountId): Promise<bigint>;
  held(accountId: AccountId): Promise<bigint>;
}

/**
 * Boots a real Postgres against the real migrations — both of them, because the
 * thing under test spans the boundary: an intent expires, and a *ledger* hold is
 * what has to come back.
 *
 * There is no in-memory substitute here on purpose. Three of the guarantees
 * under test — a partial unique index arbitrating two simultaneous inserts, a
 * compare-and-swap update reporting zero affected rows, and `SELECT … FOR
 * UPDATE` serialising two hold resolutions — are properties of Postgres, not of
 * this code. A fake would pass and prove nothing.
 */
export async function createPaymentTestContext(): Promise<PaymentTestContext> {
  const database = await ensureTestDatabase(
    process.env.PAYMENT_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_payment_test`,
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
      BuyerEscrowEntity,
    ],
    migrations: [
      CreateLedger1755100000000,
      CreatePaymentIntents1755200000000,
      AddVoucherNonce1755300000000,
      // This context used to run WITHOUT it, and the omission hid a
      // defect. `provider_id` and `provider_account` stayed `NOT NULL` here
      // while production had dropped both, so an intent with no payee could not
      // even be inserted and `resolve()`'s COMMIT guard was unreachable from
      // this harness. `withheld-test-context.ts` and `judge-path-test-context.ts`
      // have always included it; this one is now consistent with them.
      RoutedPaymentIntents1755600000000,
      // `call_id` / `call_class` are `NOT NULL`, so every intent this
      // context creates needs the migration in before the first insert.
      CallIdAndCallClass1756800000000,
      // Without this, `created_at` stays `timestamp WITHOUT time zone` here
      // while production has `timestamptz` — and the driver then reads every
      // row back shifted by the host's offset. Any test that windows on
      // `created_at` with a wall-clock bound (the per-call export does exactly
      // that) silently matches nothing on a non-UTC host, for a reason that
      // exists only in this harness. See `abstract.entity.ts`'s header.
      TimestamptzTimestamps1755900000000,
      // The earnings-ledger migration adds a column to `providers`, so its own table has to exist.
      CreateApiSurfaceTables1756000000000,
      CreateProviderRegistrationTables1756600000000,
      // The partial unique index behind `commitHoldAndCredit`'s
      // idempotency. `PaymentIntentService.resolve()` now takes that path on
      // the COMMIT edge, so a context that omits this migration would exercise
      // the credit write without the guard that makes it safe.
      ProviderEarningsAndPayouts1756700000000,
      // The traffic-controls migration adds `payment_intents.binding_id`, which
      // `PaymentIntentEntity` maps — and TypeORM names every mapped column in its INSERT and its
      // SELECT, so the column has to exist before the first intent here. The
      // migration also alters `tool_bindings`, hence its CREATE tagging along;
      // no binding is written by this suite.
      CreateToolBindingTables1756900000000,
      BindingTrafficControls1757200000000,
      // The spend-limits migration adds `payment_intents.spend_policy_version`, which
      // `PaymentIntentEntity` maps — and TypeORM names every mapped column in
      // its INSERT, so without this every `create()` in this context failed on
      // a column that does not exist. It had been red for that
      // reason alone. It alters `spend_policies`, hence the api-surface CREATE
      // above tagging along; no policy row is written by this suite.
      NotificationsLimitsAndFreeTier1757500000000,
      // `chk_payment_intents_settled_names_payee`. The whole point of a
      // Postgres-backed context: a `NOT VALID` CHECK is a property of the
      // database and no in-memory fake can refuse on it.
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
      BuyerEscrowAccountColumnsSlice1759300000000,
      // `payment_intents.voucher_delegate`, which `PaymentIntentEntity` maps
      // (agent payment delegation).
      VoucherDelegate1759600000000,
      VoucherAdmissionIndex1759600000003,
      PaymentIntentCredential1759600000004,
    ],
    synchronize: false,
    logging: process.env.PAYMENT_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  // Idempotent — the migrations table makes a second run a no-op. Nothing is
  // truncated between tests: `ledger_entries` refuses DELETE and TRUNCATE by
  // design, and a fresh `organizationId` per test isolates better than a
  // cleanup step the schema is built to prevent.
  await dataSource.runMigrations();

  const balanceRepository = new AccountBalanceRepository(dataSource);
  const journal = new LedgerJournalService(
    new LedgerEntryRepository(dataSource),
    balanceRepository,
    dataSource,
  );
  const balances = new LedgerBalanceService(balanceRepository, journal);
  const holds = new LedgerHoldService(new LedgerHoldRepository(dataSource), journal, dataSource);
  const ledger = new LedgerService(
    journal,
    new LedgerWriterService(journal, dataSource),
    balances,
    holds,
  );

  const repository = new PaymentIntentRepository(dataSource);
  const intents = new PaymentIntentService(repository, ledger, DISABLED_ESCROW_GATE);
  const expiry = new PaymentIntentExpiryService(repository, intents);

  const context: PaymentTestContext = {
    intents,
    expiry,
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

    async fund(accountId: AccountId, atomic: bigint): Promise<void> {
      await ledger.appendNow({
        organizationId: context.organizationId,
        accountId,
        entryType: LedgerEntryType.DEPOSIT,
        money: context.usdc(atomic),
      });
    },

    usdc(atomic: bigint): Money {
      return MoneyUtil.of(atomic, USDC_ASSET, USDC_DECIMALS);
    },

    account(label: string): AccountId {
      return toAccountId(CHAIN_IDS.SOLANA_MAINNET, label) as AccountId;
    },

    id(label: string): string {
      return uuidFromLabel(label);
    },

    async createIntent(label: string, overrides: IntentOverrides = {}): Promise<PaymentIntent> {
      // 1.000000 USDC, 10% of which is the platform's — the split the CHECK
      // constraint on the table insists adds back up to the price.
      const price = context.usdc(1_000_000n);
      const platformFee = context.usdc(100_000n);

      return intents.create({
        organizationId: context.organizationId,
        agentId: context.id(`${label}:agent`),
        agentAccount: context.account(`${label}-agent`),
        providerId: context.id(`${label}:provider`),
        providerAccount: context.account(`${label}-provider`),
        toolId: context.id(`${label}:tool`),
        rail: PaymentRail.RAIL_B_VOUCHER,
        // Random, not derived from `label` — like `voucherNonce` below,
        // `call_id` carries a real `UNIQUE` index, and `label` is reused
        // across tests (each gets its own `organizationId` from `reset()`,
        // but `call_id` is deliberately *not* scoped to it — see the
        // migration's doc comment).
        callId: randomUUID(),
        callClass: PaymentIntentCallClass.PAID,
        price,
        platformFee,
        requestHash: `sha256:${label}`,
        chainId: SOLANA_MAINNET,
        // `chk_payment_intents_voucher_nonce_rail` refuses a rail-B intent with
        // no nonce, so one is minted per call. Random rather than derived from
        // `label`: two intents in one test share a label on purpose, and the
        // nonce is the one thing about them that must never be shared.
        voucherNonce: randomBytes(16).toString('hex'),
        ...overrides,
      });
    },

    async available(accountId: AccountId): Promise<bigint> {
      const balance = await ledger.getBalance(context.organizationId, accountId, USDC_ASSET);
      return MoneyUtil.toAtomic(balance.available);
    },

    async held(accountId: AccountId): Promise<bigint> {
      const balance = await ledger.getBalance(context.organizationId, accountId, USDC_ASSET);
      return MoneyUtil.toAtomic(balance.held);
    },
  };

  return context;
}
