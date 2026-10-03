import { ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyUtil } from '@utils/money.util';

import { PricingMode } from '../../ports/tool.types';
import {
  Ineligible,
  IneligibilityReason,
  MinimumStakeParameters,
  RoutingCandidate,
} from './routing.types';

/**
 * The stake gate, asked **about one chain**.
 *
 * ```text
 * paid binding + stake ON THIS CHAIN >= minimumStake   →  routable
 * paid binding + stake ON THIS CHAIN <  minimumStake   →  not routable, no penalty
 * paid binding + no reading for THIS CHAIN             →  not routable (STAKE_UNKNOWN)
 * free binding                                         →  routable, no stake required
 * ```
 *
 * The chain parameter is not decoration, for the same reason it is not on
 * `evaluatePayoutGate`. A slash happens in the settlement contract of the chain
 * the call was paid on, and collateral on Solana is invisible and unreachable
 * to a contract on `eip155:4663`. A gate that read "the" stake and compared it
 * against whichever chain it was asked about would route a 4663 call against
 * Solana collateral nothing on 4663 can take — which is the gate's own premise
 * ("a provider who defects loses more than they gained") quietly made false.
 *
 * The gate is a **liquidity condition, not a punishment**, and the difference
 * is load-bearing: falling below the floor pauses paid routing and nothing
 * else — no strike, no slash, no tier demotion — and topping back up restores
 * traffic with no appeal, no review and no human in the loop. Treating it as a
 * sanction would make an ordinary treasury movement into a reputational event.
 *
 * What the floor actually buys is that every paid call is backed by more
 * capital than the call is worth, so a provider who defects on a verified call
 * loses more than they gained. A gate that let an under-collateralised
 * provider serve paid traffic would leave the platform underwriting the
 * difference — which is shadow mode, deliberately, and only there.
 *
 * Free bindings are exempt because there is nothing to slash: no payment
 * settles, so no defection profits. Free-only bindings need no stake and stay
 * routable.
 */

export type StakeGateVerdict =
  | { readonly passed: true; readonly minimum: Money | null }
  | { readonly passed: false; readonly reason: IneligibilityReason; readonly detail: string };

/**
 * `max(floor, priceMultiple × price)` — the computed floor for one binding.
 *
 * Scaling with price is what makes the floor meaningful across a catalogue
 * where one tool costs $0.001 and another costs $2. A flat floor would be
 * crushing for the first and irrelevant for the second, and it is the second
 * case that matters: a provider serving $2 calls against a $50 bond can profit
 * by defecting after 25 of them.
 *
 * Both operands must be denominated in the same asset; `MoneyUtil` refuses to
 * compare across assets and this function does not paper over that. Callers go
 * through {@link evaluateStakeGate}, which turns the refusal into a rejection
 * reason instead of an exception.
 */
export function minimumStakeFor(price: Money, parameters: MinimumStakeParameters): Money {
  const scaled = MoneyUtil.multiplyByInteger(price, parameters.priceMultiple);
  return MoneyUtil.greaterThan(scaled, parameters.floor) ? scaled : parameters.floor;
}

/**
 * Does this candidate clear the gate?
 *
 * Every failure path returns a reason rather than throwing. A stake source that
 * is down, a provider mid-registration with no stake row, a binding priced in
 * an asset the floor is not denominated in — none of those are exceptional
 * conditions in a system with open registration, and all three must produce
 * "this binding is not a candidate" rather than "this tool call crashed".
 *
 * They all fail *closed*. The one thing this function must never do is admit a
 * binding because it could not work out whether to.
 */
