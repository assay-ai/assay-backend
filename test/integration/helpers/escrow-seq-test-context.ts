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
import { BuyerEscrowSeqRewind1759600000007 } from '@database/postgres/migrations/1759600000007-buyer-escrow-seq-rewind';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { Redis } from 'ioredis';
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
import { CallIdAndCallClass1756800000000 } from '@database/postgres/migrations/1756800000000-call-id-and-call-class';
import { BuyerEscrowsAndVoucherSeq1759100000000 } from '@database/postgres/migrations/1759100000000-buyer-escrows-and-voucher-seq';
import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { ESCROW_SEQ_GAP_CACHE_KEY } from '@modules/payment/constants/escrow-seq.constants';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { Alert, AlertPort } from '@shared/alerting';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import {
  TEST_POOL_SIZE,
  USDC_ASSET,
  ensureTestDatabase,
  testConnectionOptions,
  BuyerEscrowAccountColumnsSlice1759300000000,
} from './test-database';
import { noBlocks } from '../../unit/helpers/blocklist';

loadEnv();

export const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;

/** Records what would have paged, so a test can assert on it without a sink. */
export class RecordingAlertPort implements AlertPort {
  readonly emitted: Alert[] = [];

  async emit(alert: Alert): Promise<void> {
    this.emitted.push(alert);
  }
}

export interface EscrowSeqTestContext {
  readonly service: EscrowSeqService;
  readonly escrows: BuyerEscrowRepository;
  readonly alerts: RecordingAlertPort;
  readonly dataSource: DataSource;
  /** Rotated by `reset()`; read it fresh in every test. */
  organizationId: string;
  account(label: string): AccountId;
  reset(): Promise<void>;
  close(): Promise<void>;
  openEscrow(organizationId: string, account: AccountId): Promise<void>;
  /**
   * Inserts a `buyer_escrows` row directly, bypassing `upsertOpened`'s
   * `ON CONFLICT`. The only way to ask the database whether it would permit a
   * second escrow for one account.
   */
  insertEscrowRow(organizationId: string, account: AccountId, assetId: string): Promise<void>;
  /** A rail-B intent occupying `seq`, with its hold still open. */
  seedOpenIntent(organizationId: string, account: AccountId, seq: bigint): Promise<void>;
  /** Retires that intent's hold, so it leaves the pending minimum. */
  settleIntent(account: AccountId, seq: bigint): Promise<void>;
  setNextSeq(account: AccountId, nextSeq: bigint): Promise<void>;
  readNextSeq(account: AccountId): Promise<bigint>;
  clearGapCache(account: AccountId): Promise<void>;
}

/**
 * A real Postgres and a real Redis, because both guarantees under test are
 * properties of those systems rather than of this code.
 *
 * The allocator is `UPDATE … RETURNING` under a row lock — an in-memory fake
 * would serialise by accident and prove nothing about fifty concurrent calls.
 * `trg_buyer_escrows_seq_monotonic` is a trigger, and nothing but Postgres
 * raises it. Redis is here so that a stale gap can be cleared and re-read the
 * way the service actually does it.
 */
