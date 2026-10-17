import { Inject, Injectable, Logger } from '@nestjs/common';

import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { FreeBindingDials } from '@modules/free-tier/domain/free-calls-per-day';
import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MoneyUtil } from '@utils/money.util';

import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import {
  PROVIDER_REGISTRY,
  ProviderRegistryPort,
} from '@modules/provider/ports/provider-registry.port';
import {
  PROVIDER_STAKE_SOURCE,
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import {
  ProviderRoutingState,
  ProviderStatus,
  ProviderTier,
} from '@modules/provider/ports/provider.types';
import { STAKE_GRACE_SOURCE, StakeGracePort } from '@modules/provider/ports/stake-grace.port';

import {
  Classification,
  ClassificationReason,
  ProviderResponse,
  ResponseBodyKind,
  ResponseClass,
  TransportErrorKind,
  classifyMappingFault,
  classifyResponse,
  classifyTransportError,
  isRetryable,
} from '../domain/classification';
import { JsonObject, JsonValue, mapResponse, mappingFaultOf } from '../domain/mapping';
import {
  CeilingKind,
  EligibilityResult,
  Ineligible,
  IneligibilityReason,
  OnEmpty,
  RoutingCandidate,
  RoutingContext,
  RoutingRandom,
  RoutingRules,
  RuleRejection,
  RuleRejectionReason,
  StakeGateVerdict,
  WeightedCandidate,
  applyRules,
  applyStakeGrace,
  chooseSettlementChain,
  settleableChains,
  computeWeights,
  filterEligible,
  payoutAccountOn,
  pickWeighted,
  scoreCandidates,
  withoutEntryPreferences,
} from '../domain/routing';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';

import { ToolAccessErrors } from '../errors/tool-access.errors';
import { ToolErrors } from '../errors/tool.errors';
import { BINDING_INVOKER, BindingInvokerPort } from '../ports/binding-invoker.port';
import { TOOL_CATALOGUE, ToolCataloguePort } from '../ports/tool-catalogue.port';
import { PricingMode, Tool, ToolBinding } from '../ports/tool.types';
import { BindingCallCounterService } from './binding-call-counter.service';
import { BindingCeilingService } from './binding-ceiling.service';
import { ROUTER_CONFIG, ROUTING_RANDOM, RouterConfig } from './routing.config';

/**
 * The provider router.
 *
 * ```text
 *  tool call
 *      │
 *      ├─ gather candidates  ── catalogue + registry + stake + grace + counts + ceilings
 *      ├─ filterEligible     ── ACTIVE binding, ACTIVE provider, stake >= minimum, under ceiling
 *      ├─ reinstateGraced    ── grace: a shortfall inside its 7 days still routes
 *      ├─ score → weights    ── diversity floor, exploration floor, weighted sampling
 *      ├─ consume            ── one token, on the binding about to be dialled
 *      ▼
 *   attempt ──┬── DATA_RESULT   ─▶ return
 *             ├── REQUEST_ERROR ─▶ return          ← NO failover, deliberately
 *             └── SYSTEM_ERROR  ─▶ exclude that PROVIDER, pick again
 *                                    └─ out of providers ─▶ TOOL_ALL_BINDINGS_FAILED
 * ```
 *
 * ## Why `REQUEST_ERROR` does not fail over
 *
 * This is the rule most likely to be "fixed" by someone reading the failover
 * code and noticing it does not cover all failures. It is not an omission.
 *
 * A `REQUEST_ERROR` is the provider saying *the request was invalid* — the
 * agent's arguments did not satisfy what the endpoint accepts. Those same
 * arguments, mapped through a different binding, arrive at the second provider
 * just as wrong. Retrying spends another call, adds another timeout's worth of
 * latency to a caller who is blocked, degrades a second provider's
 * `compatibility_rate` for someone else's mistake, and ends at the same error.
 * The only thing it reliably produces is cost.
 *
 * `SYSTEM_ERROR` is the opposite in every respect: the provider's
 * infrastructure failed and says nothing about the request, so a different
 * operator is genuinely likely to succeed. That asymmetry is not a heuristic
 * this service invented — it is `isRetryable()` in the classification
 * vocabulary, and this service asks rather than re-deriving it, so that the day
 * a fourth class exists there is one place to change.
 *
 * ## Why failover excludes a *provider* and not a *binding*
 *
 * Two bindings of the same provider share an operator, a deployment and
 * usually a datacentre. Retrying the second after the first returned
 * `SYSTEM_ERROR` is a retry against the thing that just failed, dressed up as
 * failover. `RoutingContext.excludeProviderIds` is therefore provider-scoped.
 *
 * ## Why shedding is not failover, even though both move the call
 *
 * A ceiling hit is scoped to the **binding**, not the provider: the ceiling is
 * a property of one endpoint, and a provider's second binding has its own
 * bucket with its own headroom. Excluding the provider would shed traffic they
 * never asked us to shed. So `route` carries a separate per-request set of
 * bindings that have shed, and a shed costs no attempt from the failover
 * budget — nothing was attempted, so there is nothing to have failed. Only
 * `SYSTEM_ERROR` spends an attempt and excludes a provider.
 */
@Injectable()
export class ProviderRouterService {
  private readonly logger = new Logger(ProviderRouterService.name);

  constructor(
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistryPort,
    @Inject(PROVIDER_STAKE_SOURCE) private readonly stakes: ProviderStakePort,
    // Which chains each provider actually holds an ACTIVE
    // enrolment on — the narrowing applied to the binding's own declaration
    // before any gate sees it. Read here rather than trusted off the binding
    // because a binding's chain list is config the provider wrote, and an
    // enrolment can be closed afterwards without anybody touching it.
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
    @Inject(STAKE_GRACE_SOURCE) private readonly grace: StakeGracePort,
    @Inject(BINDING_INVOKER) private readonly invoker: BindingInvokerPort,
    // The two traffic counters. Concrete classes rather than ports because they
    // live in this module: `PROVIDER_REGISTRY` and friends are tokens because
    // they cross a module boundary the router must not look past, and inventing
    // a token for a neighbour would be ceremony that hides where the code is.
    // `McpToolCallService` already injects the counter this way.
    private readonly bindingCalls: BindingCallCounterService,
    private readonly ceilings: BindingCeilingService,
    @Inject(ROUTER_CONFIG) private readonly config: RouterConfig,
    @Inject(ROUTING_RANDOM) private readonly random: RoutingRandom,
  ) {}

  /**
   * Route one tool call, failing over as far as the policy allows.
   *
   * Resolves for every outcome the *provider* produced, including a
   * `REQUEST_ERROR` — the agent needs to be told its arguments were rejected,
   * and an exception would be a worse way to say so than a classified result.
   *
   * Rejects in exactly two cases, both of which mean no provider outcome
   * exists: nothing was routable in the first place
   * (`TOOL_NO_ELIGIBLE_BINDING`), or everything routable returned
   * `SYSTEM_ERROR` (`TOOL_ALL_BINDINGS_FAILED`). Neither settles a payment and
   * neither is reachable by any provider's stake.
   */
  async route(request: ToolCallRequest): Promise<RoutedCall> {
    const tool = await this.catalogue.findTool(request.toolId);
    if (!tool) {
      throw ToolErrors.toolNotFound({ toolId: request.toolId });
    }

    const candidates = await this.gatherCandidates(request.toolId);
    if (candidates.length === 0) {
      throw ToolErrors.noEligibleBinding({
        toolId: request.toolId,
        reason: 'the tool has no bindings',
      });
    }

    const deadline = Date.now() + this.config.totalDeadlineMs;
    // Taken as given. The chain sets are *supplied by the payment
    // module, never inferred by the router* — a router that could invent one
    // is a router that can fail open on the one gate whose job is to refuse.
    const routing = request.context;
    const excluded = new Set(routing.excludeProviderIds ?? []);
    let settlementChain: ChainId | null = null;
    const attempts: RoutingAttempt[] = [];

    // Bindings whose token could not be taken, per request. Separate from
    // `excluded` because a ceiling belongs to one endpoint and failover belongs
    // to an operator — see the class doc. It only ever grows within a request,
    // which is what bounds the reservation loop.
    const shed = new Map<string, CeilingKind>();

    // Read once for the whole call, not once per attempt. `domain/routing/`
    // reads no clock — `applyStakeGrace` takes `now` as a parameter so a
    // decision replays from its recorded inputs — so the service supplies it,
    // and it supplies the *same* instant to every failover attempt. A grace
    // period that expired between attempt one and attempt three would otherwise
    // change the candidate set mid-call, and the receipt would describe a
    // routing decision that was never made as a whole.
    const now = new Date();

    for (let attempt = 0; attempt < this.config.maxAttempts; attempt += 1) {
      // Checked BEFORE a token is reserved as well as after. What a ceiling
      // bounds is calls actually delivered to a provider's endpoint, so taking
      // a token and then discovering the request's own budget is gone would
      // debit a provider for a call nobody made. The check below is still
      // needed: reserving is a network round trip and the budget can run out
      // inside it.
      if (deadline - Date.now() <= 0) {
        throw allBindingsFailed(
          request.toolId,
          attempts,
          `total deadline of ${this.config.totalDeadlineMs}ms spent`,
        );
      }

      const {
        picked: selection,
        rejected,
        ruleRejected,
        fellBack,
        settlementChainOf,
      } = await this.selectAndReserve(
        candidates,
        { ...routing, excludeProviderIds: [...excluded] },
        shed,
        now,
      );

      if (!selection) {
        // No candidate survived the gates. Which error that is depends
        // entirely on whether we have tried anything yet — see the two codes'
        // doc comments; one is a supply problem and one is an outage.
        if (attempts.length === 0) {
          throw unroutable(request.toolId, rejected, routing, ruleRejected);
        }

        throw allBindingsFailed(
          request.toolId,
          attempts,
          'failover exhausted every remaining provider',
        );
      }

      const binding = selection.candidate.binding;
      // Read off the decision that admitted this candidate, never re-derived.
      // Both gates ran against this chain; the payee below is looked up under
      // it; and it is what the caller stamps on the payment intent.
      settlementChain = settlementChainOf.get(binding.id);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw allBindingsFailed(
          request.toolId,
          attempts,
          `total deadline of ${this.config.totalDeadlineMs}ms spent`,
        );
      }

      // The attempt never gets more than what is left of the request's total
      // budget. Without the clip, `maxAttempts × timeoutMs` would be the real
      // ceiling and `totalDeadlineMs` would be decorative.
      const timeoutMs = Math.min(binding.timeoutMs, remainingMs);
      const startedAt = Date.now();
      const outcome = await this.attempt(tool, binding, request.input, timeoutMs, request.callId);

      const record: RoutingAttempt = {
        bindingId: binding.id,
        providerId: binding.providerId,
        callId: request.callId,
        weight: selection.weight,
        score: selection.score,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
        classification: outcome.classification,
      };
      attempts.push(record);

      if (!isRetryable(outcome.classification.responseClass)) {
        return {
          tool,
          binding,
          providerId: binding.providerId,
          // From the candidate that *won*, not from a fresh registry read: the
          // failover path can leave `selection` pointing at the third provider
          // tried, and the payee has to be that one's.
          // The address is looked up under the chain the gates just ran on.
          // Never the map's first entry: a provider enrolled on two chains has
          // two, and the wrong one is a payee the settling chain cannot see.
          //
          // **Site 3 of 5, expression 1 of 2** in the settlement-chain
          // enumeration in `tool/domain/routing/eligibility.ts`, MOVED. It read
          // `chainIdOf(binding.assetId)` — the chain the price is quoted in —
          // and it was the easiest of the seven to leave behind, because it
          // does not call `evaluatePayoutGate` and so does not appear in a
          // search for that. Leaving it would have been the worst of them: the
          // gate approves the candidate for one chain and this line stamps the
          // intent with another chain's address, which
          // `chk_payment_intents_settled_names_payee` then refuses at the
          // SETTLED edge, after the call has been served.
          providerAccount: payoutAccountOn(selection.candidate.provider, settlementChain),
          settlementChain,
          callId: request.callId,
          classification: outcome.classification,
          response: outcome.response,
          output: outcome.output,
          attempts,
          // FALLBACK_BEST dropped the toolset entry's preferences to serve
          // this call; the receipt says so.
          ...(fellBack ? { fellBack: true } : {}),
        };
      }

      this.logger.warn(
        `${tool.id}: binding ${binding.id} (provider ${binding.providerId}) → ` +
          `${outcome.classification.responseClass}/${outcome.classification.reason}; failing over`,
      );
      excluded.add(binding.providerId);
    }

    throw allBindingsFailed(
      request.toolId,
      attempts,
      `attempt cap of ${this.config.maxAttempts} reached`,
    );
  }

  /**
   * What this tool costs and what to expect from it, without calling anything.
   *
   * The MCP server publishes this in `tools/list` so an agent decides
   * affordability *before* spending, which is the platform's first principle
   * and not a convenience. It runs the same gates as {@link route} — same
   * catalogue, same registry, same stake floor — because a price quoted from a
   * binding that routing would refuse is a price the agent cannot actually buy
   * at.
   *
   * ## Why the quote is the **dearest** eligible binding
   *
   * Any eligible binding may take the call, and failover means the one that
   * answers may be the third one drawn. Quoting an average or the cheapest
   * would produce calls that cost more than the agent was shown, which is the
   * exact surprise the annotation exists to prevent. The quote is therefore the
   * **upper bound**: the agent is held for it and is never charged more.
   *
   * It is not what the agent pays. The buyer pays the price of the binding that
   * actually served: rail A re-prices the intent from `RoutedCall.binding` when
   * the call leaves `PROVIDER_EXECUTING` (capped at the hold) and settlement
   * returns the rest of the hold, and rail B signs the offered binding's own
   * price ({@link offer}). The cheaper provider is credited its own price, not
   * the dearest one.
   *
   * `FREE` bindings are left out of a paid quote's price: a paid call is never
   * routed to one (`RoutingContext.callClass`), so they are not part of what
   * the agent can be charged.
   *
   * ## Why the statistics are traffic-weighted
   *
   * `x402/p95LatencyMs` and `x402/qualityRate` are published as the platform's
   * measured figures *for the tool*, over every provider behind it. A plain
   * mean would describe a provider that takes 2% of the traffic exactly as
   * loudly as one that takes 60%. The weights used here are the ones routing
   * would actually draw against, so the published figure is what an agent
   * should expect from calling this endpoint rather than a property of the
   * supplier list.
   *
   * Both are `null` when nothing has been measured. The router writes no
   * reputation, so today they are whatever the config stand-in was seeded with,
   * and `null` is the honest answer for a tool nobody has scored.
   */
  async quote(toolId: string, context: RoutingContext): Promise<ToolQuote | null> {
    const tool = await this.catalogue.findTool(toolId);
    if (!tool) return null;

    return this.quoteFromCandidates(tool, await this.gatherCandidates(toolId), context);
  }

  /**
   * Every candidate behind a tool, gathered exactly as a call gathers them —
   * the I/O half of {@link quote}, which the quote index caches so that
   * `tools/list` never reads the registry or the chain per tool.
   */
  async snapshotCandidates(toolId: string): Promise<RoutingCandidate[]> {
    return this.gatherCandidates(toolId);
  }

  /**
   * {@link quote} over candidates already gathered: pure, so the quote index
   * can price a listing under each viewer's own rules from one snapshot.
   *
   * The buyer's rules (`context.rules`) are applied before the gates, the
   * same way {@link select} applies them, and FALLBACK_BEST is honoured the
   * same way. A quote the rules empty has no price and carries the rule
   * rejections, which is "No provider fits your limits" to the caller.
   */
  quoteFromCandidates(
    tool: Tool,
    candidates: readonly RoutingCandidate[],
    context: RoutingContext,
  ): ToolQuote {
    const ruled = this.eligibleUnderRules(candidates, context, new Date());
    if (ruled.eligible.length === 0) {
      return {
        tool,
        price: null,
        pricingMode: null,
        routableBindings: 0,
        settlementChains: [],
        p95LatencyMs: null,
        qualityRate: null,
        unroutableReason: summariseRejections(ruled.rejected, ruled.ruleRejected),
        ...(ruled.ruleRejected.length > 0
          ? { ruleRejections: ruled.ruleRejected.map(toRuleRejectionDetail) }
          : {}),
      };
    }

    return this.priceEligible(tool, ruled.eligible, context, ruled.fellBack);
  }

  /**
   * The rules, then the gates, then grace — with FALLBACK_BEST re-running the
   * gates under the agent's rules alone when the entry's left nothing.
   */
  private eligibleUnderRules(
    candidates: readonly RoutingCandidate[],
    context: RoutingContext,
    now: Date,
  ): EligibleUnderRules {
    const first = this.eligibleUnder(candidates, context, context.rules, now);
    if (first.eligible.length > 0 || !fallsBack(context.rules)) return first;

    const fallback = this.eligibleUnder(
      candidates,
      context,
      withoutEntryPreferences(context.rules as RoutingRules),
      now,
    );
    return fallback.eligible.length > 0 ? { ...fallback, fellBack: true } : fallback;
  }

  private eligibleUnder(
    candidates: readonly RoutingCandidate[],
    context: RoutingContext,
    rules: RoutingRules | undefined,
    now: Date,
  ): EligibleUnderRules {
    const { kept, rejected: ruleRejected } = applyRules(candidates, rules);
    const { eligible, rejected, settlementChainOf } = reinstateGraced(
      kept,
      filterEligible(kept, this.config.minimumStakeByChain, context),
      now,
    );
    return { eligible, rejected, settlementChainOf, ruleRejected, fellBack: false };
  }

  private priceEligible(
    tool: Tool,
    eligible: readonly RoutingCandidate[],
    context: RoutingContext,
    fellBack: boolean,
  ): ToolQuote {
    // Same two steps as {@link select}, in the same order, through the same
    // helper. That is the whole reason `reinstateGraced` is a function rather
    // than three lines inlined into selection: a quote that called only
    // `filterEligible` would tell an agent a tool is unavailable while routing
    // was serving it from a binding inside its grace period — a disagreement
    // whose first symptom is a provider asking why their quote and their
    // traffic say different things.
    // `gatherCandidates` has already loaded `ceilingHit`, so a binding at its
    // declared ceiling drops out of the quote exactly as it drops out of
    // routing. That agreement is the point: a quote that named a price from a
    // binding routing would refuse is a price the agent cannot buy at, and the
    // first symptom is a provider asking why their quote and their traffic
    // disagree.
    //
    // Nothing is CONSUMED here, and that is not an omission. A quote is a price
    // question, not a call — `tools/list` is published to every connected agent
    // and answered far more often than anything is invoked, so spending a token
    // per quote would drain a provider's declared allowance on traffic that
    // never reaches their endpoint. `consume` is called from
    // {@link selectAndReserve} and nowhere else.
    const weighted = computeWeights(scoreCandidates(eligible, this.config.weights));

    // The union over the routable set, for the caller to render against the
    // buyer's own chains. A quote is NOT filtered by them: a tool the
    // buyer cannot pay for must be SHOWN, marked as settling elsewhere —
    // hiding it makes the platform look like it lacks the tool.
    const settlementChains = [
      ...new Set(eligible.flatMap((candidate) => settleableChains(candidate, context))),
    ];
    const priced = pricedOnQuotedChain(eligible, settlementChains, context);
    const pricingMode = quotedPricingMode(priced);
    const chargeable = priced.filter(({ binding }) => binding.pricingMode !== PricingMode.FREE);

    return {
      tool,
      price: dearestPrice(
        pricingMode === PricingMode.FREE
          ? priced
          : priced.filter(({ binding }) => binding.pricingMode !== PricingMode.FREE),
      ),
      pricingMode,
      routableBindings: eligible.length,
      paidBindings: priced.filter(({ binding }) => binding.pricingMode !== PricingMode.FREE).length,
      freeBindings: eligible
        .filter(({ binding }) => binding.pricingMode !== PricingMode.PAID)
        .map(({ binding }) => ({
          freeQuotaPerAgent: binding.freeQuotaPerAgent ?? null,
          freeDailyBudget: binding.freeDailyBudget ?? null,
        })),
      settlementChains,
      p95LatencyMs: weightedMean(weighted, (c) => c.provider.stats.p95LatencyMs),
      qualityRate: weightedMean(weighted, (c) =>
        c.binding.pricingMode === PricingMode.FREE
          ? c.provider.stats.freeQualityRate
          : c.provider.stats.paidQualityRate,
      ),
      unroutableReason: null,
      cheapestPrice: chargeable.length > 0 ? cheapestPrice(chargeable) : null,
      ...(fellBack ? { fellBack: true } : {}),
    };
  }

  /**
   * The provider a call WOULD be routed to, without dialling it — rail B's
   * first half.
   *
   * A voucher names its payee inside the signed bytes, so a buyer paying on
   * rail B must be told who the payee is before it signs. This is the same
   * draw {@link route} makes — same candidates, same gates, same weights —
   * minus the ceiling token: an offer is not a delivered call, and taking a
   * token for one would debit a provider for a request that may never come.
   * The retry that spends the voucher pins this provider with
   * `onlyProviderId`, and routing then takes the token for real.
   *
   * It also carries the offered binding's **own** price, not the quote: the
   * voucher is signed for an exact amount and pays this provider and no other,
   * so the buyer is asked for what this provider charges. It is drawn from the
   * same eligible set the quote takes its dearest price from, and the buyer
   * signs the exact figure, so it is never more than the buyer agreed to.
   *
   * Refuses exactly as the first attempt of {@link route} would.
   */
  async offer(toolId: string, context: RoutingContext): Promise<RoutingOffer> {
    const candidates = await this.gatherCandidates(toolId);
    const { picked, rejected, ruleRejected, fellBack, settlementChainOf } = this.select(
      candidates,
      context,
      new Date(),
    );
    if (!picked) throw unroutable(toolId, rejected, context, ruleRejected);

    const settlementChain = settlementChainOf.get(picked.candidate.binding.id);
    return {
      providerId: picked.candidate.binding.providerId,
      providerAccount: payoutAccountOn(picked.candidate.provider, settlementChain),
      settlementChain,
      price: bindingPrice(picked.candidate.binding),
      ...(fellBack ? { fellBack: true } : {}),
    };
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  /**
   * Eligibility → score → weights → one weighted draw.
   *
   * Separated from {@link route} because it is the part with no I/O: given the
   * same candidates, context and random sequence it returns the same binding,
   * which is what makes the traffic-distribution claim testable and a past
   * decision replayable.
   *
   * The rejections come back with the pick rather than being stashed on the
   * service. This is a singleton serving concurrent tool calls, and a field
   * holding "why the last selection failed" would be read by whichever request
   * happened to `await` next — putting one agent's rejection reasons in another
   * agent's error message.
   *
   * `now` is threaded in rather than read here, because this method is the pure
   * part and a function that called `new Date()` would answer a different
   * question on every run.
   */
  private select(
    candidates: readonly RoutingCandidate[],
    context: RoutingContext,
    now: Date,
  ): Selection {
    // Rail B's pin, applied before the gates so a pinned provider is judged by
    // exactly the rules any other call would judge it by — and so no other
    // provider can be drawn, on the first attempt or on any failover.
    //
    // The call class narrows the same way and for the same reason: a paid call
    // never reaches a `FREE` binding (which no stake or payout gate checked),
    // and a free call never reaches a `PAID` one (whose provider it cannot pay).
    // Dropped from the pool rather than rejected, so a refusal names the
    // reasons the remaining supply failed rather than the other class's.
    //
    // The buyer's rules run on that pool, before the gates, and the same way
    // in both payment phases: `offer()` draws under them, and the voucher
    // retry's pool is `onlyProviderId ∩ allowProviderIds` minus the rule
    // exclusions. A pinned payee the rules now drop is
    // `PAYEE_NO_LONGER_ELIGIBLE` (see `unroutable`).
    const pool = candidates.filter(
      (candidate) =>
        (!context.onlyProviderId || candidate.binding.providerId === context.onlyProviderId) &&
        servesCallClass(candidate.binding, context.callClass),
    );
    const { eligible, rejected, ruleRejected, fellBack, settlementChainOf } =
      this.eligibleUnderRules(pool, context, now);

    if (eligible.length === 0) {
      return { picked: null, rejected, ruleRejected, fellBack, settlementChainOf };
    }

    const scored = scoreCandidates(eligible, this.config.weights);
    const weighted = computeWeights(scored, this.config.maxProviderShare);
    return {
      picked: pickWeighted(weighted, this.random),
      rejected,
      ruleRejected,
      fellBack,
      settlementChainOf,
    };
  }

  /**
   * {@link select}, then take the one token the selected binding needs.
   *
   * This is the only place `BindingCeilingService.consume` is called, and it is
   * called **once, after the draw, on the binding that is about to be dialled**
   * — never at filter time, and never per candidate. Spending per candidate
   * compiles, sheds traffic, and passes a check that traffic sheds, while
   * quietly holding a provider who declared `max_rps: 10`
   * behind a five-binding tool to two: every binding is debited for calls that
   * went somewhere else. Such a check asks whether traffic sheds, never at
   * what threshold, so nothing would have reported it.
   *
   * A refusal here is the race this code accepts rather than locks against:
   * the bucket emptied between `readAll` and this call. `consume` returns the
   * same {@link CeilingKind} the filter would have, so the binding joins `shed`
   * and the draw runs again over what is left — which is exactly what a
   * filter-time hit produces, and is deliberately **not** an attempt, an error,
   * or a mark against the provider.
   *
   * The loop terminates because every pass either returns or adds a binding to
   * `shed`, and a shed binding is refused by `filterEligible` on the next pass.
   * The bound is stated as the candidate count rather than left implicit, so a
   * future `consume` that could refuse the same binding twice fails the request
   * instead of spinning on the path an agent is blocked on.
   */
  private async selectAndReserve(
    candidates: readonly RoutingCandidate[],
    context: RoutingContext,
    shed: Map<string, CeilingKind>,
    now: Date,
  ): Promise<Selection> {
    let last: Selection = {
      picked: null,
      rejected: [],
      ruleRejected: [],
      fellBack: false,
      settlementChainOf: new Map(),
    };

    for (let pass = 0; pass <= candidates.length; pass += 1) {
      const selection = this.select(withShed(candidates, shed), context, now);
      last = selection;
      const { picked } = selection;
      if (!picked) return { ...selection, picked: null };

      const binding = picked.candidate.binding;
      // A free call's quota first: a binding with no room for this agent is
      // shed before it costs the provider a ceiling token.
      const place = context.reserveFreeQuota ? await context.reserveFreeQuota(binding) : null;
      if (context.reserveFreeQuota && place === null) {
        shed.set(binding.id, CeilingKind.FREE_QUOTA);
        continue;
      }
      const refused = await this.ceilings.consume(binding);
      if (refused === null) return selection;
      await place?.release();

      this.logger.debug(
        `binding ${binding.id} (provider ${binding.providerId}) reached its declared ` +
          `${refused} ceiling between the read and the reservation; shedding`,
      );
      shed.set(binding.id, refused);
    }

    return { ...last, picked: null };
  }

  /**
   * Join the catalogue to the registry, the stake source, the grace table, the
   * call counter and the ceilings.
   *
   * All five reads are batched — over the distinct provider ids for the first
   * two, over the bindings for the rest — once per tool call rather than once
   * per candidate, and issued together rather than in sequence. The
   * stake read is an RPC to chain state, and a per-candidate loop would
   * turn one routing decision into N sequential network round-trips on the path
   * an agent is blocked on. `observedCallsAll` and `readAll` exist for exactly
   * that reason and are used here rather than looped over.
   *
   * The grace read is one statement against `provider_stake_grace` and is
   * served by `uq_provider_stake_grace_open` as an index-only scan — that
   * partial index (`WHERE resolved_at IS NULL`) *is* this lookup, which is why
   * the source's predicate is written to match it and nothing more. In
   * particular it does not filter on `expires_at`: an open row past its
   * deadline is what makes `STAKE_GRACE_EXPIRED` reachable, and the comparison
   * against `now` belongs to `applyStakeGrace`, where it is pure.
   */
  private async gatherCandidates(toolId: string): Promise<RoutingCandidate[]> {
    const bindings = await this.catalogue.findBindings(toolId);
    if (bindings.length === 0) return [];

    const providerIds = [...new Set(bindings.map((b) => b.providerId))];

    const [states, enrolments, graceUntil, observed, ceilingHits] = await Promise.all([
      this.registry.findRoutingStates(providerIds),
      this.enrolments.enrolmentsOf(providerIds),
      this.grace.openGraceUntil(
        bindings.map((b) => ({ bindingId: b.id, providerId: b.providerId })),
      ),
      this.bindingCalls.observedCallsAll(bindings.map((b) => b.id)),
      this.ceilings.readAll(bindings),
    ]);

    // The binding's declaration, narrowed to the chains its provider actually
    // holds an ACTIVE enrolment on. This is a fact about CONFIGURATION on both
    // sides and it is deliberately NOT where the stake check lives: folding
    // stake in here would relabel every shortfall as `CHAIN_NOT_SETTLEABLE` — a
    // buyer-shaped code — and hide it from the provider who can fix it in
    // minutes. See `routing-chains.spec.ts`.
    const settlementChainsOf = new Map<string, readonly ChainId[]>(
      bindings.map((binding) => [
        binding.id,
        (binding.settlementChains ?? []).filter((chainId) => {
          const enrolment = enrolments.get(enrolmentKey(binding.providerId, chainId));
          return enrolment?.status === ChainEnrolmentStatus.ACTIVE;
        }),
      ]),
    );

    // **Site 3 of 5, expression 2 of 2** in the settlement-chain enumeration in
    // `tool/domain/routing/eligibility.ts`, MOVED: the keys are the
    // `(provider, chain)` pairs that survived the narrowing above, not
    // `chainIdOf(binding.assetId)`. One key per DISTINCT pair the candidate set
    // actually contains — not the cross product of providers and chains, and
    // not one key per binding. The answers are independent and neither
    // may stand in for the other.
    //
    // Deriving ONE chain here for the whole candidate set (the first binding's,
    // say) would leave every binding on any other chain permanently
    // `STAKE_UNKNOWN` however well its provider is bonded there: a routing
    // outage for the second chain, which is the thing per-chain stake exists to prevent.
    // `test/unit/tool/stake-per-chain.spec.ts` pins it by asserting WHY the
    // unfunded binding lost, not only which one won.
    //
    // Issued after the wave above rather than inside it, because the pairs are
    // not known until the enrolments are. Still ONE batched call, not one per
    // candidate.
    const stakes = await this.stakes.stakeOn(
      dedupe(
        bindings.flatMap((binding) =>
          (settlementChainsOf.get(binding.id) ?? []).map((chainId) => ({
            providerId: binding.providerId,
            chainId,
          })),
        ),
      ),
    );

    // The flat `stakeKey` map, re-shaped per provider so a candidate carries
    // every chain that provider was read on rather than only its own binding's.
    // The gate asks for one chain and gets a refusal when it is absent, so the
    // extra entries change no decision — what they buy is that a candidate is
    // the same value whichever binding it was built for, which is what lets a
    // routing decision be replayed months later from its recorded inputs.
    const stakeByProvider = new Map<string, Map<ChainId, ProviderStake>>();
    for (const reading of stakes.values()) {
      const byChain = stakeByProvider.get(reading.providerId) ?? new Map();
      byChain.set(reading.chainId, reading);
      stakeByProvider.set(reading.providerId, byChain);
    }

    return bindings.map((binding) => ({
      binding,
      provider: states.get(binding.providerId) ?? unknownProvider(),
      settlementChains: settlementChainsOf.get(binding.id) ?? [],
      stakeByChain: stakeByProvider.get(binding.providerId) ?? EMPTY_STAKE_BY_CHAIN,
      // Keyed by BINDING, not by provider: the floor is
      // `max(floor, priceMultiple × price)`, so one provider is simultaneously
      // above it for a cheap binding and below it for an expensive one, and a
      // provider-level date would have to be wrong about one of them.
      stakeGraceUntil: graceUntil.get(binding.id) ?? null,
      // A missing entry and an unreadable count collapse to the same `null`,
      // and that is the fail-CLOSED direction here: `isExploring` excludes
      // `null` from the exploration set, so a counter outage withdraws the
      // floor rather than handing every binding on the platform a new
      // binding's allowance at once. `0` would be the permissive value, which
      // is why it must never be used as the placeholder.
      observedCalls: observed.get(binding.id) ?? null,
      // The opposite direction, for the opposite reason. `readAll` only reports
      // bindings that ARE at a ceiling, so absent means headroom — and an
      // unreadable Redis permits, because shedding every ceiling-declaring
      // binding on the platform would concentrate all traffic onto the ones
      // that declared nothing and could take the supply out.
      ceilingHit: ceilingHits.get(binding.id) ?? null,
    }));
  }

  // ── One attempt ───────────────────────────────────────────────────────────

  /**
   * Call one binding, classify what came back, and map it into the tool
   * contract if it is a `DATA_RESULT`.
   *
   * Response mapping happens *here*, inside the attempt, and not in the caller.
   * It has to: a mapping failure attributed to `PLATFORM` is a `SYSTEM_ERROR`
   * — our selector pointed at a field this provider never had — and a
   * `SYSTEM_ERROR` is precisely the thing another provider is likely to serve
   * correctly. Mapping outside the loop would mean discovering that after the
   * failover opportunity had passed, and returning our own bug to the agent as
   * a failed tool call.
   */
  private async attempt(
    tool: Tool,
    binding: ToolBinding,
    input: JsonObject,
    timeoutMs: number,
    callId: string,
  ): Promise<AttemptOutcome> {
    let response: ProviderResponse;

    try {
      response = await this.withDeadline(
        this.invoker.invoke({ tool, binding, input, timeoutMs, callId }),
        timeoutMs,
      );
    } catch (error) {
      // A mapping fault carries its own attribution and must not be read as a
      // transport failure — `AGENT` in particular, which is a `REQUEST_ERROR`
      // and must not trigger failover. It also means no call was made, so the
      // recorded response carries no `transportError`: inventing one would put
      // a socket failure on a provider's availability record for a request that
      // never left this process.
      const fault = mappingFaultOf(error);
      if (fault) {
        return {
          response: { status: 0, body: { kind: ResponseBodyKind.EMPTY } },
          classification: classifyMappingFault(fault),
          output: null,
        };
      }

      return {
        response: failedResponse(error),
        classification: this.asTransportFailure(error, binding),
        output: null,
      };
    }

    const classification = classifyResponse(
      response,
      // No policy storage yet — `ClassificationPolicy` is a type with no table
      // and no editor, so every tool runs on defaults; there is nowhere yet for
      // a tool owner to declare `dataResultStatuses: [404]`.
      { toolId: tool.id },
      { nowMs: Date.now() },
    );

    if (classification.responseClass !== ResponseClass.DATA_RESULT) {
      return { response, classification, output: null };
    }

    return this.mapIntoContract(tool, binding, response, classification);
  }

  private mapIntoContract(
    tool: Tool,
    binding: ToolBinding,
    response: ProviderResponse,
    classification: Classification,
  ): AttemptOutcome {
    // Only a JSON body reaches here: the classifier's body gate has already
    // sent an empty or non-JSON body to `SYSTEM_ERROR`, and this narrowing
    // documents that dependency rather than re-checking it.
    if (response.body.kind !== ResponseBodyKind.JSON) {
      return { response, classification, output: null };
    }

    try {
      const output = mapResponse(binding.responseMapping, response.body.value, {
        outputSchema: tool.outputSchema,
        context: { toolId: tool.id, bindingId: binding.id, providerId: binding.providerId },
      });
      return { response, classification, output };
    } catch (error) {
      const fault = mappingFaultOf(error);
      if (!fault) throw error;

      // `PLATFORM` → SYSTEM_ERROR → the loop fails over. `PROVIDER` →
      // DATA_RESULT with no output: the provider returned data and the data did
      // not honour the contract, which is verification's question, not
      // routing's.
      return { response, classification: classifyMappingFault(fault), output: null };
    }
  }

  /**
   * The timeout, enforced by the router.
   *
   * The invoker is told the same figure and is expected to abort its own
   * socket at it — that is the enforcement that actually frees the connection.
   * This race is the backstop: provider calls run on a
   * worker with a bounded slot count, and an invoker that ignored its budget
   * (a bug, a client whose timer does not cover DNS, an adapter someone adds
   * later) would occupy a slot indefinitely. A caller is blocked on this; the
   * one outcome that is not acceptable is not returning.
   *
   * The losing promise is not cancelled — nothing in Node can cancel a promise
   * — so a late response is discarded. `Promise.race` keeps a handler attached
   * to it, so a late *rejection* is still handled and does not surface as an
   * unhandled rejection.
   */
  private withDeadline(
    work: Promise<ProviderResponse>,
    timeoutMs: number,
  ): Promise<ProviderResponse> {
    let timer: NodeJS.Timeout;

    const guard = new Promise<ProviderResponse>((resolve) => {
      timer = setTimeout(() => resolve(timedOutResponse(timeoutMs)), timeoutMs);
    });

    return Promise.race([work, guard]).finally(() => clearTimeout(timer));
  }

  private asTransportFailure(error: unknown, binding: ToolBinding): Classification {
    const transportError = classifyTransportError(error);
    this.logger.warn(`binding ${binding.id} threw: ${transportError.detail}`);
    return {
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: TRANSPORT_REASON[transportError.kind],
      detail: transportError.detail,
      retryAfterMs: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
  readonly toolId: string;
  /** The agent's arguments, before `requestMapping` runs. */
  readonly input: JsonObject;
  /**
   * The value sent upstream as `X-Assay-Call-Id`. Minted once by the
   * caller for the whole call, not per attempt — see `BindingInvocation.callId`
   * for why, and why it is required rather than optional here too: an
   * optional field the router could invent a fallback for is exactly the
   * gap that would let the id on the wire drift from the one recorded on the
   * payment intent.
   */
  readonly callId: string;
  /**
   * Who is asking and what they can pay with.
   *
   * **Required.** The chain sets are *supplied by the payment module, never
   * inferred by the router*, and an optional field is an inference with a
   * nicer name: defaulting `payerChains` to "everything" fails open on the one
   * gate whose job is to refuse, and defaulting it to `[]` refuses everything
   * and would be found in staging rather than in review.
   */
  readonly context: RoutingContext;
}

/** One binding attempt, kept for the receipt and for the alert. */
/**
 * `TOOL_ALL_BINDINGS_FAILED`, carrying the last classified attempt.
 *
 * Every attempt behind this error was dialled and answered `SYSTEM_ERROR`, so
 * the caller is not looking at a call that "never reached" a provider: it can
 * void the intent with that class and name what was tried. `lastAttempt` is
 * `undefined` when the deadline ran out before anything was dialled. It is the
 * caller's to read and strip — the binding id is routing detail, not something
 * the agent-facing error carries.
 */
function allBindingsFailed(toolId: string, attempts: readonly RoutingAttempt[], detail: string) {
  const last = attempts[attempts.length - 1];
  return ToolErrors.allBindingsFailed({
    toolId,
    attempts: attempts.length,
    detail,
    lastAttempt: last
      ? {
          bindingId: last.bindingId,
          providerId: last.providerId,
          responseClass: last.classification.responseClass,
        }
      : undefined,
  });
}

export interface RoutingAttempt {
  readonly bindingId: string;
  readonly providerId: string;
  /** The `X-Assay-Call-Id` this attempt carried — the same value on every attempt of one call. */
  readonly callId: string;
  /** The share of traffic this binding held at the moment it was drawn. */
  readonly weight: number;
  readonly score: number;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly classification: Classification;
}

/**
 * What a tool costs and what it is worth, before anything is called.
 *
 * `price` is `null` exactly when `routableBindings` is 0 — a tool with no
 * routable supply has no price, and publishing its last known one would
 * advertise something no agent can buy. `unroutableReason` says which gate
 * emptied it, so "nobody has registered for this tool" and "every provider is
 * under-staked this morning" are distinguishable from outside.
 */
export interface ToolQuote {
  readonly tool: Tool;
  /**
   * The dearest price among the eligible bindings that settle on the chain
   * this buyer's call would settle on — the worst case the agent is held for,
   * in that chain's asset, and so the most it can be charged. The charge itself
   * is the serving binding's own price. See `pricedOnQuotedChain`.
   */
  readonly price: Money | null;
  /**
   * `FREE` when no eligible binding can be charged, `PAID` when none can serve
   * a free call, else `FREEMIUM` — free first, inside the agent's quota, then
   * paid. See `quotedPricingMode`.
   */
  readonly pricingMode: PricingMode | null;
  readonly routableBindings: number;
  /**
   * How many of the priced bindings can be CHARGED (`PAID` or `FREEMIUM`) —
   * what "up to $X" is about: a `FREE` binding beside one paid binding does
   * not make the paid price a range (review 2026-10-15, L2). Absent on a
   * quote with no routable supply.
   */
  readonly paidBindings?: number;
  /**
   * The published free dials of every routable free-capable (`FREE` or
   * `FREEMIUM`) binding — what `freeCallsPerDay` sums. Absent on a quote with
   * no routable supply.
   */
  readonly freeBindings?: readonly FreeBindingDials[];
  /**
   * Every chain a routable binding of this tool could settle on, for the caller
   * to render against the buyer's own chains. Empty when none.
   *
   * A quote is deliberately **not** filtered by the buyer's chains: the
   * catalogue must SHOW a tool the buyer cannot pay for, marked *"settles on
   * Robinhood Chain — you have no funds there"*, because *"hiding it makes the
   * platform look like it lacks the tool."*
   */
  readonly settlementChains: readonly ChainId[];
  /** Traffic-weighted across eligible bindings. `null` when nothing is measured. */
  readonly p95LatencyMs: number | null;
  readonly qualityRate: number | null;
  /** Why there is no price, or `null` when there is one. */
  readonly unroutableReason: string | null;
  /**
   * The cheapest chargeable binding left under the rules, for the "From $X"
   * line of a listing. `null` when every binding left is FREE; absent on a
   * quote with no routable supply.
   */
  readonly cheapestPrice?: Money | null;
  /**
   * What the buyer's rules dropped, on a quote they emptied: the price is then
   * `null` and the listing says "No provider fits your limits".
   */
  readonly ruleRejections?: readonly RuleRejectionDetail[];
  /** FALLBACK_BEST was applied to price this. */
  readonly fellBack?: boolean;
}

/** One provider the rules dropped, as a refusal or a listing reports it (FR-6). */
export interface RuleRejectionDetail {
  readonly providerId: string;
  readonly reason: RuleRejectionReason;
  readonly source: RuleRejection['source'];
  readonly detail: string;
  /** On `PAYEE_NO_LONGER_ELIGIBLE`, the rule the pinned payee now fails. */
  readonly rule?: RuleRejectionReason;
}

export interface RoutedCall {
  readonly tool: Tool;
  readonly binding: ToolBinding;
  readonly providerId: string;
  /**
   * The CAIP-10 account a settled call must credit — the payout address
   * `providerId` had proved **at the moment this call was served**.
   *
   * Carried out of routing rather than looked up at settlement time, and the
   * difference is money: verification runs asynchronously, so a provider who
   * re-proves a different address between the call and its verdict would
   * otherwise be paid at whichever address is current when the worker gets
   * round to it. The payee is a fact about the call, and this is where the call
   * happened.
   *
   * `null` only for a `FREE` binding, which `evaluatePayoutGate` exempts
   * because the relay path never creates a payment intent. Every candidate that
   * could be charged was refused eligibility without one.
   */
  readonly providerAccount: AccountId | null;
  /**
   * The chain this call settles on, chosen by `chooseSettlementChain`.
   *
   * The same value both gates ran against and the same one `providerAccount`
   * was looked up under — carried out of the decision rather than re-derived,
   * for the reason the payee is: a caller that worked it out again could stamp
   * the intent with a chain the gates never approved.
   */
  readonly settlementChain: ChainId;
  /** The `X-Assay-Call-Id` sent to `providerId` — see `ToolCallRequest.callId`. */
  readonly callId: string;
  readonly classification: Classification;
  readonly response: ProviderResponse;
  /**
   * The response mapped into the tool's `outputSchema`, or `null` when there is
   * nothing to hand the agent — any class other than `DATA_RESULT`, and a
   * `DATA_RESULT` whose payload did not survive the mapping.
   */
  readonly output: JsonValue | null;
  /** Every attempt, in order. The last one is the outcome above. */
  readonly attempts: readonly RoutingAttempt[];
  /** True when FALLBACK_BEST dropped the toolset entry's preferences to serve this. */
  readonly fellBack?: boolean;
}

/** Who {@link ProviderRouterService.offer} would route to, where it settles, and at what price. */
export interface RoutingOffer {
  readonly providerId: string;
  readonly providerAccount: AccountId | null;
  readonly settlementChain: ChainId;
  /** The offered binding's own price — what a rail-B voucher is signed for. */
  readonly price: Money;
  /** True when FALLBACK_BEST decided the offer; the retry decides it the same way. */
  readonly fellBack?: boolean;
}

interface Selection {
  readonly picked: WeightedCandidate | null;
  /** Everything that did not survive the gates, for the error message. */
  readonly rejected: readonly Ineligible[];
  /** Everything the buyer's rules dropped before the gates ran. */
  readonly ruleRejected: readonly RuleRejection[];
  /** FALLBACK_BEST was applied. */
  readonly fellBack: boolean;
  /** `bindingId` → the chain the gates ran on, carried out rather than re-derived. */
  readonly settlementChainOf: ReadonlyMap<string, ChainId>;
}

interface EligibleUnderRules extends Pick<EligibilityResult, 'settlementChainOf'> {
  readonly eligible: readonly RoutingCandidate[];
  readonly rejected: readonly Ineligible[];
  readonly ruleRejected: readonly RuleRejection[];
  readonly fellBack: boolean;
}

interface AttemptOutcome {
  readonly response: ProviderResponse;
  readonly classification: Classification;
  readonly output: JsonValue | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The refusal for "nothing survived the gates", before anything was tried.
 *
 * `PAYMENT_NO_SETTLEABLE_CHAIN` only when EVERY candidate was rejected
 * for chain. A single non-chain rejection means some provider was reachable
 * and failed for a reason the buyer cannot fix by funding another chain, and
 * sending them to do so would be a wrong instruction.
 *
 * `PAYMENT_WITHDRAWAL_PENDING` when any candidate was withheld because the
 * buyer has a standing withdrawal request on the chain it would settle on.
 */
function unroutable(
  toolId: string,
  rejected: readonly Ineligible[],
  routing: RoutingContext,
  ruleRejected: readonly RuleRejection[] = [],
): Error {
  // The buyer's rules dropped a provider: say so, with each provider's reason
  // and whose rule it was (FR-6), rather than a supply error the buyer cannot
  // act on. On the voucher retry the only candidate is the pinned payee, and
  // its rejection is `PAYEE_NO_LONGER_ELIGIBLE`: not charged, the voucher is
  // not redeemed, and the agent asks for a new offer.
  if (ruleRejected.length > 0) {
    const details = ruleRejected
      .map(toRuleRejectionDetail)
      .map((detail) =>
        routing.onlyProviderId && detail.providerId === routing.onlyProviderId
          ? { ...detail, reason: RuleRejectionReason.PAYEE_NO_LONGER_ELIGIBLE, rule: detail.reason }
          : detail,
      );
    return noProviderMatchesRules(toolId, details);
  }

  const allChainRejected =
    rejected.length > 0 &&
    rejected.every((r) => r.reason === IneligibilityReason.CHAIN_NOT_SETTLEABLE);

  if (allChainRejected) {
    const dearest = dearestRejectedPrice(rejected);
    return PaymentErrors.noSettleableChain({
      tool: toolId,
      buyerChains: [...routing.payerChains],
      toolChains: [...new Set(rejected.flatMap((r) => [...r.candidate.settlementChains]))],
      priceMinor: dearest?.amount ?? null,
      decimals: dearest?.decimals ?? null,
    });
  }

  // A standing withdrawal is the buyer's own state, not missing supply, so it
  // is named as such: `TOOL_NO_ELIGIBLE_BINDING` sends an agent to look for a
  // provider when the one thing that helps is its owner cancelling or
  // completing the withdrawal.
  if (rejected.some((r) => r.reason === IneligibilityReason.BUYER_WITHDRAWING)) {
    return PaymentErrors.withdrawalPending({
      tool: toolId,
      chains: [...routing.withdrawingChains],
    });
  }

  // Every reachable provider is on a slash hold: say so, rather than a
  // generic "no binding".
  if (
    rejected.length > 0 &&
    rejected.every(
      (r) =>
        r.reason === IneligibilityReason.PROVIDER_SLASH_HOLD ||
        r.reason === IneligibilityReason.CHAIN_NOT_SETTLEABLE ||
        r.reason === IneligibilityReason.PROVIDER_EXCLUDED,
    ) &&
    rejected.some((r) => r.reason === IneligibilityReason.PROVIDER_SLASH_HOLD)
  ) {
    return ToolErrors.providerSlashHold({ toolId });
  }

  return ToolErrors.noEligibleBinding({ toolId, reason: summariseRejections(rejected) });
}

const TRANSPORT_REASON: Readonly<Record<TransportErrorKind, ClassificationReason>> = Object.freeze({
  [TransportErrorKind.TIMEOUT]: ClassificationReason.TRANSPORT_TIMEOUT,
  [TransportErrorKind.CONNECTION_REFUSED]: ClassificationReason.TRANSPORT_CONNECTION_REFUSED,
  [TransportErrorKind.CONNECTION_RESET]: ClassificationReason.TRANSPORT_CONNECTION_RESET,
  [TransportErrorKind.DNS_FAILURE]: ClassificationReason.TRANSPORT_DNS_FAILURE,
  [TransportErrorKind.TLS_FAILURE]: ClassificationReason.TRANSPORT_TLS_FAILURE,
  [TransportErrorKind.BODY_TRUNCATED]: ClassificationReason.TRANSPORT_BODY_TRUNCATED,
  [TransportErrorKind.SCHEME_NOT_ALLOWED]: ClassificationReason.TRANSPORT_HTTPS_REQUIRED,
  [TransportErrorKind.UNKNOWN]: ClassificationReason.TRANSPORT_UNKNOWN,
});

/**
 * A provider the registry could not find.
 *
 * Built as `SUSPENDED` rather than as a missing value so that eligibility has
 * one code path: an unknown provider is refused by the same check that refuses
 * a suspended one, and `filterEligible` reports `PROVIDER_UNKNOWN` from the
 * blank id. Fails closed either way.
 */
/**
 * The candidate default for a provider the stake source answered nothing about.
 *
 * Shared and frozen rather than a fresh `new Map()` per candidate: it is read
 * and never written, and one instance makes "no reading at all" identical by
 * reference wherever it appears — the same reason `unknownProvider` below hands
 * out empty collections rather than nulls.
 */
const EMPTY_STAKE_BY_CHAIN: ReadonlyMap<ChainId, ProviderStake> = Object.freeze(
  new Map<ChainId, ProviderStake>(),
);

function unknownProvider(): ProviderRoutingState {
  return {
    // Blank on purpose — it is what `filterEligible` reads to report
    // `PROVIDER_UNKNOWN` rather than `PROVIDER_NOT_ACTIVE`.
    providerId: '',
    status: ProviderStatus.SUSPENDED,
    tier: ProviderTier.NEW,
    stats: {},
    // Nobody to pay on any chain, which is the fail-closed value and also
    // simply the truth: there is no registry row to have proved an address.
    payoutAccountByChain: new Map(),
    // Not "enrolled but closed" — there is no row at all, so the refusal that
    // reaches the agent is `PAYOUT_ACCOUNT_UNPROVED` and not the enrolment one.
    payoutEnrolmentChains: new Set(),
  };
}

function timedOutResponse(timeoutMs: number): ProviderResponse {
  return {
    status: 0,
    body: { kind: ResponseBodyKind.EMPTY },
    transportError: {
      kind: TransportErrorKind.TIMEOUT,
      partialBody: null,
      detail: `router deadline of ${timeoutMs}ms expired`,
    },
  };
}

function failedResponse(error: unknown): ProviderResponse {
  return {
    status: 0,
    body: { kind: ResponseBodyKind.EMPTY },
    transportError: classifyTransportError(error),
  };
}

/**
 * The bindings a quote prices from: those that settle on the chain the
 * buyer's own call would settle on.
 *
 * A tool sold on two chains is normally sold in two assets — USDC on Solana,
 * USDG on an EVM chain — and those prices cannot be compared or merged. They
 * do not need to be: a call settles on ONE chain, and `route()` narrows to
 * that chain's bindings before it draws. So the quote picks that same chain
 * with `chooseSettlementChain` (the buyer's default when a routable binding
 * settles there, otherwise the first enabled chain that has one) and prices
 * the worst case among the bindings that settle on it. A buyer on a chain the
 * tool does not settle on is still quoted — the price of where it does settle
 * — and `settlementChains` tells it so.
 *
 * Every eligible candidate has at least one settleable chain (`filterEligible`
 * refuses one with none), so `settlementChains` is non-empty here; the guard
 * keeps the function total rather than throwing from `chooseSettlementChain`.
 */
function pricedOnQuotedChain(
  eligible: readonly RoutingCandidate[],
  settlementChains: readonly ChainId[],
  context: RoutingContext,
): readonly RoutingCandidate[] {
  if (settlementChains.length === 0) return eligible;

  const chain = chooseSettlementChain(
    settlementChains,
    context.defaultChainId,
    context.enabledChains,
  );
  return eligible.filter((candidate) => settleableChains(candidate, context).includes(chain));
}

/**
 * The dearest eligible binding, as `Money`.
 *
 * Every binding a buyer on one chain could be charged by must be priced in one
 * asset (bindings on different chains are separated beforehand by
 * {@link pricedOnQuotedChain}) — comparing `"1000"` of
 * a 6-decimal stablecoin against `"1000"` of a 9-decimal token is not a
 * comparison, and converting between them needs an FX source the platform
 * deliberately does not have (`STAKE_ASSET_MISMATCH`). Two assets on ONE
 * chain are a catalogue error, so they are refused rather than quoted from the
 * subset that happens to agree — and the refusal is this tool's alone, because
 * every catalogue caller quotes each tool in isolation.
 */
function dearestPrice(eligible: readonly RoutingCandidate[]): Money {
  const first = eligible[0].binding;

  let dearest = first;
  for (const { binding } of eligible) {
    if (binding.assetId !== first.assetId) {
      throw ToolErrors.noEligibleBinding({
        toolId: first.toolId,
        reason:
          `bindings are priced in more than one asset ` +
          `(${first.assetId} and ${binding.assetId}) on one settlement chain; ` +
          `a tool has one price per chain or none`,
      });
    }
    if (BigInt(binding.priceAmount) > BigInt(dearest.priceAmount)) dearest = binding;
  }

  return bindingPrice(dearest);
}

/**
 * One binding's price, as `Money`.
 *
 * The scale comes from the asset registry, never from the binding: a
 * provider that published a price at the wrong scale would otherwise have its
 * mistake quoted back to the agent as a display value off by three orders of
 * magnitude. An unregistered asset throws `CHAIN_ASSET_UNKNOWN` here rather
 * than reaching an agent as a price in an asset the platform cannot hold.
 */
export function bindingPrice(binding: ToolBinding): Money {
  const { decimals } = getAssetMetadata(binding.assetId);
  return MoneyUtil.of(binding.priceAmount, binding.assetId, decimals);
}

/**
 * The call class the eligible supply is quoted as — free first, then paid.
 *
 * - `FREE` only if the agent cannot be charged by any eligible binding.
 * - `PAID` only if no eligible binding can serve a free call (every one is
 *   `PAID`).
 * - `FREEMIUM` otherwise: free-capable supply (`FREE` or `FREEMIUM`) sits beside
 *   paid supply (`PAID` or `FREEMIUM`), so the agent's free quota decides
 *   whether the call is free. Inside it the call is routed with `callClass:
 *   'FREE'`, among the free-capable bindings only; past it, or when none of
 *   them can serve, it falls through to the paid path with `callClass: 'PAID'`.
 *   A free call still never reaches a `PAID` binding (`servesCallClass`), which
 *   is what used to make the whole tool `PAID` as soon as one `PAID` binding
 *   joined — and let any provider switch off a rival's free tier by doing so.
 */
function quotedPricingMode(eligible: readonly RoutingCandidate[]): PricingMode {
  const modes = new Set(eligible.map(({ binding }) => binding.pricingMode));
  if (!modes.has(PricingMode.FREE) && !modes.has(PricingMode.FREEMIUM)) return PricingMode.PAID;
  if (!modes.has(PricingMode.PAID) && !modes.has(PricingMode.FREEMIUM)) return PricingMode.FREE;
  return PricingMode.FREEMIUM;
}

/**
 * Whether a binding may serve a call of this class — see
 * `RoutingContext.callClass`. `FREEMIUM` serves both: the same binding takes
 * free calls inside its quota and paid ones past it, and is gated as paid.
 */
function servesCallClass(binding: ToolBinding, callClass: RoutingContext['callClass']): boolean {
  if (callClass === 'PAID') return binding.pricingMode !== PricingMode.FREE;
  if (callClass === 'FREE') return binding.pricingMode !== PricingMode.PAID;
  return true;
}

/**
 * A traffic-weighted mean over the candidates that have the statistic,
 * renormalised over just those.
 *
 * Renormalisation is the part that matters: treating a missing value as zero
 * would publish a quality rate that falls simply because a new provider joined,
 * and treating it as the neutral prior would publish a measurement that was
 * never measured.
 */
function weightedMean(
  weighted: readonly WeightedCandidate[],
  pick: (candidate: RoutingCandidate) => number | undefined,
): number | null {
  let total = 0;
  let sum = 0;

  for (const entry of weighted) {
    const value = pick(entry.candidate);
    if (value === undefined) continue;
    total += entry.weight;
    sum += entry.weight * value;
  }

  return total === 0 ? null : sum / total;
}

/**
 * The 7-day grace period, applied to what the gate already refused.
 *
 * ```text
 * filterEligible ──▶ { eligible, rejected } ──reinstateGraced──▶ { eligible', rejected' }
 *   (untouched)                                  STAKE_BELOW_MINIMUM only
 * ```
 *
 * ## Why this is not a parameter on `filterEligible`
 *
 * `evaluateStakeGate` has a second caller that is not traffic:
 * `BindingPublishService.stakeGate` asks *may this binding go live*. Grace
 * inside the gate would put `STAKE_GRACE_EXPIRED` on the publish
 * checklist, against a binding that has never served a call — a reason that
 * cannot be true of it, on a screen a provider reads and acts on. **Grace
 * protects traffic that is already flowing; it does not open the door.** So the
 * gate keeps its answer and the router takes a second pass over the rejects.
 *
 * Only `STAKE_BELOW_MINIMUM` is re-examined, and `applyStakeGrace` re-checks
 * that itself rather than trusting this filter — the two agreeing is the point.
 * `STAKE_UNKNOWN` and `STAKE_ASSET_MISMATCH` in particular are never
 * reinstated: a grace row says a provider is a little short, and neither of
 * those is a shortfall, they are a number nobody has.
 *
 * ## Order is preserved
 *
 * The reinstated candidates are merged back in the order they were gathered
 * rather than appended. Weights do not depend on order, but `pickWeighted`
 * walks the list in it, so appending would silently move which binding a given
 * random draw selects — turning a grace period into a change of tie-break for
 * every *other* provider behind the same tool.
 */
function reinstateGraced(
  candidates: readonly RoutingCandidate[],
  result: EligibilityResult,
  now: Date,
): EligibilityResult {
  const settlementChainOf = result.settlementChainOf;
  const rejected: Ineligible[] = [];
  const reinstated = new Set<RoutingCandidate>();

  for (const item of result.rejected) {
    if (item.reason !== IneligibilityReason.STAKE_BELOW_MINIMUM) {
      rejected.push(item);
      continue;
    }

    // `Ineligible` and the gate's failed verdict are structurally the same
    // three facts wearing different names, so this is the bridge rather than a
    // conversion: `filterEligible` must keep returning what it returns (a
    // rejection carries the candidate; a verdict does not), and
    // `applyStakeGrace` must keep taking a verdict, because the publish gate
    // hands it one directly. `detail` is optional on `Ineligible` and required
    // on the verdict; the gate always sets it, and `?? ''` covers the type
    // rather than a case.
    const failed: StakeGateVerdict = {
      passed: false,
      reason: item.reason,
      detail: item.detail ?? '',
    };

    // Assigned to a `StakeGateVerdict` local before it is read. What
    // `applyStakeGrace` returns is an INTERSECTION — `StakeGateVerdict & {
    // inGrace?: true }` — not a discriminated union, so `reason` and `detail`
    // are inaccessible on it even after `passed` has been checked.
    const verdict: StakeGateVerdict = applyStakeGrace(failed, item.candidate.stakeGraceUntil, now);

    // `=== true`, not a bare truthiness test: this project compiles with
    // `strictNullChecks: false`, under which TypeScript does not narrow the
    // union on a bare boolean check — the same reason `eligibility.ts` spells
    // its own test `gate.passed === false`.
    if (verdict.passed === true) {
      reinstated.add(item.candidate);
      continue;
    }

    // Not `item`. The verdict may have been relabelled `STAKE_GRACE_EXPIRED`
    // with a detail that names the deadline as well as the shortfall, and that
    // is the sentence the provider needs — "your grace ran out" is why they are
    // being cut *now* rather than when the shortfall first appeared.
    rejected.push({ candidate: item.candidate, reason: verdict.reason, detail: verdict.detail });
  }

  if (reinstated.size === 0) return { eligible: result.eligible, rejected, settlementChainOf };

  const eligible = new Set(result.eligible);
  return {
    eligible: candidates.filter(
      (candidate) => eligible.has(candidate) || reinstated.has(candidate),
    ),
    rejected,
    settlementChainOf,
  };
}

/**
 * The candidate list with this request's shed bindings marked.
 *
 * A copy rather than a mutation: `RoutingCandidate` is `readonly` throughout so
 * that a recorded decision can be replayed from its inputs, and a router that
 * wrote `ceilingHit` back onto the gathered candidate would leave one request's
 * transient shedding on an object the next `await` in the same tool call reads.
 *
 * The common case allocates nothing — most requests shed nothing at all.
 */
function withShed(
  candidates: readonly RoutingCandidate[],
  shed: ReadonlyMap<string, CeilingKind>,
): readonly RoutingCandidate[] {
  if (shed.size === 0) return candidates;

  return candidates.map((candidate) => {
    const hit = shed.get(candidate.binding.id);
    return hit === undefined ? candidate : { ...candidate, ceilingHit: hit };
  });
}

/** One read per (provider, chain), however many bindings share the pair. */
function dedupe(keys: readonly ProviderChainStakeKey[]): ProviderChainStakeKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const k = stakeKey(key.providerId, key.chainId);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The most expensive price among the chain-rejected candidates, so the buyer is
 * told the amount that would have covered ANY of them.
 *
 * `null` when every rejected binding is FREE — the error context then carries no
 * price, and the message still names the chains. A FREE binding is priced `'0'`
 * and is filtered out rather than compared, because "fund the other chain with
 * $0" is not an instruction.
 *
 * A tool sold on several chains is normally priced in several assets (one per
 * chain), and two amounts of different assets have no "larger". When the
 * rejected bindings disagree on asset there is no single figure to quote, so
 * the answer is `null` — the message still names the chains — rather than a
 * number in one asset presented as covering bindings priced in another.
 */
function dearestRejectedPrice(rejected: readonly Ineligible[]): Money | null {
  const assets = new Set(rejected.map(({ candidate }) => candidate.binding.assetId));
  if (assets.size > 1) return null;

  return rejected
    .map(({ candidate }) => candidate.binding)
    .filter(
      (binding) => binding.pricingMode !== PricingMode.FREE && BigInt(binding.priceAmount) > 0n,
    )
    .map((binding) =>
      MoneyUtil.of(
        binding.priceAmount,
        binding.assetId,
        getAssetMetadata(binding.assetId).decimals,
      ),
    )
    .reduce<Money | null>(
      (best, price) => (!best || MoneyUtil.greaterThan(price, best) ? price : best),
      null,
    );
}

function summariseRejections(
  rejected: readonly Ineligible[],
  ruleRejected: readonly RuleRejection[] = [],
): string {
  if (rejected.length === 0 && ruleRejected.length === 0) return 'no bindings';

  const counts = new Map<string, number>();
  for (const item of [...ruleRejected, ...rejected]) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }

  return [...counts.entries()].map(([reason, count]) => `${count} ${reason}`).join(', ');
}

/**
 * `NO_PROVIDER_MATCHES_RULES`, carrying each provider's reason and source.
 * Exported for the MCP call path, which raises it from a quote the rules
 * emptied before any intent exists.
 */
export function noProviderMatchesRules(
  toolId: string,
  providers: readonly RuleRejectionDetail[],
): Error {
  return ToolAccessErrors.noProviderMatchesRules({ details: { toolId, providers } });
}

function toRuleRejectionDetail(rejection: RuleRejection): RuleRejectionDetail {
  return {
    providerId: rejection.candidate.binding.providerId,
    reason: rejection.reason,
    source: rejection.source,
    detail: rejection.detail,
  };
}

/** Whether the entry asked to fall back to Assay's pick when its rules leave nobody. */
function fallsBack(rules: RoutingRules | undefined): boolean {
  return rules?.entry?.onEmpty === OnEmpty.FALLBACK_BEST;
}

/** The cheapest binding, as `Money` — the "From $X" a listing shows. */
function cheapestPrice(eligible: readonly RoutingCandidate[]): Money {
  let cheapest = eligible[0].binding;
  for (const { binding } of eligible) {
    if (BigInt(binding.priceAmount) < BigInt(cheapest.priceAmount)) cheapest = binding;
  }
  return bindingPrice(cheapest);
}
