import { AccountId, AssetId } from '@modules/chains/ports/caip.types';

/**
 * Opens `["escrow", buyer]` and its associated token account — `open_escrow`,
 * behind the same never-hand-encode / never-hold-a-buyer-key boundary every
 * other settlement-program write in this codebase sits behind.
 *
 * Unlike the buyer-signed doors on `EscrowIntentBuilderPort`,
 * `open_escrow` takes **no buyer signature** — the buyer is named
 * as a plain account, not a signer — so the platform can, and here does, open
 * the escrow itself: the fee payer advances the rent (0.0113448 SOL, measured
 * — `BuyerEscrow` 9,305,520 + the escrow ATA 2,039,280 lamports) and is
 * recorded on chain as the party `close_escrow` refunds.
 *
 * ## The escrow opens DISARMED, and only the buyer can arm it
 *
 * `open_escrow` has one rule here: a non-zero
 * `max_voucher_amount` or `max_per_window` requires the `buyer` account to be
 * a **signer** (`EscrowLimitsRequireBuyer`). A bare identity may still open an
 * escrow, but only with both limits at zero — and zero means
 * "refuse every redeem", not "unlimited". So every escrow this port opens is
 * one no voucher can yet be paid from, by construction: the platform no longer
 * chooses a buyer's limits, it cannot. The buyer arms the escrow through the
 * buyer-signed `set_escrow_limits` intent (`POST /escrow/limits-intent`),
 * and a first voucher before that lands is refused on chain with
 * `VoucherExceedsPerCallLimit`. There is no default to configure any more;
 * `ESCROW_DEFAULT_MAX_VOUCHER_AMOUNT` / `ESCROW_DEFAULT_MAX_PER_WINDOW` went
 * with the ability to use them.
 */
export interface EscrowOpenerPort {
  /**
   * Opens the escrow, disarmed, or returns the addresses of one that already
   * exists.
   *
   * Idempotent for the **addresses** — calling it twice for the same buyer
   * never opens a second escrow, because there is only one PDA for `buyer` to
   * find — and it never touches the limits of an escrow that is already
   * there: those are the buyer's, set by the buyer. Callers that already know
   * an escrow exists (the mirror row is present) should not call this at all;
   * see `DepositService.ensureEscrow`.
   */
  open(
    buyer: AccountId,
    asset: AssetId,
  ): Promise<{
    readonly escrowPda: AccountId;
    readonly escrowTokenAccount: AccountId;
    /** The `open_escrow` transaction signature, or `null` if it could not be confirmed. */
    readonly signature: string | null;
  }>;
}

export const ESCROW_OPENER = 'ESCROW_OPENER';
