/**
 * The program's `#[constant]` values that the backend has to read, re-exported
 * as TypeScript.
 *
 * Codama renders instructions, accounts, PDAs, types and errors from the IDL; it
 * does **not** render the IDL's `constants` array. So these two are the one part
 * of the interface that has to be retyped, and the retyping is checked against
 * `idl/assay_payment.json` by
 * `backend/test/unit/chains/solana/program-constants.spec.ts` — which is why
 * they belong here, next to the IDL, and not in whichever module happened to
 * need one first.
 *
 * Both used to be fields of `Config`. Moving them into the program as
 * constants is what makes them safe to read locally: a value that lives on a
 * mutable account cannot be trusted from a local copy, because one
 * `update_config` would silently invalidate every cached reading. A `#[constant]`
 * changes only with a program upgrade, and a program upgrade re-vendors the IDL,
 * which is exactly when the test above re-checks these numbers.
 */

/**
 * The wait between `propose_slash` and `execute_slash` — 72 hours.
 *
 * `SlashRecord.executable_at` is `proposed_at + SLASH_DELAY_SECONDS`, computed
 * once by the program and frozen on the record. Read the record's own field
 * wherever one exists; use this constant only to project the deadline of a
 * proposal that has not been written yet.
 */
export const SLASH_DELAY_SECONDS = 259_200;

/**
 * The wait between a buyer's `request_withdraw` and their `withdraw` — 1 hour.
 *
 * `BuyerEscrow.withdraw_available_at` is `requested_at + WITHDRAW_DELAY_SECONDS`.
 * The program requires this to exceed the maximum life of a redeemable voucher,
 * which is what stops a buyer withdrawing out from under a voucher already
 * signed and in flight.
 */
export const WITHDRAW_DELAY_SECONDS = 3_600;
