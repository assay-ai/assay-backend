/**
 * The buyer's own on-chain escrow limits — the shape
 * both `payment/` (opening an escrow at deposit time) and `settlement/`
 * (publishing and letting a buyer change them) need.
 *
 * Lives on the `chains/` boundary rather than in either domain module,
 * because neither may import the other and this is not a chain SDK type —
 * it is `open_escrow` and `set_escrow_limits`' own argument shape, which the
 * chain owns the vocabulary for. Compare `EscrowChainBalance`
 * (`ledger/ports/escrow-balance-reader.port.ts`), which is the read side of
 * the same account and stays in `ledger/` because only `ledger/` reads it —
 * this type crosses two domains and therefore cannot live in either.
 */
export interface EscrowLimits {
  /**
   * Per-call ceiling, atomic units of the escrow's mint.
   *
   * **`0` means refuse every redeem — not "unlimited".** A buyer who
   * wants no ceiling writes `u64::MAX`. Every escrow the platform opens starts
   * at `0` on both limits — `open_escrow` only accepts a non-zero limit from
   * the buyer's own signature (`EscrowLimitsRequireBuyer`) — so a new escrow
   * is one no call can be paid from until its buyer signs `set_escrow_limits`.
   * The failure before that surfaces on the paying path
   * (`VoucherExceedsPerCallLimit` / a redeem that never even gets attempted)
   * rather than here.
   */
  readonly maxVoucherAmount: bigint;
  /**
   * Rolling-window cap over the program's fixed 24h window, atomic units.
   * **`0` means refuse every redeem**, for the same reason as above.
   */
  readonly maxPerWindow: bigint;
}
