import { Injectable, Logger } from '@nestjs/common';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { AccountId } from '@modules/chains/ports/caip.types';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import {
  ESCROW_SEQ_GAP_CACHE_KEY,
  ESCROW_SEQ_GAP_CACHE_TTL_MS,
} from '../constants/escrow-seq.constants';
import { PaymentErrors } from '../errors/payment.errors';

/** What `GET /escrow/next-seq` answers with. */
export interface NextSeq {
  /** Decimal `u64`. Put this in the voucher's `seq`. */
  readonly seq: string;
  /** Base58. The voucher's `pay_to`. */
  readonly escrowPda: string;
  /** Base58. `ATA(escrowPda, stake_mint)` — where the balance sits. */
  readonly escrowTokenAccount: string;
}

/**
 * The sequence-number allocator. A plain per-buyer monotonic counter.
 *
 * ## What the simplified settlement program took out of this class
 *
 * The gate. `BuyerEscrow` used to carry an 8,192-bit replay bitmap keyed on
 * distance from `seq_high`, which made a large enough gap fatal — a buyer too
 * far ahead of their last redemption tripped `VoucherSeqJump` on a call that
 * had already been served — so `allocate` refused with a 429 well before the
 * chain would have. The program now replaces the bitmap with `seq > seq_high` and
 * nothing else, so gaps are free and unbounded and there is nothing left to
 * refuse.
 *
 * `next_seq` is still a **Postgres column** and its allocation is still one
 * `UPDATE … RETURNING`. It is the only durable record of what this platform has
 * handed out, and a counter a cache flush could reset would re-issue numbers a
 * buyer has already signed for; the chain would then refuse the *later* of the
 * two with `VoucherSeqNotIncreasing`, after the call had been served.
 *
 * `oldest_pending_seq` survives as a **reported** figure, cached in Redis for
 * two seconds. Nothing refuses on it any more.
 */
@Injectable()
export class EscrowSeqService {
  private readonly logger = new Logger(EscrowSeqService.name);

  constructor(
    private readonly escrows: BuyerEscrowRepository,
    private readonly cache: CacheService,
  ) {}

  /**
   * Issues the next sequence number for this session's account.
   *
   * One statement, no gate, and no way to refuse other than "this buyer has no
   * escrow". A number allocated and never spent leaves a hole, and holes are
   * free under `seq > seq_high`.
   *
   * `chainSeqHigh`, when the caller has read the escrow, raises `next_seq` past
   * it first. The program admits `seq > seq_high` and nothing else, and a buyer can
   * be ahead of this table — they redeemed somewhere this database did not
   * record, or it was restored from a backup — and a number at or below the
   * chain's is refused only AFTER the call it paid for was served. The raise is
   * monotonic (`bumpNextSeqTo`), so a stale read can never rewind the counter.
   */
  async allocate(
    organizationId: string,
    account: AccountId,
    chainSeqHigh: bigint | null = null,
  ): Promise<NextSeq> {
    if (chainSeqHigh !== null) {
      const moved = await this.escrows.bumpNextSeqTo(organizationId, account, chainSeqHigh + 1n);
      if (moved > 0) {
        this.logger.warn(
          `next_seq for ${account} was at or below the chain's seq_high ${chainSeqHigh}; ` +
            `raised to ${chainSeqHigh + 1n} before allocating`,
        );
      }
    }

    const allocated = await this.escrows.allocateSeq(organizationId, account);
    if (!allocated) {
      throw PaymentErrors.escrowNotOpen({ account });
    }

    return {
      seq: allocated.seq,
      escrowPda: allocated.escrowAccountId,
      escrowTokenAccount: allocated.escrowAssetAccountId,
    };
  }

  /**
   * Whether `seq` is one this backend has issued to `account` — the read
   * `VoucherService.assertIssuedSeq` needs.
   *
   * Built on `peekNextSeq` rather than a second table: `next_seq` is the
   * allocator's own high-water mark, so everything from `1` up to (but not
   * including) it has been handed out at some point, whether or not it was
   * ever turned into a voucher. `seq >= 1n` excludes the sentinel `0` the
   * chain uses for "never redeemed" (`BuyerEscrow.seqHigh`), which is not a
   * valid voucher seq — `open_escrow` and every voucher issuance starts at 1.
   *
   * Stays `true` forever for a seq this backend has already spent — this
   * answers "could this seq ever be valid", not "has it already been used".
   * The latter question is `record()`'s durable insert to answer.
   */
  async wasIssued(organizationId: string, account: AccountId, seq: bigint): Promise<boolean> {
    const nextSeq = await this.escrows.peekNextSeq(organizationId, account);
    if (nextSeq === null) {
      return false;
    }
    return seq >= 1n && seq < nextSeq;
  }

  /**
   * The oldest sequence number still awaiting a decision, from Redis when it is
   * fresh and from Postgres otherwise.
   *
   * `null` is a real answer — nothing is pending — and it is cached as such,
   * because the alternative is a full recompute on every call by the idle
   * majority of buyers. It is stored as a string so that `null` and `"0"` stay
   * distinguishable through JSON.
   *
   * Reported and never enforced since the program removed the in-flight ceiling.
   */
  async oldestPendingSeq(account: AccountId): Promise<bigint | null> {
    const key = ESCROW_SEQ_GAP_CACHE_KEY(account);
    const cached = await this.cache.get<string>(key).catch(() => null);

    if (cached !== null && cached !== undefined) {
      return cached === NOTHING_PENDING ? null : BigInt(cached);
    }

    const computed = await this.escrows.oldestPendingSeq(account);
    await this.cache
      .set(key, computed === null ? NOTHING_PENDING : computed.toString(), cacheTtlSeconds())
      .catch((error: unknown) => {
        // A cache that will not accept a write is a slower platform, not a
        // wrong one — every read behind it recomputes from Postgres.
        this.logger.warn(
          `Could not cache the pending-seq minimum for ${account}: ${describe(error)}`,
        );
      });

    return computed;
  }

  /** Drops the cached minimum, so the next read recomputes it. */
  async invalidateGap(account: AccountId): Promise<void> {
    await this.cache.del(ESCROW_SEQ_GAP_CACHE_KEY(account)).catch(() => undefined);
  }
}

/**
 * The cached form of "nothing is pending".
 *
 * A sentinel rather than an absent key: `CacheService.get` cannot tell a miss
 * from a stored `null`, and treating "no pending vouchers" as a miss would make
 * every idle buyer pay for the full query on every call — which is the majority
 * of calls.
 */
const NOTHING_PENDING = 'none';

function cacheTtlSeconds(): number {
  return Math.max(1, Math.round(ESCROW_SEQ_GAP_CACHE_TTL_MS / 1000));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
