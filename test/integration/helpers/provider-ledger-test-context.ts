import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderPayoutEntity } from '@database/postgres/entities/provider-payout.entity';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { CreateProviderRegistrationTables1756600000000 } from '@database/postgres/migrations/1756600000000-create-provider-registration-tables';
import { DropConnectivityEgressIps1762000000000 } from '@database/postgres/migrations/1762000000000-drop-connectivity-egress-ips';
import { ProviderEarningsAndPayouts1756700000000 } from '@database/postgres/migrations/1756700000000-provider-earnings-and-payouts';
import { ProviderStakeAuthority1757000000000 } from '@database/postgres/migrations/1757000000000-provider-stake-authority';
import { ProviderStakeAuthorityFormat1757250000000 } from '@database/postgres/migrations/1757250000000-provider-stake-authority-format';
import { CreateProviderChainEnrolments1759300000001 } from '@database/postgres/migrations/1759300000001-create-provider-chain-enrolments';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  LedgerAccountId,
  LedgerEntryType,
  LEGACY_POOLED_VAULT_TX_REF,
  SettlementCredit,
} from '@modules/ledger/ports/ledger.types';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  TEST_POOL_SIZE,
  USDC_ASSET,
  USDC_DECIMALS,
  ensureTestDatabase,
  resetSchemaIfMigrationsChanged,
  testConnectionOptions,
} from './test-database';

loadEnv();

export { USDC_ASSET, USDC_DECIMALS };

/**
 * Real Postgres with the ledger **and** the provider registration schema, for
 * the two suites that need both.
 *
 * ## What this replaces, and what it deliberately does not carry
 *
 * It is the surviving half of `provider-payout-test-context.ts`, which was
 * deleted along with `ProviderPayoutBatchService` itself. Everything
 * about the hourly batch went with it: the fake `VaultPort` and its
 * `buildPayoutBatch`, the surplus buffer that existed only so
 * `proposePayoutBatch`'s reserves check would not refuse a fully-backed batch,
 * the threshold parameters, `TreasuryVaultService` and `ReconciliationService`.
 * A provider now signs `request_earnings_withdraw` and `withdraw_earnings`
 * themselves, so none of it has a caller.
 *
 * What is left is what the two surviving suites actually use: the ledger's
 * settlement-credit write path (`commitHoldAndCredit`) and the `providers`
 * table with the three stake-authority constraints on it.
 *
 * `provider_payouts` is still in the schema. Nothing writes to it any more —
 * the batch was removed — but `GET /providers/me/payouts` still reads
 * it, so the table and its migration stay.
 */
export interface ProviderLedgerTestContext {
  readonly ledger: LedgerService;
  readonly providers: ProviderRepository;
  readonly chainEnrolments: ProviderChainEnrolmentRepository;
  readonly dataSource: DataSource;
  reset(): Promise<void>;
  close(): Promise<void>;
  usdc(atomic: bigint): Money;
  account(label: string): LedgerAccountId;
  /** Funds an agent account directly (a `DEPOSIT`), for setting up a hold to commit. */
  fund(organizationId: string, accountId: LedgerAccountId, atomic: bigint): Promise<void>;
  /**
   * The whole settlement path in one call: opens a hold for the total, commits
   * it with `credit`, and returns the intent id used. Mirrors what
   * `PaymentIntentService.resolve()` does on `SETTLED`, without depending on
   * the payment domain's own tables.
   */
  settleCall(input: {
    agentOrganizationId: string;
    agentAccountId: LedgerAccountId;
    providerOrganizationId: string;
    providerAccountId: LedgerAccountId;
    providerAmount: bigint;
    platformFee: bigint;
  }): Promise<string>;
  /** Registers a minimal, valid `providers` row. */
  registerProvider(input: {
    organizationId: string;
    payoutAccountId?: string | null;
    payoutThresholdOverride?: bigint | null;
  }): Promise<void>;
}

