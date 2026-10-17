import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { DepositIntentEntity } from '@database/postgres/entities/deposit-intent.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { CreateDepositIntents1755400000000 } from '@database/postgres/migrations/1755400000000-create-deposit-intents';
import { TimestamptzTimestamps1755900000000 } from '@database/postgres/migrations/1755900000000-timestamptz-timestamps';
import { DepositFinalityResolution1758100000001 } from '@database/postgres/migrations/1758100000001-deposit-finality-resolution';
import { DepositResolutionUniqueness1758200000000 } from '@database/postgres/migrations/1758200000000-deposit-resolution-uniqueness';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { FacilitatorPort } from '@modules/chains/ports/facilitator.port';
import { VaultPort } from '@modules/chains/ports/vault.port';
import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { BuyerEscrowEntity } from '@database/postgres/entities/buyer-escrow.entity';
import { EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';
import {
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { AccountId, AssetId, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { DepositFinalityService } from '@modules/payment/services/deposit-finality.service';
import { DepositIntentExpiryService } from '@modules/payment/services/deposit-intent-expiry.service';
import { DepositIntentService } from '@modules/payment/services/deposit-intent.service';
import { DepositService } from '@modules/payment/services/deposit.service';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  TEST_POOL_SIZE,
  USDC_DECIMALS,
  ensureTestDatabase,
  testConnectionOptions,
  uuidFromLabel,
} from './test-database';

loadEnv();

export { USDC_DECIMALS };

/** Deposits in this context settle on devnet — `USDC_ASSET` elsewhere in the test suite is mainnet's. */
export const USDC_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;

/** A `ChainAdapter` whose x402-shaped methods are jest mocks a test configures per case. */
export function fakeAdapter(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    namespace: 'solana' as ChainAdapter['namespace'],
    supportedChains: [],
    requiresFeePayer: true, // Solana's answer — see `unit/payment/helpers/deposit-harness.ts`.
    isValidAddress: jest.fn(),
    toAccountId: jest.fn(),
    parseAccountId: jest.fn(),
    buildPaymentRequirements: jest.fn().mockResolvedValue({
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      amount: '1000000',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      payTo: 'VaultAtaAddress1111111111111111111111111111',
      resource: 'deposit:test',
      maxTimeoutSeconds: 60,
      extra: {},
    }),
    assertPayloadBoundToIntent: jest.fn(),
    extractSettledAmount: jest.fn(),
    observeTransfer: jest.fn(),
    buildVoucherMessage: jest.fn(),
    verifyVoucherSignature: jest.fn(),
    voucherResourceHash: jest.fn(),
    getVaultAccount: jest.fn(),
    getVaultBalance: jest.fn(),
    buildPayoutProofMessage: jest.fn(),
    payoutProofTypedData: jest.fn().mockReturnValue(null),
    verifyPayoutProofSignature: jest.fn(),
    buildStakeAuthorityMessage: jest.fn(),
    stakeAuthorityTypedData: jest.fn().mockReturnValue(null),
    verifyStakeAuthoritySignature: jest.fn(),
    ...overrides,
  };
}

export interface DepositTestContext {
  readonly deposits: DepositIntentService;
  readonly depositService: DepositService;
  readonly expiry: DepositIntentExpiryService;
  readonly finality: DepositFinalityService;
  readonly ledger: LedgerService;
  readonly repository: DepositIntentRepository;
  readonly dataSource: DataSource;
  readonly adapter: ChainAdapter;
  readonly facilitator: FacilitatorPort;
  /**
   * Kept on the context although nothing in the deposit path calls it any more:
   * every deposit is pointed at the buyer's own escrow, so the pooled
   * Squads vault is no longer a dependency of `DepositService`. Still exposed so
   * a test that wants to assert the vault was NOT touched has something to
   * assert against.
   */
  readonly vault: VaultPort;
  /** The escrow the deposit is pointed at, opened by the platform. */
  readonly opener: EscrowOpenerPort;
  readonly escrowReader: EscrowBalanceReaderPort;
  readonly escrows: BuyerEscrowRepository;
  organizationId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  usdc(atomic: bigint): Money;
  account(label: string): AccountId;
  id(label: string): string;
  available(accountId: AccountId): Promise<bigint>;
  pending(accountId: AccountId): Promise<bigint>;
}

const SOLANA_DEVNET: ChainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as ChainId;

/**
 * Boots a real Postgres against the ledger + deposit-intent migrations.
 *
 * `ChainAdapter`, `FacilitatorPort` and `VaultPort` are fakes a test
 * configures per case — the SVM-specific logic they stand in for
 * (`assertPayloadBoundToIntent`, `extractSettledAmount`, memo parsing) is
 * already exercised against real transaction bytes in
 * `test/unit/chains/solana-chain.adapter.spec.ts`. What this context proves
 * is the part that needs real Postgres: the deposit-intent state machine's
 * compare-and-swap, and the ledger credit landing durably in the same
 * database.
 */
export async function createDepositTestContext(): Promise<DepositTestContext> {
  const database = await ensureTestDatabase(
    process.env.DEPOSIT_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_deposit_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [LedgerEntryEntity, LedgerHoldEntity, AccountBalanceEntity, DepositIntentEntity],
    // `TimestamptzTimestamps1755900000000` is not optional here even though it
    // touches no deposit logic: without it this harness runs `created_at` /
    // `updated_at` as naive `timestamp`, which production no longer does.
    // A backfill or a range query that reads correct here and wrong in
    // production is worse than no coverage — and that is exactly what happened
    // when `DepositFinalityResolution1758100000001` copied
    // `ledger_entries.created_at` into a `timestamptz` column: Postgres
    // resolved the naive source in the session time zone and the value landed
    // off by the host's offset, on this harness only. The migration is guarded
    // by `to_regclass`, so the tables it lists that do not exist here are
    // skipped.
    migrations: [
      CreateLedger1755100000000,
      CreateDepositIntents1755400000000,
      TimestamptzTimestamps1755900000000,
      DepositFinalityResolution1758100000001,
      DepositResolutionUniqueness1758200000000,
    ],
    synchronize: false,
    logging: process.env.DEPOSIT_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  const balanceRepository = new AccountBalanceRepository(dataSource);
  const journal = new LedgerJournalService(
    new LedgerEntryRepository(dataSource),
    balanceRepository,
    dataSource,
  );
  const balances = new LedgerBalanceService(balanceRepository, journal);
  const holds = new LedgerHoldService(new LedgerHoldRepository(dataSource), journal, dataSource);
  const ledger = new LedgerService(journal, balances, holds);

  const repository = new DepositIntentRepository(dataSource);
  const deposits = new DepositIntentService(repository);
  const expiry = new DepositIntentExpiryService(repository, deposits);

  const adapter = fakeAdapter();
  const registry = {
    resolve: jest.fn().mockReturnValue(adapter),
  } as unknown as ChainAdapterRegistry;
  const facilitator: FacilitatorPort = {
    name: 'fake',
    supports: jest.fn().mockResolvedValue(true),
    verify: jest.fn().mockResolvedValue({ isValid: true }),
    settle: jest.fn(),
    getFeePayer: jest
      .fn()
      .mockResolvedValue(toAccountId(SOLANA_DEVNET, 'FeePayer111111111111111111111111111111111')),
  };
  const vault: VaultPort = {
    getVaultOwner: jest
      .fn()
      .mockResolvedValue(toAccountId(SOLANA_DEVNET, 'VaultOwner11111111111111111111111111111111')),
    getVaultAccount: jest.fn(),
    getVaultBalance: jest.fn(),
    getVaultBalanceAt: jest.fn(),
    assertVaultControl: jest.fn().mockResolvedValue(undefined),
  };

  // The escrow, not the pooled vault, is where a deposit lands.
  const ESCROW_PDA = toAccountId(SOLANA_DEVNET, 'Escrow111111111111111111111111111111111111');
  const ESCROW_ATA = toAccountId(SOLANA_DEVNET, 'EscrowAta11111111111111111111111111111111');

  const opener: EscrowOpenerPort = {
    open: jest.fn().mockResolvedValue({
      escrowPda: ESCROW_PDA,
      escrowTokenAccount: ESCROW_ATA,
      signature: 'open-escrow-signature',
    }),
  };

  const escrowReader: EscrowBalanceReaderPort = {
    read: jest.fn().mockResolvedValue(null as EscrowChainBalance | null),
    readMany: jest.fn().mockResolvedValue(new Map<AccountId, EscrowChainBalance>()),
    escrowAddresses: jest
      .fn()
      .mockResolvedValue({ escrowPda: ESCROW_PDA, escrowTokenAccount: ESCROW_ATA }),
  };

  /**
   * `buyer_escrows` as a fake rather than a real repository, and the reason is
   * the schema rather than laziness: migration
   * `1759100000000-buyer-escrows-and-voucher-seq` also alters `payment_intents`,
   * which this harness's DataSource does not create — it exists for the
   * deposit-intent state machine and the ledger. What this context proves needs
   * real Postgres; the mirror row does not, and
   * `test/integration/payment/escrow-seq.integration.spec.ts` covers it against
   * the real table.
   */
  const escrowRows = new Map<string, BuyerEscrowEntity>();
  const escrows = {
    findByAccount: jest.fn((organizationId: string, accountId: string) =>
      Promise.resolve(escrowRows.get(`${organizationId}|${accountId}`) ?? null),
    ),
    upsertOpened: jest.fn(
      (row: {
        organizationId: string;
        accountId: string;
        assetId: string;
        escrowAccountId: string;
        escrowAssetAccountId: string;
        openedTxRef: string | null;
      }) => {
        const saved = {
          id: randomUUID(),
          nextSeq: '1',
          openedAt: new Date(),
          ...row,
        } as unknown as BuyerEscrowEntity;
        escrowRows.set(`${row.organizationId}|${row.accountId}`, saved);
        return Promise.resolve(saved);
      },
    ),
    allocateSeq: jest.fn(),
    peekNextSeq: jest.fn(),
    bumpNextSeqTo: jest.fn(),
    oldestPendingSeq: jest.fn(),
    listAll: jest.fn().mockResolvedValue([]),
  } as unknown as BuyerEscrowRepository;

  const depositService = new DepositService(
    deposits,
    registry,
    facilitator,
    opener,
    escrowReader,
    escrows,
    ledger,
  );
  const finality = new DepositFinalityService(repository, registry, escrowReader, ledger);

  const context: DepositTestContext = {
    deposits,
    depositService,
    expiry,
    finality,
    ledger,
    repository,
    dataSource,
    adapter,
    facilitator,
    vault,
    opener,
    escrowReader,
    escrows,
    organizationId: randomUUID(),

    async reset(): Promise<void> {
      context.organizationId = randomUUID();
      escrowRows.clear();
      jest.clearAllMocks();

      // `DepositFinalityService.promotePendingDeposits` is deliberately
      // cross-tenant (`findSettledAwaitingFinality` has no `organizationId`
      // to scope to — the vault it reconciles against is shared platform-wide).
      // Unlike `ledger_entries`, `deposit_intents` carries no append-only
      // trigger, so truncating it between tests is what keeps one test's
      // finality sweep from also picking up — and consuming mock call
      // sequences meant for — a `SETTLED` intent an earlier test left behind.
      // A fresh `organizationId` alone is not enough for this table, unlike
      // every ledger read, which stays organization-scoped.
      await dataSource.query('TRUNCATE TABLE "deposit_intents"');
    },

    async close(): Promise<void> {
      await dataSource.destroy();
    },

    usdc(atomic: bigint): Money {
      return MoneyUtil.of(atomic, USDC_ASSET, USDC_DECIMALS);
    },

    account(label: string): AccountId {
      return toAccountId(SOLANA_DEVNET, label);
    },

    id(label: string): string {
      return uuidFromLabel(label);
    },

    async available(accountId: AccountId): Promise<bigint> {
      const balance = await ledger.getBalance(context.organizationId, accountId, USDC_ASSET);
      return MoneyUtil.toAtomic(balance.available);
    },

    async pending(accountId: AccountId): Promise<bigint> {
      const balance = await ledger.getBalance(context.organizationId, accountId, USDC_ASSET);
      return MoneyUtil.toAtomic(balance.pending);
    },
  };

  return context;
}
