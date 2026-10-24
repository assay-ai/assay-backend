/**
 * The voucher sequence rule, as the Solana settlement program enforces it.
 * (`eip155` is different since D-23: see the end of this comment.)
 *
 * There is no bitmap any more. `BuyerEscrow` keeps a single `seq_high`, and
 * `redeem_voucher` admits a voucher on exactly one condition:
 *
 * ```text
 * seq > seq_high  ->  redeem, and seq_high = seq
 * otherwise       ->  VoucherSeqNotIncreasing
 * ```
 *
 * So **gaps are free** — unbounded on Solana, bounded on eip155 by
 * {@link VOUCHER_MAX_SEQ_GAP}. A seq that is allocated and never becomes
 * a voucher costs nothing, a buyer may be a million calls ahead of their last
 * redemption, and there is no in-flight ceiling to police: the four rules the
 * 8,192-bit window used to enforce collapse to one, and the two the backend
 * existed to keep unreachable (`VoucherSeqJump`, `VoucherTooOld`) no longer
 * exist.
 *
 * What the backend still owes the buyer is **order**. A lower seq that lands
 * after a higher one is dead — permanently, because `seq_high` only ever rises
 * — so the redemption job submits a buyer's vouchers in ascending seq and
 * serialises per buyer. That rule lives in `VoucherRedemptionService`, and it is
 * the whole of what replaced this file's arithmetic.
 *
 * **On eip155 (`AssayEscrow`, D-23) the rule is per seq instead:**
 *
 * ```text
 * seq == 0                           ->  VoucherSeqZero
 * held(payer, seq) has a record      ->  VoucherSeqUsed   (never deleted)
 * seq > seqHigh + MAX_SEQ_GAP        ->  VoucherSeqGapTooLarge
 * otherwise                          ->  redeem, and seqHigh = max(seqHigh, seq)
 * ```
 *
 * So there a lower seq that lands after a higher one is still paid, and the
 * redemption job neither orders nor serialises (`requiresAscendingSeq` is
 * `false`). The allocator still hands out seqs above `seqHigh`: that keeps the
 * gap cap, which anchors on `seqHigh`, meaningful.
 */

/**
 * The widest jump a voucher's seq may take past the escrow's on-chain
 * `seqHigh`: mirrors `AssayEscrow`'s `MAX_SEQ_GAP` (assay-evm
 * `Constants.sol`, D-17), which refuses `seq > seqHigh + MAX_SEQ_GAP` with
 * `VoucherSeqGapTooLarge`. So on eip155 gaps are free but **bounded**.
 *
 * Applied by the backend when it knows the on-chain `seqHigh` — at issue
 * (`EscrowSeqService.allocate`) and at admission
 * (`VoucherService.assertIssuedSeq`) — so a seq the chain would refuse is never
 * handed out or served on. A chain with no cap (the Solana program) loses
 * nothing: no honest buyer is a million calls ahead of their last redemption.
 *
 * Lives in the payment domain so both payment and chain code can import it;
 * `EVM_CONSTANTS.MAX_SEQ_GAP` is this value, and `constants-pin.spec.ts` pins
 * it to the contract's literal.
 */
export const VOUCHER_MAX_SEQ_GAP = 1_000_000;

/**
 * How long `oldest_pending_seq` may be served from Redis.
 *
 * The figure is reported, not enforced — nothing refuses a call on it since the
 * in-flight ceiling went — so a stale value costs an operator a slightly old
 * number and costs a buyer nothing. Redis is a cache here and nothing else: on
 * a miss, or a flush, it is recomputed from Postgres. The *allocator* is a
 * Postgres column because flushing Redis must never re-issue a number.
 */
export const ESCROW_SEQ_GAP_CACHE_TTL_MS = 2_000;

export const ESCROW_SEQ_GAP_CACHE_KEY = (account: string): string =>
  `escrow:seq:oldest-pending:${account}`;

/**
 * `GET /escrow/next-seq` per agent credential (review S2-2): each call advances
 * the payer's counter, so the route is throttled with the same sliding window
 * the public demo uses (`RedisDemoRateLimiter`, fails closed). Two a second on
 * average is far above what an agent signing its own vouchers needs.
 */
export const NEXT_SEQ_RATE_LIMITS = Object.freeze({
  perAddressPerWindow: 120,
  windowMs: 60_000,
});

/** DI token: the `RedisDemoRateLimiter` instance behind {@link NEXT_SEQ_RATE_LIMITS}. */
export const NEXT_SEQ_RATE_LIMITER = Symbol('NEXT_SEQ_RATE_LIMITER');
