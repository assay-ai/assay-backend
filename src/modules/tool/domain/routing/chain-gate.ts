import { ChainId } from '@modules/chains/ports/caip.types';

import { RoutingCandidate, RoutingContext } from './routing.types';

/**
 * Which chains this candidate could actually settle on for this buyer.
 *
 * ```text
 * chains(402) = payerChains ∩ settlementChains(candidate) ∩ enabledChains
 *                            ∖ withdrawingChains
 * ```
 *
 * Three sets and all three are necessary. Dropping `payerChains` advertises a
 * chain the buyer cannot pay on; dropping `settlementChains` routes to a
 * provider who is not there; dropping `enabledChains` offers a network this
 * deployment does not serve (this is one of exactly two seams that must read
 * the enabled set BY NAME, because it enumerates rather than resolves).
 *
 * The **subtraction** comes from the EVM gas model (`docs/gas.md` in
 * assay-evm): a buyer with a
 * standing withdrawal on a chain must not be quoted on it. It is a subtraction
 * rather than a fourth intersection because the reason has to survive: when the
 * result is empty, `filterEligible` asks
 * `chainsWithheldForWithdrawal` (`withdraw-gate.ts`) which of the two facts it was, and
 * reports `BUYER_WITHDRAWING` or `CHAIN_NOT_SETTLEABLE` accordingly. Folding
 * the withdrawal into `payerChains` at the call site would work and would make
 * every such refusal say "fund another chain" to a buyer who just asked for
 * their money back.
 *
 * Order is `payerChains`', so that `accepts[]` and the chosen chain both come
 * out in the buyer's own preference order rather than the provider's.
 *
 * **This set is not a claim about collateral.** `candidate.settlementChains`
 * is the binding's declaration narrowed to the provider's ACTIVE enrolments,
 * and an enrolment exists before the stake does. The stake gate runs after
 * this, on the chosen chain, and it is what makes the invariant true.
 */
export function settleableChains(
  candidate: RoutingCandidate,
  context: RoutingContext,
): readonly ChainId[] {
  const offered = new Set(candidate.settlementChains);
  const enabled = new Set(context.enabledChains);
  const withdrawing = new Set(context.withdrawingChains);
  return context.payerChains.filter(
    (chainId) => offered.has(chainId) && enabled.has(chainId) && !withdrawing.has(chainId),
  );
}

/**
 * Which chain this call settles on.
 *
 * ```text
 * 1. defaultChainId ∈ settleable  → defaultChainId
 * 2. [not implemented] the candidate with the greatest spendable balance
 * 3. ties → CHAIN_ADAPTERS registration order
 * ```
 *
 * **Rule 2 is deliberately absent**, and its absence is not a shortcut:
 * it reads a per-chain *spendable balance*, which this function is not given.
 * With one enabled chain, rules 1 and 3 are
 * exhaustive. When rule 2 arrives it must also write the spendable balance of
 * every candidate at decision time onto `payment_intents`, because it reads a
 * mutable quantity and a disputed call replays the record rather than the
 * chain.
 *
 * Rule 1 exists so the common case is stable and predictable: a buyer who funds
 * one chain and occasionally tops up the other does not get their traffic
 * silently migrated by a balance fluctuation.
 *
 * **`registrationOrder` is `context.enabledChains`, and that is exact rather
 * than approximate.** `ChainsModule` builds `CHAIN_ADAPTERS` from
 * `ENABLED_CHAINS` in list order, so "CHAIN_ADAPTERS registration order"
 * and the enabled list are the same list — there is no separate registration
 * input to look for, and a reader of rule 3 would otherwise go looking for one.
 *
 * Pure and total on a non-empty input. Throws on an empty one rather than
 * returning a chain nobody chose — the caller refuses with
 * `CHAIN_NOT_SETTLEABLE` before reaching here, and a fallback would make that
 * refusal skippable.
 */
export function chooseSettlementChain(
  settleable: readonly ChainId[],
  defaultChainId: ChainId | null,
  registrationOrder: readonly ChainId[],
): ChainId {
  if (settleable.length === 0) {
    throw new Error(
      'chooseSettlementChain called with no settleable chain — the caller must refuse ' +
        'with CHAIN_NOT_SETTLEABLE before selecting one',
    );
  }

  if (defaultChainId && settleable.includes(defaultChainId)) {
    return defaultChainId;
  }

  // `?? settleable[0]` is not dead: `registrationOrder` is the enabled list,
  // and a caller may pass a settleable set drawn from somewhere else (the
  // publish gate hands one chain; a test hands two). Returning the first
  // settleable chain keeps the function total on every non-empty input, and the
  // enabled-set intersection in `settleableChains` is what makes the fallback
  // unreachable on the routing path.
  const ordered = registrationOrder.find((chainId) => settleable.includes(chainId));
  return ordered ?? settleable[0];
}
