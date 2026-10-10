import { ChainId } from '@modules/chains/ports/caip.types';
import { ProviderStatus } from '@modules/provider/ports/provider.types';

import { BindingStatus } from '../../ports/tool.types';
import { chooseSettlementChain, settleableChains } from './chain-gate';
import { chainsWithheldForWithdrawal } from './withdraw-gate';
import { evaluatePayoutGate } from './payout-gate';
import { evaluateStakeGateOnChain, toIneligible } from './stake-gate';
import {
  EligibilityResult,
  Ineligible,
  IneligibilityReason,
  MinimumStakeByChain,
  RoutingCandidate,
  RoutingContext,
} from './routing.types';

/**
 * Which candidates may be routed to at all.
 *
 * Everything here is a hard gate — a candidate either survives or it does not,
 * and no amount of quality score can promote a rejected one. That separation
 * from `score.ts` is deliberate: scoring answers *"how good is this?"* and this
 * answers *"is this even allowed?"*, and a system that expressed suspension as
 * a very low weight would eventually route to a suspended provider on the day
 * every other candidate scored lower.
 *
 * The checks run cheapest-first, and the order also decides which reason is
 * reported when several apply. A binding whose provider is suspended *and*
 * under-staked reports the suspension, because that is the one the provider
 * cannot fix by moving money. `CEILING_REACHED` is last for the mirror-image
 * reason: it is the only rejection here that undoes itself, so it must never
 * be the reason shown for a binding that also has a durable problem.
 */
