import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { StakeSnapshotEntity } from '@database/postgres/entities/stake-snapshot.entity';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { CreateReconciliationRuns1755500000000 } from '@database/postgres/migrations/1755500000000-create-reconciliation-runs';
import { PublicReserves1758300000000 } from '@database/postgres/migrations/1758300000000-public-reserves';
import { SlashDistributionIdempotency1758000000000 } from '@database/postgres/migrations/1758000000000-slash-distribution-idempotency';
import { EscrowReconciliationColumns1759100000001 } from '@database/postgres/migrations/1759100000001-escrow-reconciliation-columns';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { VaultPort } from '@modules/chains/ports/vault.port';
import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { EscrowBalanceReaderPort } from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';
import { Alert, AlertPort } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  TEST_POOL_SIZE,
  USDC_ASSET,
  USDC_DECIMALS,
  ensureTestDatabase,
  testConnectionOptions,
} from './test-database';

loadEnv();

export { USDC_ASSET, USDC_DECIMALS };

/** Captures alerts so a test can assert on the exact text on-call would see. */
export class RecordingAlertSink implements AlertPort {
  readonly emitted: Alert[] = [];

  emit(alert: Alert): Promise<void> {
    this.emitted.push(alert);
    return Promise.resolve();
  }

  clear(): void {
    this.emitted.length = 0;
  }
}

/**
 * What a caller may swap out.
 *
 * Added so `reconciliation-evm.integration.spec.ts` can run the SAME
 * reconciler, over the same real Postgres, against the real
 * `NamespaceVaultPort` + `EvmVaultService` — rather than growing a second copy
 * of this file's entity list, migration list and reset order, which is where
 * the two would silently drift apart.
 */
export interface SettlementTestContextOptions {
  /** A separate database, so two suites cannot see each other's rows. */
  readonly database?: string;
  /**
   * Replaces the built-in fake vault. {@link SettlementTestContext.setVaultBalance}
   * then **throws**: a test that set a balance nothing read would be inert, and
   * inert is the failure mode this repository has nineteen of.
   */
  readonly vault?: VaultPort;
}

export interface SettlementTestContext {
  readonly reconciliation: ReconciliationService;
  readonly ledger: LedgerService;
  readonly runs: ReconciliationRunRepository;
  readonly alerts: RecordingAlertSink;
  readonly dataSource: DataSource;
  /** Rotated by `reset()`; read fresh in every test. */
  organizationId: string;
  /** What the fake chain reports the vault holds. Set per test. */
  setVaultBalance(atomic: bigint): void;
  reset(): Promise<void>;
  close(): Promise<void>;
  fund(accountId: LedgerAccountId, atomic: bigint): Promise<void>;
  usdc(atomic: bigint): Money;
  account(label: string): LedgerAccountId;
  /**
   * Writes a journal row **behind the ledger's back** — raw SQL, no balance
   * update, no service involved.
   *
   * This is how a test forges a discrepancy honestly. Going through
   * `LedgerService` would update the snapshot too and the books would still
   * agree; the interesting failure is precisely the one that does not announce
   * itself.
   */
  forgeJournalEntry(input: {
    accountId: LedgerAccountId;
    entryType: LedgerEntryType;
    atomic: bigint;
  }): Promise<void>;
}

/**
 * Boots a real Postgres with the ledger and reconciliation schemas.
 *
 * The chain is the one thing faked: reading a real vault balance would make
 * these specs depend on devnet, an RPC and a funded account. Everything the
 * reconciler *concludes* from that number — the fold, the two comparisons, the
 * severity, the persisted row, the alert — runs for real, against real SQL.
 */
