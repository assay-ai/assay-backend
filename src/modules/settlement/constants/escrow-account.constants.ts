/**
 * The rolling window `BuyerEscrow.spent_in_window` / `max_per_window` are
 * counted over — 24 hours.
 *
 * **Not read from `Config`.** It would naturally sit alongside
 * `withdraw_delay_seconds` — but `Config`'s generated decoder
 * (`packages/settlement-client/src/generated/accounts/config.ts`) has no such
 * field, and the generated decoder is authoritative. The window is
 * a fixed program constant (`SLASH_WINDOW_SECONDS` on the Anchor side,
 * `decay_window`'s own divisor), not an operator-tunable parameter, so there
 * is nothing on chain to read it from. Written here rather than inline so a
 * change to the program's constant has exactly one place in this backend to
 * follow it, the same discipline `VOUCHER_SEQ_WINDOW` and its siblings keep in
 * `payment/constants/escrow-seq.constants.ts`.
 */
export const ESCROW_WINDOW_SECONDS = 86_400;
