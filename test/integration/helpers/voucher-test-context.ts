import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';
import { Redis } from 'ioredis';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { SolanaChainAdapter } from '@modules/chains/solana/solana-chain.adapter';
import { computeRequestHash } from '@modules/payment/domain/request-hash';
import { RedeemVoucherInput, SignedVoucher } from '@modules/payment/ports/voucher.types';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { VoucherService } from '@modules/payment/services/voucher.service';
import { Alert, AlertPort } from '@shared/alerting';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import {
  PaymentTestContext,
  SOLANA_MAINNET,
  USDC_ASSET,
  createPaymentTestContext,
} from './payment-test-context';
import { noBlocks } from '../../unit/helpers/blocklist';

/**
 * Records what would have paged, so a test can assert on it without a sink —
 * the same stand-in `escrow-seq-test-context.ts` uses.
 */
export class RecordingAlertPort implements AlertPort {
  readonly emitted: Alert[] = [];

  async emit(alert: Alert): Promise<void> {
    this.emitted.push(alert);
  }
}

/**
 * The rail-B redemption path with nothing faked.
 *
 * Real ed25519 keys, the real `SolanaChainAdapter`, a real Postgres carrying
 * `uq_payment_intents_account_voucher_seq` and the ledger the hold is opened
 * against, and a real `EscrowSeqService` reading `buyer_escrows` off that same
 * database. The unit suite proves the decision logic; this proves the two
 * guarantees that are properties of the infrastructure rather than of this
 * code — a compare-and-swap arbitrating simultaneous claims, and the unique
 * index refusing a replay **on its own**, with no fast path left to remove.
 */
export interface VoucherTestContext extends PaymentTestContext {
  readonly vouchers: VoucherService;
  readonly seqs: EscrowSeqService;
  readonly escrows: BuyerEscrowRepository;
  readonly redis: Redis;
  readonly cache: CacheService;
  /** The agent's account, derived from the test key pair. */
  readonly payer: AccountId;
  /** A correctly signed voucher plus the redeem input it is bound to. */
  voucherFor(overrides?: VoucherOverrides): RedeemVoucherInput;
}

export interface VoucherOverrides {
  readonly seq?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly price?: Money;
  readonly amount?: Money;
  readonly resource?: string;
  readonly toolId?: string;
  readonly organizationId?: string;
  readonly body?: unknown;
}

export const ESCROW_PDA: AccountId =
  `${SOLANA_MAINNET}:H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp` as AccountId;

export const RESOURCE = 'https://api.x402.dev/tools/weather-now';

/**
 * The provider `voucherFor()` signs against.
 *
 * A real base58-shaped pubkey, not `payment.account('voucher-provider')`:
 * voucher v2 signs `provider` as one of the 32-byte address fields
 * (`SolanaChainAdapter.buildVoucherMessage`), so a label that is not a valid
 * base58 pubkey fails address parsing before a signature could ever be
 * produced. v1 had no payee in the signed bytes at all, so this constraint
 * did not exist before voucher v2.
 */