export async function createProviderLedgerTestContext(): Promise<ProviderLedgerTestContext> {
  const database = await ensureTestDatabase(
    process.env.PROVIDER_PAYOUT_TEST_DATABASE ||
      `${process.env.DATABASE_NAME || 'app'}_provider_payout_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [
      LedgerEntryEntity,
      LedgerHoldEntity,
      AccountBalanceEntity,
      ProviderEntity,
      ProviderPayoutEntity,
      ProviderChainEnrolmentEntity,
    ],
    migrations: [
      CreateLedger1755100000000,
      CreateProviderRegistrationTables1756600000000,
      DropConnectivityEgressIps1762000000000,
      ProviderEarningsAndPayouts1756700000000,
      // The stake-authority migration put `stake_authority`, `stake_proof` and `stake_proved_at`
      // on `ProviderEntity`, and TypeORM names every mapped column in its
      // INSERT — so `registerProvider()` below needs the schema that has them.
      ProviderStakeAuthority1757000000000,
      // The format CHECK that makes `uq_providers_stake_authority` mean what it
      // claims. `1759300000003` drops it in production along with the columns —
      // the stake authority moved onto the per-chain enrolment, and
      // `provider-stake-authority-constraints.integration.spec.ts` now asserts
      // the ENROLMENT's three equivalents (created by `1759300000001` below).
      // It stays here because this context also stops one migration short of
      // the payout drop (see the next comment) and dropping only half of that
      // pair would be a third schema nothing in production has.
      ProviderStakeAuthorityFormat1757250000000,
      // Per-chain enrolments. Carried here for `provider-chain-enrolment.integration.spec.ts`,
      // whose subject is this migration's constraints and its backfill — both
      // invisible to `test/unit`, which never runs a migration.
      //
      // `1759300000002-drop-provider-payout-columns` is deliberately NOT here,
      // because the spec above tests the BACKFILL, which reads
      // `providers.payout_account_id`: a schema that had already dropped it
      // would have nothing to backfill from and the tests would pass by testing
      // an empty SELECT. `registerProvider()` below therefore writes those
      // three columns by raw SQL, because `ProviderEntity` no longer maps them.
      //
      // **The cost, stated rather than glossed:** three suites share this
      // context, and only one of them is about the backfill. `ledger-settlement-
      // credit.integration.spec.ts` and `provider-stake-authority-constraints.
      // integration.spec.ts` therefore run against a `providers` table
      // production no longer has. That is harmless *today* — `ProviderEntity`
      // stopped mapping the three columns, so TypeORM never names them, and
      // neither suite touches them — but it is a divergence, and the day one of
      // those two starts asserting on `providers`' shape it will be asserting
      // on a shape that does not exist. The fix at that point is to split the
      // backfill spec onto its own context, not to widen this comment.
      //
      // `1759300000003-drop-provider-stake-authority-columns` is absent for the
      // same reason and with the same cost: `providers.stake_authority` still
      // exists here and no longer exists in production. Nothing reads it —
      // `ProviderEntity` stopped mapping it — and the constraints spec was
      // re-aimed at the enrolment, so the divergence is inert today.
      CreateProviderChainEnrolments1759300000001,
    ],
    synchronize: false,
    logging: process.env.PROVIDER_PAYOUT_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  await resetSchemaIfMigrationsChanged(dataSource);
  await dataSource.runMigrations();

  const entryRepository = new LedgerEntryRepository(dataSource);
  const holdRepository = new LedgerHoldRepository(dataSource);
  const balanceRepository = new AccountBalanceRepository(dataSource);
  const providerRepository = new ProviderRepository(dataSource);
  const chainEnrolmentRepository = new ProviderChainEnrolmentRepository(dataSource);

  const journal = new LedgerJournalService(entryRepository, balanceRepository, dataSource);
  const balances = new LedgerBalanceService(balanceRepository, journal);
  const holds = new LedgerHoldService(holdRepository, journal, dataSource);
  const ledger = new LedgerService(journal, balances, holds);

  const context: ProviderLedgerTestContext = {
    ledger,
    providers: providerRepository,
    chainEnrolments: chainEnrolmentRepository,
    dataSource,

    async reset(): Promise<void> {
      await dataSource.query('DELETE FROM provider_chain_enrolments');
      await dataSource.query('DELETE FROM provider_payouts');
      await dataSource.query('DELETE FROM providers');
      await dataSource.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await dataSource.query('DELETE FROM ledger_entries');
      await dataSource.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
      await dataSource.query('DELETE FROM ledger_holds');
      await dataSource.query('DELETE FROM account_balances');
    },

    async close(): Promise<void> {
      await dataSource.destroy();
    },

    usdc(atomic: bigint): Money {
      return MoneyUtil.of(atomic, USDC_ASSET, USDC_DECIMALS);
    },

    account(label: string): LedgerAccountId {
      return toAccountId(CHAIN_IDS.SOLANA_MAINNET, label) as AccountId;
    },

    async fund(organizationId, accountId, atomic): Promise<void> {
      await ledger.appendNow({
        organizationId,
        accountId,
        entryType: LedgerEntryType.DEPOSIT,
        money: context.usdc(atomic),
      });
    },

    async settleCall(input): Promise<string> {
      const intentId = randomUUID();
      const total = input.providerAmount + input.platformFee;

      const hold = await ledger.createHold({
        organizationId: input.agentOrganizationId,
        accountId: input.agentAccountId,
        money: context.usdc(total),
        intentId,
      });

      const credit: SettlementCredit = {
        providerOrganizationId: input.providerOrganizationId,
        providerAccountId: input.providerAccountId,
        providerAmount: context.usdc(input.providerAmount),
        platformFee: context.usdc(input.platformFee),
        intentId,
        // This helper settles the legacy pooled-vault rail, which
        // moves nothing on chain.
        chainTxRef: LEGACY_POOLED_VAULT_TX_REF,
      };

      await ledger.commitHoldAndCredit(input.agentOrganizationId, hold.id, credit);
      return intentId;
    },

    async registerProvider(input): Promise<void> {
      await providerRepository.insert({
        id: randomUUID(),
        organizationId: input.organizationId,
        legalName: `Test Provider ${input.organizationId}`,
        technicalContact: {
          name: 'Tech Contact',
          email: `tech-${input.organizationId}@example.com`,
        },
        ownerContact: { name: 'Owner Contact', email: `owner-${input.organizationId}@example.com` },
        timezone: 'UTC',
        acceptedTerms: {
          providerAgreementVersion: 'v1',
          payoutTermsVersion: 'v1',
          slashPolicyVersion: 'v1',
          acceptedAt: new Date().toISOString(),
          acceptedBy: 'test-credential',
        },
        payoutThresholdOverride:
          input.payoutThresholdOverride != null ? input.payoutThresholdOverride.toString() : null,
      });

      // The three payout columns are NOT on `ProviderEntity` any more — the
      // address moved onto `provider_chain_enrolments` and
      // `1759300000002` dropped them. This context deliberately stops one
      // migration short of that drop, because the spec that runs on it is
      // `provider-chain-enrolment.integration.spec.ts` and its subject is the
      // BACKFILL: a schema with no source columns has nothing to backfill from.
      // So the columns are still here and are written by raw SQL, which is the
      // only way left to reach a column the entity no longer maps.
      if (input.payoutAccountId != null) {
        await dataSource.query(
          `UPDATE providers
              SET payout_account_id = $2, payout_proof = $3, payout_proved_at = now()
            WHERE organization_id = $1`,
          [
            input.organizationId,
            input.payoutAccountId,
            JSON.stringify({
              challengeId: randomUUID(),
              signature: 'test-signature',
              messageVersion: 'x402-payout-proof/v1',
              provedAt: new Date().toISOString(),
            }),
          ],
        );
      }
    },
  };

  return context;
}
