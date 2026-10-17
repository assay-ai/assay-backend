import { ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { ProviderRoutingState } from '@modules/provider/ports/provider.types';
import { ProviderStake } from '@modules/provider/ports/provider-stake.port';

import { ToolBinding } from '../../ports/tool.types';

/**
 * Routing — the types the decision is made over.
 *
 * The whole decision is a pure function of these values. Nothing in
 * `domain/routing/` opens a socket, reads a clock or touches a repository: the
 * router *service* gathers the inputs and performs the call, and everything
 * that decides *which* binding gets the call lives here, where it can be
 * replayed. That split is what makes "why did this call go to provider X" an
 * answerable question months later rather than an appeal to a log line.
 */

/**
 * One binding, with everything known about the provider behind it.
 */
export interface RoutingCandidate {
  readonly binding: ToolBinding;
  readonly provider: ProviderRoutingState;
  /**
   * The chains this candidate could settle on, as far as **configuration** goes.
   *
   * `binding.settlementChains` — the provider's own declaration — narrowed to
   * the chains that provider holds an ACTIVE enrolment on. Both halves are
   * configuration and neither is a claim about collateral: an enrolment row
   * exists before the money does (see `ChainEnrolmentPort`'s header), so a
   * chain can be in this list with nothing staked behind it.
   *
   * Kept beside `binding.settlementChains` rather than replacing the read of
   * it, because the two answer different questions and a rejection has to say
   * which. The binding's list is what the provider asked for and is what the
   * console shows them; this one is what is left after the enrolments are
   * applied, and it is what the chain gate intersects with the buyer's chains.
   *
   * The stake re-check runs **after** this, on the chosen chain, and it is what
   * makes the routability invariant true. Folding stake in here would relabel
   * every shortfall as a buyer-shaped `CHAIN_NOT_SETTLEABLE` and hide it from
   * the provider who can fix it in minutes.
   */
  readonly settlementChains: readonly ChainId[];
  /**
   * What this provider has staked, **per chain**. Replaces `stake`.
   *
   * An absent key means the stake source had no answer *for that chain*.
   * Deliberately not defaulted to zero — "we could not read the stake" and "the
   * stake is zero" are different facts, the gate refuses both, and only one of
   * them is worth paging someone about.
   *
   * It is equally deliberately not defaulted to *another chain's* reading. A
   * map lets "bonded on Solana, nothing on `eip155:4663`" be said; the single
   * `stake` field it replaces could not say it, so a 4663 call would have been
   * admitted against collateral no contract on 4663 can see. The map is empty,
   * never `null`: an empty map and a missing key are the same refusal, and a
   * nullable map would add a third spelling of it.
   */
  readonly stakeByChain: ReadonlyMap<ChainId, ProviderStake>;
  /**
   * When the open grace row expires; `null` when there is none.
   *
   * Deliberately says nothing about the stake comparison. The date is a fact
   * about the grace row and only about the grace row — a loader that nulled
   * this field whenever `stake >= minimum` would make the value depend on the
   * very check the gate performs, and the gate would then be reading its own
   * answer back as an input.
   *
   * Grace protects traffic that is ALREADY FLOWING; it does not open the door.
   * A binding that has not cleared the stake gate does not get to go live
   * because a grace row is open — which is why the publish gate
   * (`binding-publish.service.ts`) passes `null` here unconditionally, and why
   * that rule belongs on the type rather than at that one call site.
   *
   * Required, not optional. A call site that forgets this field is a binding
   * that should have been cut and was let through instead.
   */
  readonly stakeGraceUntil: Date | null;
  /**
   * Lifetime calls THIS BINDING has served; `null` when the counter was not
   * read.
   *
   * Per binding, not per provider, and lifetime, not a window: one count of
   * every call ever routed to this one binding. Its source of truth is
   * the `payment_intents.binding_id` column — a row per call, against the
   * binding, for as long as the binding has existed. This names where the count
   * must come from, which is the whole point of the warning further down.
   *
   * The threshold that reads it is **1,000 calls**. Below it the binding is
   * still "new" and receives the exploration floor — 5% of the tool's traffic
   * at 100% verification sampling (the same 1,000 that `NEUTRAL_PRIOR` in
   * `score.ts` already cites).
   *
   * **This is not `candidate.provider.stats.callsServed`.** That number sits
   * on this same candidate, and it is a PROVIDER-level lifetime count summed
   * across every binding that provider has ever published. Reaching for it
   * compiles, passes and is silently wrong in the direction that matters: an
   * established provider's brand-new binding would read as tens of thousands
   * of calls and never be explored, so it would never acquire the statistics
   * the floor exists to buy it. `ProviderTier.NEW` is the same trap one file
   * over — also provider-level, also about a first 1,000 calls, and also not
   * this.
   *
   * `null` means the counter was not read, and a binding with `null` is
   * EXCLUDED from the exploration set rather than treated as new. Zero cannot
   * stand in for it, because unlike the other two placeholders zero is the
   * PERMISSIVE value here: a binding that looks new is handed traffic it has
   * not earned. So the floor degrades off when the count is unavailable,
   * which is the fail-closed direction and the same distinction `stake: null`
   * keeps above.
   */
  readonly observedCalls: number | null;
  /**
   * Which ceiling is currently hit, READ before filtering.
   *
   * Read, not consumed. `filterEligible` is pure and synchronous so it cannot
   * read Redis; the token is consumed exactly once, on the binding actually
   * invoked, after selection. Consuming at filter time would spend one token
   * per CANDIDATE per routing decision, so the real `max_rps` would be ~1/N of
   * what the provider declared — and a check that asks only whether traffic
   * sheds would still pass while the ceiling was wrong.
   */
  readonly ceilingHit: CeilingKind | null;
}

/**
 * Which self-declared ceiling was hit.
 *
 * Two members, where a provider can declare up to four ceilings, so the
 * omissions are stated rather than left to look like oversights. **Timeout**
 * is not a ceiling in this sense: it is a
 * per-call deadline the router already enforces through `binding.timeoutMs`,
 * and a call that runs out of time was attempted — that is an outcome to
 * classify, not a condition to shed traffic on before attempting. The
 * **monthly** ceiling (`maxMonthlyCalls`) is simply not implemented
 * yet; it needs a counter with a different reset period, not another branch
 * here.
 *
 * `MAX_DAILY_CALLS` and not `DAILY_QUOTA`: "quota" is already spoken for in
 * this codebase and means the AGENT's free-tier allowance —
 * `ToolBinding.freeQuotaPerAgent` and `ToolBinding.freeDailyBudget`, both
 * carried on this same candidate, and `McpErrors.quotaExceeded` ("Free-tier
 * quota exceeded"). This member is the PROVIDER's declared upstream ceiling,
 * the opposite party, and its field is called `maxDailyCalls`.
 */
export enum CeilingKind {
  MAX_RPS = 'MAX_RPS',
  MAX_DAILY_CALLS = 'MAX_DAILY_CALLS',
  /**
   * The binding's own free quota (per agent, or its daily budget) has no room
   * for this call. Shed like a ceiling: only on a free call, and only at the
   * reservation, never at filter time (review 2026-10-15, M4).
   */
  FREE_QUOTA = 'FREE_QUOTA',
}

/** A free-quota place taken for one call on one binding; given back if unused. */
export interface FreeQuotaPlace {
  release(): Promise<void>;
}

/**
 * Why a candidate was not routable.
 *
 * Enumerated rather than reduced to a boolean because the rejections have
 * wildly different owners: `PROVIDER_SUSPENDED` is a platform action,
 * `STAKE_BELOW_MINIMUM` is a provider liquidity condition they can fix
 * themselves in minutes, and `STAKE_UNKNOWN` is almost always *our* stake
 * source being down. Collapsing them would show a provider "not routable" with
 * no way to tell which of those three it is.
 */
export enum IneligibilityReason {
  /** The binding is `DRAFT`, `PAUSED` (circuit open) or `SUSPENDED`. */
  BINDING_NOT_ACTIVE = 'BINDING_NOT_ACTIVE',
  /** The provider row could not be found at all. */
  PROVIDER_UNKNOWN = 'PROVIDER_UNKNOWN',
  /** The provider is `SUSPENDED` or `UNBONDING`. */
  PROVIDER_NOT_ACTIVE = 'PROVIDER_NOT_ACTIVE',
  /** Already tried in this request — the failover exclusion. */
  PROVIDER_EXCLUDED = 'PROVIDER_EXCLUDED',
  /**
   * No chain this buyer can pay on is one this candidate settles on.
   *
   * A property of **the buyer**, not of the provider, and no action by the
   * provider changes it — which is why it is reported second, right after
   * `PROVIDER_EXCLUDED`, and ahead of every provider-shaped rejection.
   * Reporting `BINDING_NOT_ACTIVE` or `STAKE_BELOW_MINIMUM` to a buyer who
   * could never have paid this provider sends a provider-shaped signal about a
   * buyer-side condition — and worse, it lands in that provider's own console
   * as a routing rejection they are expected to fix.
   *
   * **Never a provider-quality event.** It does not count toward a circuit
   * breaker, does not enter `ProviderStats`, and is not a strike — the same
   * treatment `PROVIDER_EXCLUDED` already gets, for the same reason.
   */
  CHAIN_NOT_SETTLEABLE = 'CHAIN_NOT_SETTLEABLE',
  /**
   * The buyer has a standing withdrawal request on every chain they could
   * otherwise pay on (the EVM gas model, `docs/gas.md` in assay-evm).
   *
   * A voucher signed at `T + 1381` or later, where `T` is when the request was
   * made, can still be redeemable after the withdrawal has matured and been
   * taken — `withdraw()` reads no outstanding-voucher state and pays
   * `min(requested, balance)`, and the redemption then fails
   * `EscrowInsufficient` with the provider having already served. So the answer
   * is to stop quoting rather than to accept and hope.
   *
   * `EscrowSpendGateService` already refuses to ACCEPT a voucher in this state;
   * this is the other half, and it is the half a buyer actually sees.
   *
   * Immediately after {@link CHAIN_NOT_SETTLEABLE} because it is the same KIND
   * of fact — a property of the buyer, which no action by the provider changes
   * — and this file's ordering doctrine decides which reason is reported when
   * several apply. It is not the same fact, though, and the two must never
   * share a label: `CHAIN_NOT_SETTLEABLE` tells a buyer to fund another chain,
   * and this buyer's money is fine — they asked for it back.
   *
   * **Never a provider-quality event.** It does not count toward a circuit
   * breaker, does not enter `ProviderStats`, and is not a strike.
   */
  BUYER_WITHDRAWING = 'BUYER_WITHDRAWING',
  /**
   * The provider has never proved a payout address, so a paid call they served
   * would settle with nobody to credit.
   *
   * Its own reason rather than folded into `PROVIDER_NOT_ACTIVE`, because the
   * two are fixed by different people doing different things: a suspension is
   * lifted by the platform, and this is cleared by the provider signing from
   * the wallet they want paying. Reported ahead of the stake reasons for the
   * same ordering rule those follow — this one cannot be fixed by moving
   * money.
   */
  PAYOUT_ACCOUNT_UNPROVED = 'PAYOUT_ACCOUNT_UNPROVED',
  /**
   * The provider HAS proved a payout address on this chain, and the enrolment
   * carrying it is not `ACTIVE`.
   *
   * Its own reason, and the distinction is the whole point: `PAYOUT_ACCOUNT_
   * UNPROVED` says *"sign from the wallet you want paying"*, which is advice
   * this provider has already taken. Reporting it here would send them to
   * re-do a step that is done, forever, because **nothing in this codebase
   * reopens an enrolment**: `prove()` deliberately does not (a removed party
   * must not re-admit themselves by signing), the backfill seeds the status
   * once from `providers.status`, and there is no service, endpoint or script
   * that writes it afterwards. So a provider whose enrolment is closed is
   * unroutable on that chain until somebody runs SQL, and this reason is what
   * makes that state say its own name instead of impersonating a missing
   * signature.
   */
  PAYOUT_ENROLMENT_NOT_ACTIVE = 'PAYOUT_ENROLMENT_NOT_ACTIVE',
  /** The stake source returned nothing for this provider. Fails closed. */
  STAKE_UNKNOWN = 'STAKE_UNKNOWN',
  /** `stake < minimumStake`. A liquidity condition, not a punishment. */
  STAKE_BELOW_MINIMUM = 'STAKE_BELOW_MINIMUM',
  /**
   * The stake, the price and the floor are not all denominated in the same
   * asset, so the comparison the gate exists to perform cannot be made.
   */
  STAKE_ASSET_MISMATCH = 'STAKE_ASSET_MISMATCH',
  /**
   * `stake < minimum` AND grace has expired. Distinct from
   * `STAKE_BELOW_MINIMUM`, which is still reachable: `applyStakeGrace` only
   * relabels when there genuinely IS an expired grace row. Telling someone
   * "your grace expired" when they never had grace is a lie in the receipt.
   */
  STAKE_GRACE_EXPIRED = 'STAKE_GRACE_EXPIRED',
  /**
   * Hit a provider's self-declared ceiling. Not an error, not a strike, not
   * recorded in the quality profile — the router fails over to another provider.
   */
  CEILING_REACHED = 'CEILING_REACHED',
  /**
   * The provider is on a slash hold on every chain this buyer could settle
   * with it: its penalties there cannot be collected promptly (a full slash
   * window with an upheld record waiting, a stake fully reserved by pending
   * slashes, or bonded below the minimum). Lifts by itself once the chain
   * says otherwise; not a strike.
   */
  PROVIDER_SLASH_HOLD = 'PROVIDER_SLASH_HOLD',
}

export interface Ineligible {
  readonly candidate: RoutingCandidate;
  readonly reason: IneligibilityReason;
  readonly detail?: string;
}

export interface EligibilityResult {
  readonly eligible: readonly RoutingCandidate[];
  readonly rejected: readonly Ineligible[];
  /**
   * `bindingId` → the chain this candidate would settle on.
   *
   * One entry per **eligible** candidate, chosen once by `chooseSettlementChain`
   * and carried out rather than re-derived. The payout address the gate
   * checked, the collateral the gate checked and the chain recorded on the
   * intent are then guaranteed to be the same chain; resolving it separately in
   * three places is how they come to disagree.
   *
   * Recorded rather than recomputed for the reason every other routing input
   * is: a disputed call is re-explained months later by replaying the decision
   * from what it was given, not by asking the chain again.
   */
  readonly settlementChainOf: ReadonlyMap<string, ChainId>;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The scoring weights, as data.
 *
 * Tunable per tool category, which is why it is a value rather than five
 * constants. Quality is weighted highest on purpose: optimising for price
 * routes to whoever is cheapest and worst, which is the exact failure the
 * platform exists to prevent.
 */
export interface ScoreWeights {
  readonly quality: number;
  readonly availability: number;
  readonly latency: number;
  readonly price: number;
  readonly tier: number;
}

/** One binding's score, with the components kept so a decision can be explained. */
export interface ScoredCandidate {
  readonly candidate: RoutingCandidate;
  readonly score: number;
  readonly components: {
    readonly quality: number;
    readonly availability: number;
    readonly latency: number;
    readonly price: number;
    readonly tier: number;
  };
}

/** A binding and the share of this tool's traffic it should receive. */
export interface WeightedCandidate {
  readonly candidate: RoutingCandidate;
  readonly score: number;
  /** Share of traffic in `[0, 1]`. Across the list these sum to 1. */
  readonly weight: number;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * A source of randomness, injected.
 *
 * Weighted sampling needs a random draw, and a router that called
 * `Math.random()` directly could not be tested for distribution against a known
 * sequence, nor replayed. Production binds a CSPRNG draw (`cryptoRandom`).
 */
export type RoutingRandom = () => number;

/** See {@link RoutingContext.callClass}. */
export type RoutingCallClass = 'FREE' | 'PAID';

export interface RoutingContext {
  /**
   * Providers already tried in this request.
   *
   * The failover rule, and the reason failover is expressed as a *provider*
   * exclusion rather than a *binding* one: two bindings of the same provider
   * share an operator, a deployment and usually a datacentre, so retrying the
   * second after the first returned `SYSTEM_ERROR` is a retry against the thing
   * that just failed.
   */
  readonly excludeProviderIds?: readonly string[];
  /**
   * The ONLY provider this request may be served by — rail B's pin.
   *
   * A voucher names its payee inside the signed bytes, and the chain credits
   * `voucher.provider` whoever answered. So a call paid by a voucher must be
   * served by that provider or by nobody: failing over to another would hand
   * one operator's work to another operator's earnings. Absent means any.
   */
  readonly onlyProviderId?: string;
  /**
   * Whether this call is charged, and so which bindings may serve it.
   *
   * - `PAID`: only `PAID` and `FREEMIUM` bindings. A `FREE` binding is exempt
   *   from the stake floor and the payout gate, so a charged call drawn onto one
   *   would credit a provider nobody bonded or checked.
   * - `FREE`: only `FREE` and `FREEMIUM` bindings. A `PAID` binding's provider
   *   would serve with no intent behind the call and be paid nothing.
   *
   * Absent means every binding, and only a quote leaves it out: the quote is
   * what decides the call class, so it has to see the whole supply.
   */
  readonly callClass?: RoutingCallClass;
  /**
   * The buying organization, for the observed stats only.
   *
   * Read by `attributeAttempt` and by nothing that decides routing: an attempt
   * whose buyer IS the provider is a self-call, and leaving it out of the
   * stats is what stops a provider from buying itself a good availability or
   * latency figure. Absent on a quote, which dials nobody; an attempt with no
   * buyer named is counted as an ordinary one.
   */
  readonly buyerOrganizationId?: string;
  /**
   * A free call's per-binding quota, reserved by the caller on the binding
   * about to be dialled — beside the ceiling token, in `selectAndReserve`.
   * `null` means the binding has no room: it is shed and the draw runs again
   * over what is left, so the router never sends a free call to a binding
   * whose own quota is spent (review 2026-10-15, M4), and parallel calls
   * cannot all fit into the last place (M5). Absent on paid calls.
   */
  readonly reserveFreeQuota?: (binding: ToolBinding) => Promise<FreeQuotaPlace | null>;
  /**
   * The chains the buyer can pay from RIGHT NOW. Supplied, never inferred.
   *
   * **Required, not optional, and the two call sites each have to say what they
   * mean.** An optional field defaulting to "everything" is a fail-open on the
   * one gate whose job is to refuse; defaulting to `[]` refuses everything and
   * would be found in staging rather than in review. The chain sets are
   * *supplied by the payment module, never inferred by the router*, and a
   * default is an inference with a nicer name.
   *
   * This is `[session.chainId]` for a call and `enabledChains` for a
   * quote — a quote must SHOW a tool the buyer cannot pay for rather
   * than hide it. It is deliberately **not** filtered by spendable balance:
   * a `spendable >= price` conjunct would relabel every insufficient-funds
   * refusal as a chain problem, and the two must not be conflated.
   */
  readonly payerChains: readonly ChainId[];
  /**
   * The subset of {@link payerChains} on which this buyer has a standing
   * withdrawal request (the EVM gas model, `docs/gas.md` in assay-evm).
   *
   * Required, not optional, for the reason {@link payerChains} is: an optional
   * field defaulting to `[]` is a fail-open on a gate whose job is to refuse,
   * and it would be found in staging rather than in review. Supplied by the
   * payment module, never inferred by the router — the router cannot read an
   * escrow, and a router that could would be reading a mutable quantity into a
   * decision that has to replay.
   *
   * The catalogue surfaces pass `[]` deliberately, and say so at their call
   * sites: a catalogue is not an offer to be paid, and hiding a tool because a
   * withdrawal is pending would make it flicker with the buyer's cash
   * management.
   */
  readonly withdrawingChains: readonly ChainId[];
  /** `ENABLED_CHAINS`, by name — `filterEligible` is pure and injects nothing. */
  readonly enabledChains: readonly ChainId[];
  /**
   * The buyer's default chain; rule 1 of `chooseSettlementChain`. `null` when they have none.
   *
   * Rule 1 exists so the common case is stable: a buyer who funds one chain and
   * occasionally tops up the other does not get their traffic silently migrated
   * by a balance fluctuation.
   */
  readonly defaultChainId: ChainId | null;
}

// ---------------------------------------------------------------------------
// Economic parameters
// ---------------------------------------------------------------------------

/**
 * How `minimumStake` is computed — `max(floor, priceMultiple × price)`.
 *
 * A value rather than two constants because every economic parameter must be
 * settable system-wide *and* overridable per provider contract.
 * Compiling `$50` and `1000` into the router would make each renegotiated
 * contract a deploy.
 */
export interface MinimumStakeParameters {
  /** The absolute floor — `$50` by default, denominated in the stake asset. */
  readonly floor: Money;
  /** Multiple of the binding's price. `1000` by default. */
  readonly priceMultiple: number;
}

/**
 * The floor, per chain. Replaces a single {@link MinimumStakeParameters}.
 *
 * A `MinimumStakeParameters.floor` is a `Money` and a `Money.asset` is CAIP-19,
 * so the floor **already names its chain**; this map makes that addressable
 * rather than implicit. No chain may be discounted — the full
 * minimum applies on each, because a discount would mean calls on one chain are
 * backed by collateral the chain enforcing them cannot see.
 *
 * A missing entry is a **misconfiguration**, not a routing outcome. The
 * `ROUTER_CONFIG` factory throws at boot when a chain in `ENABLED_CHAINS` has
 * no floor, because discovering it as a per-call `STAKE_UNKNOWN`
 * would look like an RPC outage. `filterEligible` still refuses a candidate
 * whose settlement chain has no floor, because a gate must never admit a
 * binding because it could not work out whether to.
 */
export type MinimumStakeByChain = ReadonlyMap<ChainId, MinimumStakeParameters>;