export function evaluateStakeGate(
  candidate: RoutingCandidate,
  chainId: ChainId,
  parameters: MinimumStakeParameters,
): StakeGateVerdict {
  const { binding, provider } = candidate;

  // `FREE` only. `FREEMIUM` is gated like a paid binding on purpose: the same
  // binding serves both free and paid calls, so at selection time — before a
  // quota has been checked — we cannot know which this call will be, and
  // guessing wrong in the permissive direction routes a paid call to an
  // unbonded provider.
  if (binding.pricingMode === PricingMode.FREE) {
    return { passed: true, minimum: null };
  }

  let minimum: Money;
  if (provider.minimumStakeOverride) {
    // A negotiated floor is a number the platform agreed outright, so it needs
    // no price and no conversion — which is also why it is checked first.
    minimum = provider.minimumStakeOverride;
  } else if (binding.assetId !== parameters.floor.asset) {
    // No FX here, deliberately. Converting a price into the stake asset needs a
    // rate, a rate needs a source, and a stale rate would silently move the
    // floor. Until a binding priced in another asset is a real case, this is a
    // rejection with a name rather than an arithmetic guess.
    return {
      passed: false,
      reason: IneligibilityReason.STAKE_ASSET_MISMATCH,
      detail: `binding priced in ${binding.assetId}, stake floor in ${parameters.floor.asset}`,
    };
  } else {
    // Same asset, so the floor's scale is the price's scale. `ToolBinding`
    // carries `priceAmount` + `assetId` and no decimals of its own, and this is
    // the only place that needs them reunited.
    const price = MoneyUtil.of(binding.priceAmount, binding.assetId, parameters.floor.decimals);
    minimum = minimumStakeFor(price, parameters);
  }

  const stake = candidate.stakeByChain?.get(chainId) ?? null;
  if (!stake) {
    return {
      passed: false,
      reason: IneligibilityReason.STAKE_UNKNOWN,
      detail: `no stake reading for provider ${provider.providerId} on ${chainId}`,
    };
  }

  // A reading filed under a key that disagrees with its own `chainId` is a bug
  // in whatever built the map, and using it would compare this chain's floor
  // against another chain's collateral. Refused, with the reason that already
  // means "we could not work out whether to admit this".
  //
  // **Be honest about what this currently buys.** All three production sources
  // set `ProviderStake.chainId` from the same map key they file the reading
  // under, so for every one of them this check is a tautology and cannot fire.
  // It is not dead weight — it is the guard for a source that does not yet
  // exist and for a caller that hand-builds the map (the publish gate and the
  // devnet integration suite both do) — but it is not, today, a second opinion.
  //
  // Making it one is one expression and belongs in the sources, not here:
  // `chainId: chainIdOf(reading.staked.asset)`. A `Money.asset` is CAIP-19 and
  // names its own chain, so that derives the field from the READING rather than
  // from the key, and the two become independent — and it works for **all
  // three** sources. (`chainIdOf(account)` would fix only the on-chain one;
  // `ConfigProviderStakeSource` has no account at all, its snapshot key is its
  // only input, so two of three would still be tautological.) The config
  // source's asset/chain pairing is validated at load by `provider-seed.ts`,
  // and the on-chain source's asset is itself built from the account, so the
  // asset is a genuinely separate witness in both.
  //
  // The database half is already covered by
  // `chk_provider_chain_enrolments_stake_on_chain` — but only in production:
  // the unit suite runs over in-memory fakes where CHECK constraints do not
  // exist, and a defect has already shipped green that way. That is a second
  // argument for the asset-derived version, which holds in both. It stayed
  // belt-and-braces rather than being done in the same change as the repair of
  // these sources' tests.
  if (stake.chainId !== chainId) {
    return {
      passed: false,
      reason: IneligibilityReason.STAKE_UNKNOWN,
      detail:
        `stake reading for provider ${provider.providerId} is on ${stake.chainId}, ` +
        `not ${chainId}`,
    };
  }

  if (stake.staked.asset !== minimum.asset) {
    return {
      passed: false,
      reason: IneligibilityReason.STAKE_ASSET_MISMATCH,
      detail: `staked in ${stake.staked.asset}, minimum in ${minimum.asset}`,
    };
  }

  if (!MoneyUtil.greaterThanOrEqual(stake.staked, minimum)) {
    return {
      passed: false,
      reason: IneligibilityReason.STAKE_BELOW_MINIMUM,
      detail: `staked ${MoneyUtil.format(stake.staked)}, minimum ${MoneyUtil.format(minimum)}`,
    };
  }

  return { passed: true, minimum };
}

/** The gate's verdict as an {@link Ineligible}, for the rejection list. */
export function toIneligible(
  candidate: RoutingCandidate,
  verdict: Extract<StakeGateVerdict, { passed: false }>,
): Ineligible {
  return { candidate, reason: verdict.reason, detail: verdict.detail };
}
