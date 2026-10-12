/**
 * The voucher sequence rule, as the settlement program enforces it.
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
 */

/**
 * The widest jump a voucher's seq may take past the escrow's on-chain
 * `seqHigh`: mirrors `X402Escrow`'s `MAX_SEQ_GAP` (assay-evm
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
 * Postgres column for the reason `voucher-nonce.store.ts` already gives about
 * its own fast layer, that flushing Redis must never re-issue a number.
 */
export const ESCROW_SEQ_GAP_CACHE_TTL_MS = 2_000;

export const ESCROW_SEQ_GAP_CACHE_KEY = (account: string): string =>
  `escrow:seq:oldest-pending:${account}`;