export const VOUCHER_PROVIDER: AccountId =
  `${SOLANA_MAINNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;

/**
 * The address the settlement program is deployed to for this context.
 *
 * Voucher v2 signs the program id at offset 15 and `buildVoucherMessage`
 * refuses to build without one, deliberately: a default to the client's
 * compiled-in `declare_id!()` would have every buyer sign for a program that is
 * not the one about to check the signature.
 */
export const DEPLOYED_PROGRAM_ID = 'PR5bEscrowRedep1oyment11111111111111111111z';

/**
 * How far ahead of `next_seq` this context seeds the allocator on every
 * `reset()`.
 *
 * The real `UPDATE … RETURNING` allocation path is exhaustively covered by
 * `test/integration/payment/escrow-seq.integration.spec.ts` — this context
 * does not re-prove it. What it needs is simpler: `voucherFor()` mints seq
 * numbers off a **local** counter (so its call sites stay synchronous and this
 * file's diff against `EscrowSeqService`'s own allocator stays small), and
 * this constant just has to be bigger than any test will ever mint.
 */
const SEEDED_NEXT_SEQ = 1_000_000n;

export async function createVoucherTestContext(): Promise<VoucherTestContext> {
  const payment = await createPaymentTestContext();

  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  const cache = new CacheService(redis);

  const adapter = new SolanaChainAdapter(
    {
      getTokenAccountBalance: () => {
        throw new Error('the voucher path must not touch the chain');
      },
    } as never,
    [CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET],
    DEPLOYED_PROGRAM_ID,
  );
  const registry = new ChainAdapterRegistry([adapter], adapter.supportedChains);

  const keyPair = generateKeyPairSync('ed25519');
  const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const payer = `${SOLANA_MAINNET}:${getBase58Decoder().decode(rawPublicKey)}` as AccountId;

  const escrows = new BuyerEscrowRepository(payment.dataSource);
  const alerts = new RecordingAlertPort();
  const seqs = new EscrowSeqService(escrows, cache, noBlocks());
  const vouchers = new VoucherService(payment.intents, registry, seqs, noBlocks());

  /** Stands in for the allocator behind `GET /escrow/next-seq`. */
  let issued = 0;
  const nextSeq = () => (issued += 1);

  const signVoucher = (voucher: Voucher): SignedVoucher => ({
    voucher,
    signature: getBase58Decoder().decode(
      sign(null, Buffer.from(adapter.buildVoucherMessage(voucher)), keyPair.privateKey),
    ),
  });

  /**
   * Points `payer`'s escrow at the current `organizationId`, seeded far ahead
   * of `issued`.
   *
   * `escrow_account_id`/`escrow_asset_account_id` are `varchar(256)` and
   * CAIP-10 by intent, but the LIVE rows are still bare base58 — the multichain
   * migration widened and renamed the columns and deliberately did not canonicalise
   * what is in them. This context never touches the chain, so a short
   * placeholder derived from `payer` is enough; nothing in `VoucherService`
   * reads this column, it compares `voucher.payTo` against
   * `input.escrowPda` (`ESCROW_PDA`, the CAIP-10 constant) directly. Direct
   * SQL rather than `upsertOpened`, because `payment.reset()` rotates
   * `organizationId` every test while `uq_buyer_escrows_account` keys the row
   * on the account alone — `upsertOpened` refuses to move a row to a
   * different organization (deliberately, and correct in production), so a
   * test harness that reused one keypair across tenants has to reassign it
   * itself.
   */
  async function seedEscrow(organizationId: string): Promise<void> {
    const placeholderPda = `pda-${payer.slice(-40)}`;
    await payment.dataSource.query(
      `INSERT INTO "buyer_escrows"
         ("organization_id", "account_id", "asset_id", "escrow_account_id", "escrow_asset_account_id", "next_seq")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("account_id") DO UPDATE
          SET "organization_id" = EXCLUDED."organization_id",
              "next_seq" = EXCLUDED."next_seq",
              "updated_at" = now()`,
      [
        organizationId,
        payer,
        USDC_ASSET,
        placeholderPda,
        `${placeholderPda}-ata`,
        SEEDED_NEXT_SEQ.toString(),
      ],
    );
  }

  const context: VoucherTestContext = {
    ...payment,
    vouchers,
    seqs,
    escrows,
    redis,
    cache,
    payer,

    async reset(): Promise<void> {
      await payment.reset();
      alerts.emitted.length = 0;
      await seedEscrow(payment.organizationId);
    },

    async close(): Promise<void> {
      await payment.close();
      redis.disconnect();
    },

    voucherFor(overrides: VoucherOverrides = {}): RedeemVoucherInput {
      const price = overrides.price ?? payment.usdc(1_000_000n);
      const toolId = overrides.toolId ?? payment.id('voucher:tool');
      const providerId = payment.id('voucher:provider');
      const resource = overrides.resource ?? RESOURCE;
      const call = {
        method: 'POST',
        path: '/v1/weather',
        query: { units: 'metric' },
        body: overrides.body ?? { city: 'Paris', days: 3 },
      };

      const voucher: Voucher = {
        payer,
        payTo: ESCROW_PDA,
        provider: VOUCHER_PROVIDER,
        amount: overrides.amount ?? price,
        resource,
        requestHash: computeRequestHash({
          ...call,
          toolId,
          providerId,
          amount: price.amount,
          asset: price.asset,
        }),
        seq: overrides.seq ?? String(nextSeq()),
        issuedAt: overrides.issuedAt ?? Math.floor(Date.now() / 1000) - 5,
        expiresAt: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 120,
      };

      return {
        organizationId: overrides.organizationId ?? payment.organizationId,
        signed: signVoucher(voucher),
        call,
        agentId: randomUUID(),
        agentAccount: payer,
        providerId,
        providerAccount: VOUCHER_PROVIDER,
        toolId,
        resource,
        escrowPda: ESCROW_PDA,
        price,
        platformFee: payment.usdc(100_000n),
        chainId: SOLANA_MAINNET,
      };
    },
  };

  // `organizationId` is rotated by `reset()` on the payment context, and the
  // spread above copied its value rather than tracking it — which would leave
  // a test writing under the fresh tenant and reading under the stale one.
  // Delegating keeps the two contexts naming the same tenant at all times.
  Object.defineProperty(context, 'organizationId', {
    get: () => payment.organizationId,
    enumerable: true,
  });

  // The context must have a seeded escrow before the first test runs, in case
  // a caller uses it without going through `reset()` first (nothing here does,
  // but nothing enforces that either).
  await seedEscrow(payment.organizationId);

  return context;
}
