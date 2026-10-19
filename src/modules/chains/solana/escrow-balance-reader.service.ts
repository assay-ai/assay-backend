import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  findAssociatedTokenPda,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { Address, address, getBase64Encoder } from '@solana/kit';
import {
  BUYER_ESCROW_DISCRIMINATOR,
  findEscrowPda,
  getBuyerEscrowDecoder,
} from '@x402/settlement-client';

import {
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import { AccountId, AssetId, parseAccountId, parseAssetId } from '../ports/caip.types';
import { SOLANA_RPC } from './solana.constants';
import { SETTLEMENT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID_ENV } from './settlement-program.constants';

/**
 * `escrow_ata.amount` — the buyer's balance, read from the chain.
 * Cache 10s, fail closed past 60s.
 */
export const ESCROW_BALANCE_CACHE_TTL_MS = 10_000;

/** The fail-closed ceiling. Past this age a reading is not served at all. */
export const ESCROW_BALANCE_MAX_STALENESS_MS = 60_000;

/**
 * How many **addresses** one `getMultipleAccounts` may carry.
 *
 * Solana's own limit, not a policy choice: the RPC refuses more than 100 in one
 * call. Each escrow costs two addresses (the `BuyerEscrow` PDA and its ATA), so
 * a batch covers 50 buyers — which is why `readMany` chunks over addresses
 * rather than over buyers and never splits a pair across two calls.
 */
export const ESCROW_BALANCE_READ_BATCH = 100;

export const ESCROW_BALANCE_READER_CONFIG = 'ESCROW_BALANCE_READER_CONFIG';

export interface EscrowBalanceReaderConfig {
  /** Inside this age a reading is served without touching the RPC. */
  readonly freshTtlMs: number;
  /** Beyond this age a reading is not served, at all — see the class comment. */
  readonly staleMaxMs: number;
  /** Injected so a test can age a reading without waiting for it. */
  readonly now: () => number;
}

export const DEFAULT_ESCROW_BALANCE_READER_CONFIG: Omit<EscrowBalanceReaderConfig, 'now'> =
  Object.freeze({
    freshTtlMs: ESCROW_BALANCE_CACHE_TTL_MS,
    staleMaxMs: ESCROW_BALANCE_MAX_STALENESS_MS,
  });

/**
 * The one RPC call this service makes, declared structurally so a test can
 * supply exactly it — the same trade `SettlementStakeRpcClient` makes next
 * door. **No `sendTransaction`** — this file
 * only ever reads. Both the escrow account and its ATA are fetched together
 * — one round trip, not two — so there is no `getAccountInfo` here at all.
 */
export interface EscrowBalanceRpcClient {
  getMultipleAccounts(
    accounts: readonly Address[],
    config: { encoding: 'base64'; commitment?: 'confirmed' | 'finalized' },
  ): { send(): Promise<{ value: readonly ({ data: readonly [string, 'base64'] } | null)[] }> };
}

/** What is cached per buyer. `null` is a real, cacheable answer — see the class comment. */
interface CacheEntry {
  readonly reading: EscrowChainBalance | null;
  readonly observedAt: number;
}

/**
 * `escrow_ata.amount` — the buyer's balance, read from the chain.
 *
 * ## Two ages, and the difference between them is the whole design
 *
 * `freshTtlMs` (10s) is how long a reading is served
 * without touching the RPC. `staleMaxMs` (60s) is how old a reading may be and
 * still be spent against **at all**. Between them the cached figure is served
 * and a refresh runs behind it; past `staleMaxMs` this throws.
 *
 * The cache is therefore **not an optimisation** — it is what keeps one RPC
 * timeout from being a payment-path outage, and the ceiling is what keeps a
 * long outage from becoming an unbacked spend. `OnChainProviderStakeSource`
 * makes the same trade for the stake gate and this is deliberately the same
 * shape.
 *
 * ## It never falls back to the ledger
 *
 * The ledger is a mirror and a mirror lags: a redemption that landed on chain
 * whose `HOLD_COMMIT` was lost leaves the mirror reading *higher* than the
 * escrow. Spending against that is spending money that is not there, which is
 * the exact property per-buyer escrows exist to remove.
 *
 * ## A successful read that finds nothing DELETES the cache entry
 *
 * `null` means the escrow account does not exist, which is a first-class
 * answer (`PAYMENT_ESCROW_NOT_OPEN`) and not a balance of zero. It is cached
 * as `null` so a burst of calls against an unopened escrow does not hit the
 * RPC on every one — but any successful read, finding an account or not,
 * overwrites whatever was cached before it. A `null` reading is subject to the
 * same `freshTtlMs`/`staleMaxMs` ages as a real one, so a just-opened escrow
 * is never invisible for longer than the fresh window.
 *
 * ## Keyed per buyer
 *
 * One unreadable account must not blind the rest — the cache is a `Map`
 * keyed on `account:asset`, and a throw for one buyer never touches another's
 * entry.
 */
@Injectable()
export class SolanaEscrowBalanceReader implements EscrowBalanceReaderPort {
  private readonly logger = new Logger(SolanaEscrowBalanceReader.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly refreshing = new Set<string>();

  constructor(
    @Inject(SOLANA_RPC) private readonly rpc: EscrowBalanceRpcClient,
    @Inject(SETTLEMENT_PROGRAM_ID) private readonly programId: string | null,
    @Inject(ESCROW_BALANCE_READER_CONFIG) private readonly config: EscrowBalanceReaderConfig,
  ) {}

  async read(account: AccountId, asset: AssetId): Promise<EscrowChainBalance | null> {
    const key = cacheKey(account, asset);
    const cached = this.cache.get(key);
    const now = this.config.now();

    if (cached) {
      const age = now - cached.observedAt;
      if (age < this.config.freshTtlMs) {
        return cached.reading;
      }
      if (age < this.config.staleMaxMs) {
        // Serve the cached figure and refresh behind it — one refresh in
        // flight per key, so a burst of calls against a stale entry does not
        // fan out into a burst of RPC calls.
        this.backgroundRefresh(key, account, asset);
        return cached.reading;
      }
    }

    try {
      const reading = await this.fetch(account, asset);
      this.cache.set(key, { reading, observedAt: this.config.now() });
      return reading;
    } catch (error) {
      if (cached && now - cached.observedAt < this.config.staleMaxMs) {
        this.logger.warn(
          `Escrow balance read failed for ${account}; serving a ${now - cached.observedAt}ms-old ` +
            `reading (fail-closed ceiling ${this.config.staleMaxMs}ms). ${describe(error)}`,
        );
        return cached.reading;
      }
      // Fail closed. No fresh reading exists and none can be produced —
      // spending against a mirror here would spend money that may already
      // have left the escrow.
      throw PaymentErrors.escrowBalanceUnavailable({
        account,
        ageMs: cached ? now - cached.observedAt : undefined,
      });
    }
  }

  /**
   * Every account in one pass, **batched** — `ESCROW_BALANCE_READ_BATCH`
   * addresses per `getMultipleAccounts`.
   *
   * This deliberately does not go through {@link read}, and the reason is the
   * whole point of the method. `read` issues one `getMultipleAccounts` per
   * buyer, which is right for the paying path — one buyer, two accounts, cached
   * for 10 s — and wrong for the reconciler, where it is one RPC round trip per
   * buyer on every five-minute tick. That cost has to stay flat for
   * fail-closed to be affordable at all.
   *
   * Each escrow costs **two** accounts (the `BuyerEscrow` PDA and its ATA), so
   * a batch of 100 addresses covers 50 buyers. The chunking is over addresses,
   * not buyers, because 100 is the RPC's limit and not a policy choice, and a
   * pair is never split across two calls — a `BuyerEscrow` from one slot beside
   * an ATA from another is exactly the drift this method exists to measure.
   *
   * Readings are written into the same cache `read` serves from: a reconciler
   * pass that has just read every escrow should not leave the paying path to
   * re-read them one at a time.
   *
   * A batch that fails is skipped rather than thrown, and its accounts are
   * simply absent from the returned map — the port's contract, and what lets
   * the reconciler report "I could not check these buyers" instead of dying on
   * one of them.
   */
  async readMany(
    accounts: readonly AccountId[],
    asset: AssetId,
  ): Promise<ReadonlyMap<AccountId, EscrowChainBalance>> {
    const found = new Map<AccountId, EscrowChainBalance>();
    if (accounts.length === 0) {
      return found;
    }

    const pairs = await Promise.all(
      accounts.map(async (account) => ({
        account,
        addresses: await this.deriveAddresses(account, asset),
      })),
    );

    const perBatch = Math.floor(ESCROW_BALANCE_READ_BATCH / 2);
    for (let start = 0; start < pairs.length; start += perBatch) {
      const batch = pairs.slice(start, start + perBatch);
      const addresses = batch.flatMap(({ addresses: pair }) => [pair.escrowPda, pair.escrowAta]);

      let value: readonly ({ data: readonly [string, 'base64'] } | null)[];
      try {
        ({ value } = await this.rpc
          .getMultipleAccounts(addresses, { encoding: 'base64', commitment: 'confirmed' })
          .send());
        if (value.length !== addresses.length) {
          throw ChainErrors.rpcReplyMalformed({
            method: 'getMultipleAccounts',
            expected: addresses.length,
            actual: value.length,
          });
        }
      } catch (error) {
        this.logger.warn(
          `readMany: skipping a batch of ${batch.length} escrows — ${describe(error)}`,
        );
        continue;
      }

      batch.forEach(({ account, addresses: pair }, index) => {
        try {
          const reading = this.decodePair(
            account,
            asset,
            pair.escrowPda,
            value[index * 2],
            value[index * 2 + 1],
          );
          this.cache.set(cacheKey(account, asset), {
            reading,
            observedAt: this.config.now(),
          });
          if (reading) {
            found.set(account, reading);
          }
        } catch (error) {
          // One buyer's unreadable account must not blind the rest — the same
          // per-buyer isolation the cache gives `read`.
          this.logger.warn(`readMany: skipping ${account} — ${describe(error)}`);
        }
      });
    }

    return found;
  }

  async escrowAddresses(
    account: AccountId,
    asset: AssetId,
  ): Promise<{ escrowPda: AccountId; escrowTokenAccount: AccountId }> {
    const programAddress = address(this.requireProgramId());
    const { chainId, assetReference } = parseAssetId(asset);
    const { address: buyerPubkey } = parseAccountId(account);

    const [escrowPda] = await findEscrowPda({ buyer: address(buyerPubkey) }, { programAddress });
    const [escrowAta] = await findAssociatedTokenPda({
      owner: escrowPda,
      mint: address(assetReference),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    return {
      escrowPda: `${chainId}:${escrowPda}` as AccountId,
      escrowTokenAccount: `${chainId}:${escrowAta}` as AccountId,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private backgroundRefresh(key: string, account: AccountId, asset: AssetId): void {
    if (this.refreshing.has(key)) {
      return;
    }
    this.refreshing.add(key);

    this.fetch(account, asset)
      .then((reading) => {
        this.cache.set(key, { reading, observedAt: this.config.now() });
      })
      .catch((error: unknown) => {
        // The stale-but-served reading already answered this round; a failed
        // background refresh just means the next `read()` tries again.
        this.logger.warn(
          `Background escrow balance refresh failed for ${account}: ${describe(error)}`,
        );
      })
      .finally(() => {
        this.refreshing.delete(key);
      });
  }

  private async fetch(account: AccountId, asset: AssetId): Promise<EscrowChainBalance | null> {
    const { escrowPda, escrowAta } = await this.deriveAddresses(account, asset);

    const { value } = await this.rpc
      .getMultipleAccounts([escrowPda, escrowAta], { encoding: 'base64', commitment: 'confirmed' })
      .send();

    if (value.length !== 2) {
      throw ChainErrors.rpcReplyMalformed({
        method: 'getMultipleAccounts',
        expected: 2,
        actual: value.length,
      });
    }

    return this.decodePair(account, asset, escrowPda, value[0], value[1]);
  }

  /** Pure PDA derivation for one buyer — no RPC. Shared by {@link fetch} and `readMany`. */
  private async deriveAddresses(
    account: AccountId,
    asset: AssetId,
  ): Promise<{ escrowPda: Address; escrowAta: Address }> {
    const programAddress = address(this.requireProgramId());
    const { address: buyerPubkey } = parseAccountId(account);
    const { assetReference } = parseAssetId(asset);

    const [escrowPda] = await findEscrowPda({ buyer: address(buyerPubkey) }, { programAddress });
    const [escrowAta] = await findAssociatedTokenPda({
      owner: escrowPda,
      mint: address(assetReference),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return { escrowPda, escrowAta };
  }

  /**
   * One buyer's two accounts, decoded. `null` when the `BuyerEscrow` is absent.
   *
   * Split out of {@link fetch} so the batched `readMany` decodes by exactly the
   * same rules — including the buyer-identity check and the "absent ATA is a
   * zero balance, absent escrow is not an escrow" distinction, both of which a
   * second decoder would have got subtly wrong.
   */
  private decodePair(
    account: AccountId,
    asset: AssetId,
    escrowPda: Address,
    escrowAccount: { data: readonly [string, 'base64'] } | null,
    ataAccount: { data: readonly [string, 'base64'] } | null,
  ): EscrowChainBalance | null {
    const metadata = getAssetMetadata(asset);
    const { address: buyerPubkey } = parseAccountId(account);

    if (!escrowAccount) {
      // No `BuyerEscrow` at these seeds — this buyer has never opened an
      // escrow, or has closed it. A first-class answer, not a balance of zero.
      return null;
    }

    const escrowBytes = new Uint8Array(getBase64Encoder().encode(escrowAccount.data[0]));
    if (!discriminatorMatches(escrowBytes)) {
      throw ChainErrors.accountLayoutUnexpected({
        account: escrowPda,
        expected: 'a BuyerEscrow account',
        actual: Buffer.from(escrowBytes.subarray(0, 8)).toString('hex'),
      });
    }

    let escrow: ReturnType<ReturnType<typeof getBuyerEscrowDecoder>['decode']>;
    try {
      escrow = getBuyerEscrowDecoder().decode(escrowBytes);
    } catch (cause) {
      throw ChainErrors.accountLayoutUnexpected({
        account: escrowPda,
        expected: 'a BuyerEscrow account',
        actual: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (escrow.buyer !== buyerPubkey) {
      throw ChainErrors.accountLayoutUnexpected({
        account: escrowPda,
        expected: buyerPubkey,
        actual: escrow.buyer,
      });
    }

    // The ATA can legitimately be absent the instant after `open_escrow`
    // lands and before the ATA's own create instruction is observed — treated
    // as a zero balance, not as "no escrow", because the `BuyerEscrow` account
    // itself DOES exist.
    let atomicBalance = 0n;
    if (ataAccount) {
      const tokenBytes = new Uint8Array(getBase64Encoder().encode(ataAccount.data[0]));
      atomicBalance = getTokenDecoder().decode(tokenBytes).amount;
    }

    return {
      balance: MoneyUtil.of(atomicBalance, asset, metadata.decimals),
      seqHigh: escrow.seqHigh,
      withdrawRequested: escrow.withdrawRequested,
      withdrawAvailableAt: Number(escrow.withdrawAvailableAt),
      maxVoucherAmount: escrow.maxVoucherAmount,
      maxPerWindow: escrow.maxPerWindow,
      spentInWindow: escrow.spentInWindow,
      windowStartedAt: Number(escrow.windowStartedAt),
      observedAt: new Date(),
    };
  }

  private requireProgramId(): string {
    if (!this.programId) {
      throw ChainErrors.programNotConfigured({
        what: 'the settlement program',
        variable: SETTLEMENT_PROGRAM_ID_ENV,
      });
    }
    return this.programId;
  }
}

function cacheKey(account: AccountId, asset: AssetId): string {
  return `${account}:${asset}`;
}

function discriminatorMatches(data: Uint8Array): boolean {
  const expected = BUYER_ESCROW_DISCRIMINATOR;
  if (data.length < expected.length) {
    return false;
  }
  return Array.from(expected).every((byte, index) => data[index] === byte);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