export async function createEscrowSeqTestContext(): Promise<EscrowSeqTestContext> {
  const database = await ensureTestDatabase(
    process.env.ESCROW_SEQ_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_escrow_seq_test`,
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
      RoutedPaymentIntents1755600000000,
      TimestamptzTimestamps1755900000000,
      CallIdAndCallClass1756800000000,
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
      // `voucher_admission_pauses`, which the voucher admission reads (BUG-D1-07).
      VoucherAdmissionPause1759600000005,
      VoucherAdmissionPausePerRequest1759600000006,
      // The gated rewind of `next_seq` (review S2-2).
      BuyerEscrowSeqRewind1759600000007,
      // `redemption_tx_refs`, `redemption_last_error`, `redemption_lapsed_at`,
      // `redemption_replaced_at` and `voucher_resource`, all mapped by
      // `PaymentIntentEntity` (redemption tracking and buyer debt).
      PaymentIntentRedemptionTxRefs1760200000000,
      PaymentIntentRedemptionLastError1760600000000,
      PaymentIntentRedemptionLapsed1760700000000,
      PaymentIntentDebtReplacing1760800000000,
      VoucherSeqDebtReplacement1760900000000,
    ],
    synchronize: false,
    logging: process.env.ESCROW_SEQ_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });

  const escrows = new BuyerEscrowRepository(dataSource);
  const alerts = new RecordingAlertPort();
  const service = new EscrowSeqService(escrows, new CacheService(redis), noBlocks());

  const context: EscrowSeqTestContext = {
    service,
    escrows,
    alerts,
    dataSource,
    organizationId: randomUUID(),

    account(label: string): AccountId {
      return toAccountId(SOLANA_MAINNET, label) as AccountId;
    },

    async reset(): Promise<void> {
      context.organizationId = randomUUID();
      alerts.emitted.length = 0;
    },

    async close(): Promise<void> {
      await dataSource.destroy();
      redis.disconnect();
    },

    async openEscrow(organizationId: string, account: AccountId): Promise<void> {
      await escrows.upsertOpened({
        organizationId,
        accountId: account,
        assetId: USDC_ASSET,
        escrowAccountId: `escrow-${account.slice(-8)}`,
        escrowAssetAccountId: `escrow-ata-${account.slice(-8)}`,
        openedTxRef: null,
      });
    },

    async insertEscrowRow(
      organizationId: string,
      account: AccountId,
      assetId: string,
    ): Promise<void> {
      await dataSource.query(
        `INSERT INTO "buyer_escrows"
           ("organization_id", "account_id", "asset_id", "escrow_account_id", "escrow_asset_account_id")
         VALUES ($1, $2, $3, $4, $5)`,
        [organizationId, account, assetId, `pda-${assetId}`, `ata-${assetId}`],
      );
    },

    async seedOpenIntent(organizationId: string, account: AccountId, seq: bigint): Promise<void> {
      // Written as SQL rather than through `PaymentIntentService`: this context
      // is about the allocator, and wiring the whole ledger in to open a hold
      // would make the suite depend on everything the intent path depends on.
      await dataSource.query(
        `INSERT INTO "payment_intents"
           ("organization_id", "agent_id", "agent_account", "tool_id", "rail",
            "call_id", "call_class", "status",
            "asset_id", "decimals", "price_amount", "provider_amount", "platform_fee",
            "request_hash", "chain_id", "expires_at", "voucher_seq")
         VALUES ($1, $2, $3, $4, 'RAIL_B_VOUCHER', $5, 'PAID', 'CREATED',
                 $6, 6, '1000000', '900000', '100000',
                 $7, $8, now() + interval '1 hour', $9::bigint)`,
        [
          organizationId,
          randomUUID(),
          account,
          randomUUID(),
          randomUUID(),
          USDC_ASSET,
          `sha256:${'0'.repeat(64)}`,
          SOLANA_MAINNET,
          seq.toString(),
        ],
      );
    },

    async settleIntent(account: AccountId, seq: bigint): Promise<void> {
      // `chk_payment_intents_hold_release` refuses a release timestamp with no
      // hold — money given back that was never reserved — so the seeded intent
      // gets a hold id on its way out.
      await dataSource.query(
        `UPDATE "payment_intents"
            SET "hold_id" = COALESCE("hold_id", gen_random_uuid()),
                "hold_released_at" = now()
          WHERE "agent_account" = $1 AND "voucher_seq" = $2::bigint`,
        [account, seq.toString()],
      );
    },

    async setNextSeq(account: AccountId, nextSeq: bigint): Promise<void> {
      await dataSource.query(
        `UPDATE "buyer_escrows" SET "next_seq" = $2::bigint WHERE "account_id" = $1`,
        [account, nextSeq.toString()],
      );
    },

    async readNextSeq(account: AccountId): Promise<bigint> {
      const rows: Array<{ next_seq: string }> = await dataSource.query(
        `SELECT "next_seq"::text AS next_seq FROM "buyer_escrows" WHERE "account_id" = $1`,
        [account],
      );
      return BigInt(rows[0].next_seq);
    },

    async clearGapCache(account: AccountId): Promise<void> {
      await redis.del(ESCROW_SEQ_GAP_CACHE_KEY(account));
    },
  };

  return context;
}
