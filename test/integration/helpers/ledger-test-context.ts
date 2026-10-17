import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
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
  testConnectionOptions,
  uuidFromLabel,
} from './test-database';

loadEnv();

export { USDC_ASSET, USDC_DECIMALS };

export interface LedgerTestContext {
  readonly ledger: LedgerService;
  readonly dataSource: DataSource;
  /** Rotated by `reset()`; read it fresh in every test. */
  organizationId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  fund(accountId: LedgerAccountId, atomic: bigint): Promise<void>;
  usdc(atomic: bigint): Money;
  account(label: string): LedgerAccountId;
  /** Deterministic uuid for a readable label — `intent_id` is a uuid column. */
  intent(label: string): string;
}

/**
 * Boots a real Postgres against the real migration.
 *
 * There is no in-memory substitute here on purpose. Two of the guarantees under
 * test — `SELECT … FOR UPDATE` serialising two holds, and a trigger refusing an
 * `UPDATE` on the journal — are properties of Postgres, not of this code. A
 * fake would pass the tests and prove nothing.
 */
export async function createLedgerTestContext(): Promise<LedgerTestContext> {
  const database = await ensureTestDatabase(
    process.env.LEDGER_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_ledger_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [LedgerEntryEntity, LedgerHoldEntity, AccountBalanceEntity],
    migrations: [CreateLedger1755100000000],
    synchronize: false,
    logging: process.env.LEDGER_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  // Idempotent — the migrations table makes a second run a no-op. Nothing is
  // ever truncated between tests: `ledger_entries` refuses DELETE and TRUNCATE
  // by design, and a fresh `organizationId` per test isolates far better than
  // a cleanup step that the schema is built to prevent.
  await dataSource.runMigrations();

  const entryRepository = new LedgerEntryRepository(dataSource);
  const holdRepository = new LedgerHoldRepository(dataSource);
  const balanceRepository = new AccountBalanceRepository(dataSource);

  const journal = new LedgerJournalService(entryRepository, balanceRepository, dataSource);
  const balances = new LedgerBalanceService(balanceRepository, journal);
  const holds = new LedgerHoldService(holdRepository, journal, dataSource);
  const ledger = new LedgerService(journal, balances, holds);

  const context: LedgerTestContext = {
    ledger,
    dataSource,
    organizationId: randomUUID(),

    async reset(): Promise<void> {
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

    intent(label: string): string {
      return uuidFromLabel(label);
    },
  };

  return context;
}
