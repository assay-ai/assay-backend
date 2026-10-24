import { ChainId } from '@modules/chains/ports/caip.types';

import { RoutingCandidate, RoutingContext } from './routing.types';

/**
 * The chains this candidate would have settled on if the buyer were not
 * withdrawing (the EVM gas model, `docs/gas.md` in assay-evm).
 *
 * ```text
 * withheld = payerChains ∩ settlementChains(candidate) ∩ enabledChains ∩ withdrawingChains
 * settleable = payerChains ∩ settlementChains(candidate) ∩ enabledChains ∖ withdrawingChains
 * ```
 *
 * The two are complements over the same three-set intersection, and that is the
 * whole point of computing this separately rather than reading
 * `context.withdrawingChains` directly. A buyer withdrawing on a chain this
 * candidate never offered has nothing withheld from them *here*: the candidate
 * was cut because they could not pay it anyway, and reporting
 * `BUYER_WITHDRAWING` would hide a chain they could genuinely fund.
 *
 * So `filterEligible` reports `BUYER_WITHDRAWING` only when the settleable set
 * is empty **and** this one is not — which is exactly "the chains that would
 * otherwise have settled are the withdrawing ones". Two different facts, two
 * labels.
 *
 * ## Why this is not a balance check
 *
 * A standing withdrawal is not "the buyer is short". `withdraw()` pays
 * `min(requested, balance)` and reads no outstanding-voucher state; the escrow
 * may hold plenty right now. What makes the quote wrong is the CLOCK: a
 * withdrawal requested at `T` matures at `T + 3600` on Solana (`T + 10800` on
 * eip155, D-24), a voucher is redeemable until `expiresAt + 1800` (`+ 7200` on
 * eip155), and `expiresAt` may be `300` past `issuedAt`. A voucher signed at
 * `T + 1381` (`T + 3181` on eip155) or later can therefore still be redeemable
 * after the withdrawal has been taken, and the redemption then fails
 * `EscrowInsufficient` with the provider having already served. The contract's
 * own half of this is real and asserted at deployment (`3600 > 2220` on
 * Solana, `10800 > 7620` on eip155, so a voucher signed *before* the request
 * cannot outlive the delay) — and Solana's
 * `withdraw.rs` has no such check either, so this gate is parity rather than a
 * port defect.
 *
 * Pure, like everything else in `domain/routing/`.
 */
export function chainsWithheldForWithdrawal(
  candidate: RoutingCandidate,
  context: RoutingContext,
): readonly ChainId[] {
  const offered = new Set(candidate.settlementChains);
  const enabled = new Set(context.enabledChains);
  const withdrawing = new Set(context.withdrawingChains);

  // `payerChains`' order, like `settleableChains` — the buyer's own preference
  // order, so a detail line naming these chains reads the same way the
  // `accepts[]` list does.
  return context.payerChains.filter(
    (chainId) => offered.has(chainId) && enabled.has(chainId) && withdrawing.has(chainId),
  );
}
