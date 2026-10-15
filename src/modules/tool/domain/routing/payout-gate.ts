import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { ProviderRoutingState } from '@modules/provider/ports/provider.types';

import { PricingMode } from '../../ports/tool.types';
import { IneligibilityReason, RoutingCandidate } from './routing.types';

/**
 * The payout gate.
 *
 * ```text
 * paid binding + payout account proved   →  routable
 * paid binding + no payout account       →  not routable, no penalty
 * free binding                           →  routable, no payout account needed
 * ```
 *
 * ## What it is for
 *
 * A settled call credits `payment_intents.provider_account`, and that value is
 * snapshotted from the provider's ACTIVE enrolment on the settlement chain
 * (`provider_chain_enrolments.payout_account_id`) at the moment the call
 * is served. A provider who has never proved an address has no such value, so a
 * call they serve reaches the `VERIFYING → SETTLED` edge with nobody to pay:
 * `PaymentIntentService.resolve()` refuses, the agent's money stays `held`, and
 * nothing in the platform returns it. Refusing *before* the call is the only
 * point at which that costs nobody anything.
 *
 * Same shape as {@link evaluateStakeGate} and for the same reason: **one
 * function, one answer**. The publish gate calls this to keep a PAID
 * binding from going live unpayable, and `filterEligible` calls it on every
 * live routing decision to keep an already-published one from serving if the
 * address is withdrawn later. Belt and braces — the two gates ask at different
 * times, and only the second one is still true a month after publication.
 *
 * ## Why `FREE` is exempt, and what that leaves open
 *
 * A `FREE` binding takes the relay path —
 * no intent, no hold, no settlement — so there is nothing to credit and
 * requiring an address would refuse traffic that moves no money.
 * `FREEMIUM` is **not** exempt, on exactly the reasoning
 * `evaluateStakeGate` gives: the same binding serves both free and paid calls
 * and the quota has not been checked at selection time, so guessing free would
 * route a charged call to an unpayable provider.
 *
 * The exemption is safe only because a `FREE` binding never serves a charged
 * call: a tool with *both* `FREE` and paid bindings quotes as paid, and the
 * router then routes it with `RoutingContext.callClass = 'PAID'`, which leaves
 * every `FREE` binding out of the pool before this gate runs. The same rule is
 * what makes `evaluateStakeGate`'s `FREE` exemption safe.
 */

export type PayoutGateVerdict =
  | { readonly passed: true }
  | {
      readonly passed: false;
      readonly reason:
        | IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED
        | IneligibilityReason.PAYOUT_ENROLMENT_NOT_ACTIVE;
      readonly detail: string;
    };

/**
 * Can this candidate be paid for a call it serves, ON THIS CHAIN?
 *
 * The chain parameter is not decoration. A settled call credits
 * `payment_intents.provider_account`, and that value comes from the provider's
 * payout address *on the chain the call settled on* — collateral and payment
 * on Solana are invisible and unreachable from a contract on `eip155:4663`. A
 * provider who has proved an address on one chain and not the other is payable
 * on one chain and not the other, and before per-chain enrolments that was not
 * representable: one column meant one answer to "where do I get paid", which is
 * *the* shape that hands an attacker somebody else's money.
 *
 * Fails closed, like every other gate here: an absent entry is a refusal, never
 * a fallback to some other chain's address. A candidate whose provider row was
 * missing arrives with an empty map (see `unknownProvider`) and is refused,
 * rather than admitted because the question could not be answered.
 */
export function evaluatePayoutGate(
  candidate: RoutingCandidate,
  chainId: ChainId,
): PayoutGateVerdict {
  const { binding, provider } = candidate;

  if (binding.pricingMode === PricingMode.FREE) {
    return { passed: true };
  }

  if (!provider.payoutAccountByChain?.get(chainId)) {
    // Two ways to have no payable address on a chain, and they are fixed by
    // different people doing different things — so they get different names.
    // An enrolment that exists but is closed means the signature was given and
    // the platform withdrew the chain; telling that provider to prove an
    // address sends them to repeat a step that is already done and that
    // repeating cannot fix (`prove()` does not reopen `status`, by design).
    const enrolled = provider.payoutEnrolmentChains?.has(chainId) ?? false;

    return {
      passed: false,
      reason: enrolled
        ? IneligibilityReason.PAYOUT_ENROLMENT_NOT_ACTIVE
        : IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED,
      detail: enrolled
        ? `provider ${provider.providerId || 'unknown'} has a payout address proved on ` +
          `${chainId}, but that enrolment is not ACTIVE, so a settled call on binding ` +
          `${binding.id} would credit a chain the platform has withdrawn them from`
        : `provider ${provider.providerId || 'unknown'} has not proved a payout address on ` +
          `${chainId}, so a settled call on binding ${binding.id} would have nobody to credit`,
    };
  }

  return { passed: true };
}

/**
 * This provider's payee **on one named chain**, or `null` if they have none.
 *
 * The one place the per-chain map is read outside the gate, and it exists so
 * that there is only one. The rule it enforces is that a caller must arrive
 * already knowing which chain it is asking about — taken from the money it is
 * holding, since a `Money.asset` is CAIP-19 and `chainIdOf` gives its chain —
 * rather than reaching into the map for whatever is in it.
 *
 * "Whatever is in it" is the specific failure being designed out. A provider
 * enrolled on Solana and on `eip155:4663` has two entries in insertion order,
 * and taking the first would write a Solana address as the payee of a call
 * settled on 4663: a payout to an account the settling chain cannot see, on the
 * row that decides who is paid, discovered only when the money does not arrive.
 * `null` — the refusal — is the safe answer, and every caller already has one:
 * `evaluatePayoutGate` refused the candidate before it could be selected.
 */
export function payoutAccountOn(
  provider: ProviderRoutingState,
  chainId: ChainId,
): AccountId | null {
  return provider.payoutAccountByChain?.get(chainId) ?? null;
}