export async function createSettlementTestContext(
  options: SettlementTestContextOptions = {},
): Promise<SettlementTestContext> {
  const database = await ensureTestDatabase(
    options.database ||
      process.env.SETTLEMENT_TEST_DATABASE ||
      `${process.env.DATABASE_NAME || 'app'}_settlement_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [
      LedgerEntryEntity,
      LedgerHoldEntity,
      AccountBalanceEntity,
      ReconciliationRunEntity,
      // The proof-of-reserves fleet stake snapshot. The migration below already creates the
      // table; without the entity registered here, any repository reading it
      // over this DataSource fails on an unknown entity rather than on a
      // missing row.
      StakeSnapshotEntity,
    ],
    migrations: [
      CreateLedger1755100000000,
      CreateReconciliationRuns1755500000000,
      // `vault_slot` on the run rows. Without it the entity selects a column
      // the test schema does not have, and every read of a run row errors.
      PublicReserves1758300000000,
      // The slash-distribution idempotency index. Included so the constraint is really present
      // when a test asserts a duplicate is refused — a suite that asserted it
      // against a schema without the index would pass by writing the duplicate.
      SlashDistributionIdempotency1758000000000,
      // `reconciliation_runs` gains the escrow and earnings
      // columns the reconciler now writes on every pass, including a clean one.
      EscrowReconciliationColumns1759100000001,
    ],
    synchronize: false,
    logging: process.env.SETTLEMENT_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  const entryRepository = new LedgerEntryRepository(dataSource);
  const holdRepository = new LedgerHoldRepository(dataSource);
  const balanceRepository = new AccountBalanceRepository(dataSource);
  const runRepository = new ReconciliationRunRepository(dataSource);

  const journal = new LedgerJournalService(entryRepository, balanceRepository, dataSource);
  const balances = new LedgerBalanceService(balanceRepository, journal);
  const holds = new LedgerHoldService(holdRepository, journal, dataSource);
  const ledger = new LedgerService(journal, balances, holds);

  let vaultBalance = 0n;
  const vaultAccount: AccountId = toAccountId(
    CHAIN_IDS.SOLANA_MAINNET,
    'Vau1t1111111111111111111111111111111111111',
  );

  const fakeVault: VaultPort = {
    getVaultOwner: () => Promise.resolve(vaultAccount),
    getVaultAccount: () => Promise.resolve(vaultAccount),
    getVaultBalance: () => Promise.resolve(MoneyUtil.of(vaultBalance, USDC_ASSET, USDC_DECIMALS)),
    getVaultBalanceAt: () =>
      Promise.resolve({
        balance: MoneyUtil.of(vaultBalance, USDC_ASSET, USDC_DECIMALS),
        slot: 1n,
      }),
    assertVaultControl: () => Promise.resolve(),
  };

  const vault = options.vault ?? fakeVault;

  /**
   * The three chain-side dependencies the reconciler gained with per-buyer escrows.
   *
   * All three are inert here on purpose: these specs prove the pooled-vault
   * inequality and the freeze against **real Postgres**, and the escrow and
   * earnings checks are pinned unit-side in
   * `test/unit/settlement/reconciliation.service.spec.ts` against fakes that can
   * state a per-buyer shortfall in one line. An empty `buyer_escrows` walk and
   * an earnings vault holding more than anything could owe keep those two checks
   * silent, so what these specs assert stays what they were written to assert.
   */
  const escrowReader: EscrowBalanceReaderPort = {
    read: () => Promise.resolve(null),
    readMany: () => Promise.resolve(new Map()),
    escrowAddresses: () =>
      Promise.resolve({
        escrowPda: vaultAccount,
        escrowTokenAccount: vaultAccount,
      }),
  };

  /**
   * `buyer_escrows` is not in this harness's schema — its migration also alters
   * `payment_intents`, which these specs do not create — so the walk is a fake
   * that reports no escrows. That is the honest state for a suite about the
   * pooled vault, and it is the state a deployment is in before the cutover.
   */
  const escrowRepository = {
    listAll: () => Promise.resolve([]),
    bumpNextSeqTo: () => Promise.resolve(0),
  } as unknown as BuyerEscrowRepository;

  const alerts = new RecordingAlertSink();
  const reconciliation = new ReconciliationService(
    vault,
    alerts,
    entryRepository,
    balanceRepository,
    runRepository,
    escrowReader,
    escrowRepository,
  );

  const context: SettlementTestContext = {
    reconciliation,
    ledger,
    runs: runRepository,
    alerts,
    dataSource,
    organizationId: randomUUID(),

    setVaultBalance(atomic: bigint): void {
      if (options.vault) {
        throw new Error(
          'setVaultBalance has no effect when a vault was supplied — set the balance on the ' +
            'supplied vault instead, or this test asserts against a number nothing read',
        );
      }
      vaultBalance = atomic;
    },

    async reset(): Promise<void> {
      // The reconciler sums **across every organization**, so a fresh
      // organization id is not isolation here the way it is for the ledger
      // suites — a previous test's rows would still be in the total. The
      // journal refuses DELETE by design, so isolation comes from a fresh
      // *asset* scope instead: every test runs against a clean database.
      await dataSource.query('DELETE FROM reconciliation_runs');
      await dataSource.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await dataSource.query('DELETE FROM ledger_entries');
      await dataSource.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
      await dataSource.query('DELETE FROM ledger_holds');
      await dataSource.query('DELETE FROM account_balances');
      alerts.clear();
      vaultBalance = 0n;
      context.organizationId = randomUUID();
    },

    async close(): Promise<void> {
      await dataSource.destroy();
    },

    async fund(accountId: LedgerAccountId, atomic: bigint): Promise<void> {
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

    account(label: string): LedgerAccountId {
      return toAccountId(CHAIN_IDS.SOLANA_MAINNET, label) as AccountId;
    },

    async forgeJournalEntry(input): Promise<void> {
      await dataSource.query(
        `INSERT INTO ledger_entries
           (organization_id, account_id, entry_type, amount, asset_id, decimals)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          context.organizationId,
          input.accountId,
          input.entryType,
          input.atomic.toString(),
          USDC_ASSET,
          USDC_DECIMALS,
        ],
      );
    },
  };

  return context;
}