export function filterEligible(
  candidates: readonly RoutingCandidate[],
  minimumStakeByChain: MinimumStakeByChain,
  context: RoutingContext,
): EligibilityResult {
  const excluded = new Set(context.excludeProviderIds ?? []);
  const eligible: RoutingCandidate[] = [];
  const rejected: Ineligible[] = [];
  const settlementChainOf = new Map<string, ChainId>();

  for (const candidate of candidates) {
    const { binding, provider } = candidate;

    // Already tried in this request. Checked first because it is the only
    // rejection that is *not* a property of the candidate — it is a property of
    // where this request has already been, and reporting anything else about a
    // provider we simply are not allowed to retry would be noise on the receipt.
    if (excluded.has(binding.providerId)) {
      rejected.push({
        candidate,
        reason: IneligibilityReason.PROVIDER_EXCLUDED,
        detail: `provider ${binding.providerId} already attempted in this request`,
      });
      continue;
    }

    // A property of the BUYER. Second, for the reason PROVIDER_EXCLUDED is
    // first: neither is something this provider did, and both would be noise —
    // or worse, a misdirection — on the provider's own console. The position
    // follows from this file's own ordering doctrine.
    const settleable = settleableChains(candidate, context);
    if (settleable.length === 0) {
      // Which of the two buyer-side facts this is. `settleable` is empty, so
      // every chain that would otherwise have settled is in `withheld` — and
      // `withheld` being non-empty is exactly "the chains that would otherwise
      // have settled are the withdrawing ones". When it is empty the buyer
      // simply cannot pay on any chain this candidate offers, and the withdrawal
      // (if any) is on a chain that was never a candidate here.
      //
      // Two different facts must not share one label: CHAIN_NOT_SETTLEABLE
      // tells a buyer to fund another chain, and a withdrawing buyer's money is
      // fine — they asked for it back.
      const withheld = chainsWithheldForWithdrawal(candidate, context);
      if (withheld.length > 0) {
        rejected.push({
          candidate,
          reason: IneligibilityReason.BUYER_WITHDRAWING,
          detail:
            `binding ${binding.id} could settle on [${withheld.join(', ')}], and this buyer ` +
            `has a standing withdrawal request on ${withheld.length === 1 ? 'it' : 'each of them'}`,
        });
        continue;
      }

      rejected.push({
        candidate,
        reason: IneligibilityReason.CHAIN_NOT_SETTLEABLE,
        detail:
          `binding ${binding.id} settles on [${candidate.settlementChains.join(', ')}]; ` +
          `this buyer can pay on [${context.payerChains.join(', ')}]`,
      });
      continue;
    }

    // The chain this call would settle on. Chosen ONCE, here, and used by both
    // gates below and by the caller — so the payout address checked, the
    // collateral checked and the chain recorded on the intent are guaranteed
    // to be the same chain. Resolving it separately in three places is how they
    // come to disagree.
    const settlementChain = chooseSettlementChain(
      settleable,
      context.defaultChainId,
      context.enabledChains,
    );

    // `DRAFT`, `PAUSED` and `SUSPENDED` all land here, and a `PAUSED` binding is
    // the common one: it is a circuit that opened (error rate > 50% over 60s).
    // The probe that closes it again is health management's job, not routing's
    // — the router simply does not see a paused binding.
    if (binding.status !== BindingStatus.ACTIVE) {
      rejected.push({
        candidate,
        reason: IneligibilityReason.BINDING_NOT_ACTIVE,
        detail: `binding ${binding.id} is ${binding.status}`,
      });
      continue;
    }

    // The registry had no row. Fails closed — see `ProviderRegistryPort`.
    if (!provider.providerId) {
      rejected.push({
        candidate,
        reason: IneligibilityReason.PROVIDER_UNKNOWN,
        detail: `no registry record for the provider behind binding ${binding.id}`,
      });
      continue;
    }

    // `UNBONDING` is refused alongside `SUSPENDED`, and that is the less
    // obvious of the two: a provider withdrawing its stake is on its way below
    // the floor, and the withdrawal completing between this check and the call
    // landing would leave a paid call served with nothing behind it.
    if (provider.status !== ProviderStatus.ACTIVE) {
      rejected.push({
        candidate,
        reason: IneligibilityReason.PROVIDER_NOT_ACTIVE,
        detail: `provider ${provider.providerId} is ${provider.status}`,
      });
      continue;
    }

    // Before the stake gate, and for the same reason the suspension check sits
    // above both: a provider who has never proved a payout address cannot fix
    // that by moving money, and reporting a shortfall to someone whose real
    // problem is a missing signature sends them to the wrong screen. It is also
    // the more fundamental refusal — a call served here would settle with
    // nobody to credit, which is a hole no amount of stake closes.
    //
    // **The settlement chain is `chooseSettlementChain`'s answer, above.** It
    // was `chainIdOf(binding.assetId)` — the chain the binding's price happens
    // to be quoted in — which was a true value while a binding settled on
    // exactly one chain and stopped being one when bindings became multichain.
    //
    // **SEVEN expressions across FIVE files derived that, and THREE have
    // moved:** this one, and the two in `provider-router.service.ts`. The
    // remaining four are listed below with the reason each stayed.** Grep the derivation (`chainIdOf(...assetId)`), not its
    // callers — two of the remaining ones do not call `evaluatePayoutGate` and
    // hide from the obvious search. The count is stated so the next reader can
    // check it rather than trust it, and it must be re-counted whenever the
    // list below changes (it has been wrong twice, both times by undercounting
    // an expression that had just been added).
    //
    //   1. here, `filterEligible`                          — MOVED. The routing
    //      (`eligibility.ts`)                                gate AND the stake
    //                                                        gate: ONE choice,
    //                                                        two gates
    //   2. `provider/services/binding-publish.service.ts`  — MOVED. The
    //                                                        publish gate reads
    //                                                        `settlementChains`
    //                                                        and runs both gates
    //                                                        once per chain
    //   3. `tool/services/provider-router.service.ts`      — TWO expressions,
    //      · the PAYEE stamped on the intent                 BOTH MOVED. The
    //      · the `(provider, chain)` keys `stakeOn` is       payee is read from
    //        asked for, per binding                          `settlementChainOf`
    //                                                        — the chain both
    //                                                        gates ran on — and
    //                                                        the stake keys come
    //                                                        from the
    //                                                        candidate's own
    //                                                        chains, narrowed to
    //                                                        ACTIVE enrolments
    //   4. `provider/services/stake-monitor.service.ts`    — TWO expressions,
    //      · the `(provider, chain)` keys for the sweep       DELIBERATELY LEFT.
    //      · the reading the GRACE CLOCK counts against       A sweep has no
    //                                                         buyer, so it
    //                                                         cannot choose a
    //                                                         chain; it needs
    //                                                         one reading per
    //                                                         `settlementChains`
    //                                                         entry instead. See
    //                                                         that file for what
    //                                                         the divergence
    //                                                         costs today
    //   5. `scripts/demo/lib/seed-slash-window.ts`         — a fixture; it follows
    //
    // **NOT members, and the grep lands on both.** Two expressions derive
    // `chainIdOf(proposal.assetId)` from `slash_proposals.asset_id`, a
    // persisted column:
    //   · `slash/services/slash-execution.service.ts`   — the production one
    //   · `scripts/devnet/acceptance-suite.ts`          — the same read, in the
    //                                                     `demo:slash-case
    //                                                     --resume` path
    // Every site above answers *"which chain will this call settle on?"* — a
    // choice being made, which `chooseSettlementChain` replaces. A proposal's
    // asset is a **record of a choice already made**: by the time the row
    // exists the intent settled, the window closed and the penalty was
    // denominated. Pointing `chooseSettlementChain` at it would re-choose a
    // chain for a penalty already denominated, and could reach into collateral
    // on a chain that never backed the call. They are consumers of the outcome,
    // not members of the set — recorded HERE, and not only at the excluded
    // sites.
    const payout = evaluatePayoutGate(candidate, settlementChain);
    if (payout.passed === false) {
      rejected.push({ candidate, reason: payout.reason, detail: payout.detail });
      continue;
    }

    // The floor for the chain this call settles on, resolved by the same
    // function the publish gate calls — so a binding cannot publish against
    // one chain's floor and route against another's. A chain with no floor is
    // refused (`STAKE_UNKNOWN`) rather than defaulted; the `ROUTER_CONFIG`
    // factory makes that unreachable for any chain in `ENABLED_CHAINS` by
    // throwing at boot, so reaching it means a binding is priced on a chain the
    // deployment does not offer.
    const gate = evaluateStakeGateOnChain(candidate, settlementChain, minimumStakeByChain);
    if (gate.passed === false) {
      rejected.push(toIneligible(candidate, gate));
      continue;
    }

    // The provider's own declared ceiling, and the LAST check on
    // purpose. Every rejection above describes a condition that persists until
    // somebody acts — a suspension, a shortfall, a draft. A ceiling is the only
    // transient one: it clears within a second, or at the next UTC midnight,
    // with nobody doing anything. Reporting it over a suspension would send a
    // provider to look at a dial that is behaving exactly as they asked it to.
    //
    // **Read, never consumed.** This function is pure and synchronous —
    // `select()` depends on that, and a disputed call is re-explained months
    // later by replaying the decision from its recorded inputs — so the ceiling
    // state arrives on the candidate, read before filtering, and the token is
    // spent after selection on the one binding actually invoked. Consuming here
    // would spend one token per CANDIDATE per routing decision, making the real
    // `max_rps` roughly `1/N` of what the provider declared, and a test that
    // asks only whether traffic sheds would still pass.
    //
    // A truthiness test rather than `!== null`, and deliberately: this project
    // compiles with `strictNullChecks: false`, so a construction site that
    // forgot the field would read `undefined` — and `undefined !== null` is
    // true, which would shed every candidate on the platform. Every
    // `CeilingKind` member is a non-empty string, so the two spellings agree on
    // every value that is actually a ceiling, and they differ only in which
    // direction a missing field fails.
    if (candidate.ceilingHit) {
      rejected.push({
        candidate,
        reason: IneligibilityReason.CEILING_REACHED,
        detail: `binding ${binding.id} is at its declared ${candidate.ceilingHit} ceiling`,
      });
      continue;
    }

    // Recorded before the push, and keyed by binding: the caller stamps this
    // chain on the payment intent, and a caller that re-derived it could stamp
    // a different one from the one both gates were just run against.
    settlementChainOf.set(binding.id, settlementChain);
    eligible.push(candidate);
  }

  return { eligible, rejected, settlementChainOf };
}
