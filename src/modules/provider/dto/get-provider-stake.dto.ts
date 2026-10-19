import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * The one name for the multi-binding stake rule, and the only place it is
 * spelled.
 *
 * **`max`, not `sum`.** An earlier assumption was that `minimumStake` is the
 * sum over active `PAID`/`FREEMIUM` bindings. The code has never done that: the
 * gate is evaluated **per binding** in `evaluateStakeGate`, against
 * `minimumStakeFor(price) = max(floor, priceMultiple × price)` for *that*
 * binding.
 *
 * `max` is kept, for two reasons that are not "it was easier":
 *
 * - The portfolio risk `sum` was reaching for is already carried by the
 *   **10%-of-stake-per-provider-per-24h slash cap** (the on-chain `Config`
 *   enforces it). Charging for it twice would price
 *   capital against a loss that cannot happen.
 * - `sum` would move the gate's unit of account from the **binding** to the
 *   **provider**, and the whole point of the shared `evaluateStakeGate` is
 *   that the publish gate, the router and the stake monitor all ask the same
 *   question about the same binding. Under `sum`, publishing a second binding
 *   could retroactively make the first one unroutable.
 *
 * The screen therefore has to *say* `max`. A screen that names a rule the
 * platform does not apply is worse than one that names none: a provider plans
 * capital against it.
 */
export const STAKE_REQUIREMENT_RULE = 'max';

/** The literal {@link STAKE_REQUIREMENT_RULE} carries. One value, on purpose. */
export type StakeRequirementRule = typeof STAKE_REQUIREMENT_RULE;

/**
 * One open grace period, for one binding.
 *
 * **Per binding, never per provider.** The requirement is `max(floor,
 * priceMultiple × price)` computed for each binding separately, so one provider
 * is simultaneously above it for a cheap binding and below it for an expensive
 * one — and can therefore hold three grace periods with three different
 * deadlines at once. `provider_stake_grace` is keyed on `binding_id` for
 * exactly that reason, and a provider-level field here would have to be wrong
 * about at least one of them: the provider console would render a single countdown
 * for someone who has three, and the two it silently dropped are the ones whose
 * traffic stops first.
 */
export class ProviderStakeGraceDto {
  @ApiProperty({
    description: 'When the shortfall was first observed. Written once and never moved.',
  })
  startedAt: string;

  @ApiProperty({
    description:
      'When grace runs out. Stored on the row when it opened, never re-derived — changing the ' +
      'window length must not retroactively shorten a countdown already running.',
  })
  expiresAt: string;

  @ApiProperty({
    type: MoneyDto,
    description:
      'Requirement minus stake, **frozen at the moment the period opened**. The screen ' +
      'shows "the exact amount needed" beside the countdown, and re-deriving it from today\'s price would ' +
      'answer a different question than the one the clock is timing.',
  })
  shortfall: MoneyDto;

  @ApiProperty({
    description:
      'True once the deadline has passed — `now >= expiresAt`, the same boundary ' +
      "`applyStakeGrace` uses. This is the field that separates the grace banner's " +
      '`Your traffic is still flowing.` (a row that is open and NOT expired) from a binding that has been cut. The row ' +
      'is still returned after expiry, and deliberately so: between the deadline and the ' +
      'monitor\'s next 5-minute tick, "your grace ran out" is a different sentence from "you ' +
      'are below the minimum", and only the first one explains why the traffic stopped.',
  })
  expired: boolean;
}

/** One binding's contribution to the requirement — the requirement "itemised per binding". */
export class ProviderStakeRequirementItemDto {
  @ApiProperty()
  bindingId: string;

  @ApiProperty()
  toolId: string;

  @ApiProperty({ description: 'PAID or FREEMIUM. FREE bindings need no stake and are not listed.' })
  pricingMode: string;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      "The binding's price. `null` only when the binding is priced in an asset the stake floor " +
      'is not denominated in — see `minimum`.',
  })
  price: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'What this binding alone requires: the negotiated override if the provider has one, else ' +
      '`max(floor, priceMultiple × price)`. `null` when the binding is priced in another asset — ' +
      'the gate rejects it as `STAKE_ASSET_MISMATCH` rather than converting, because a rate ' +
      'would silently move the floor. Such a binding is listed anyway: it is not routable, and ' +
      'hiding it would leave the provider without the reason.',
  })
  minimum: MoneyDto | null;

  @ApiProperty({
    description: 'How `minimum` was arrived at, as one line the screen can print verbatim.',
    example: 'max(floor 50.000000, 1000 × 0.001000) = 50.000000',
  })
  derivation: string;

  @ApiPropertyOptional({
    type: ProviderStakeGraceDto,
    nullable: true,
    description: 'The open grace period for THIS binding, or null. See `ProviderStakeGraceDto`.',
  })
  grace: ProviderStakeGraceDto | null;
}

/** Enough to draw one banner. **Not** the source of truth — see `requirement[].grace`. */
export class ProviderStakeGraceSummaryDto {
  @ApiProperty({ description: 'How many bindings currently hold an open grace row' })
  bindingsInGrace: number;

  @ApiProperty({ description: 'The soonest deadline among them — the one the banner counts down' })
  earliestExpiresAt: string;
}

/**
 * One chain's stake, as the provider's own Capital screen reads it.
 *
 * ## Why this is a list and not a figure
 *
 * A call is slashed in the settlement contract of the chain it was paid on, so
 * collateral on Solana is invisible and unreachable to `AssayStake` on an EVM
 * chain — a provider who serves two chains must stake on both. And a sum across
 * chains is the one number that is never true, because no single call is
 * backed by it. Both rules land on the same shape, and it is the shape
 * {@link CatalogueProviderDto.stake} already publishes **about this very
 * provider**: one entry per chain, each naming its own chain, never combined.
 *
 * The two are read by the same person about the same provider — the catalogue
 * card a buyer sees and the Capital screen the provider sees — and a
 * disagreement between them is not cosmetic. Under the single figure this
 * replaces, a provider who correctly staked on both chains read one
 * chain's number under their own name here and two rows there.
 *
 * ## Three states per chain, and none of them may collapse into another
 *
 * `hasKnownStake` and `chainReadable` are two different unknowns, and both are
 * **per chain** here because both failures are per chain: an RPC outage is an
 * outage of one network, and reporting it against a chain that answered fine
 * would be a fabricated incident.
 *
 * ```text
 * hasKnownStake  staked         meaning
 * true           { amount }     the source answered, with this much
 * true           { amount: 0 }  the source answered, and the answer was ZERO
 * false          null           the source has no reading — NEVER a zero
 * ```
 *
 * A chain reading zero and a chain nobody could read are different facts about
 * a provider's ability to take paid traffic. `evaluateStakeGate` treats them
 * alike (fail closed) and the screen must not: only one of them is fixed by
 * staking.
 *
 * ## Which chains appear
 *
 * The provider's own chain enrolments — the same derivation
 * `CatalogueService.cardStakes` uses, and for the same reason: a stake reading
 * resolves through the enrolment's stake authority, so a chain with no
 * enrolment is a question whose answer is already known. Plus the stake floor's
 * own chain, always, because `requirementTotal`, `headroom` and `shortfall` are
 * denominated in that chain's asset and a response reporting headroom against a
 * chain missing from this list could not be read.
 *
 * A chain the provider enrolled on and never funded therefore appears with
 * `stakeAuthority: null` — "enrolled, not yet funded", `ChainEnrolment`'s own
 * documented state and exactly what that provider needs to fix. Under the
 * single figure it appeared as nothing at all.
 */
export class ProviderChainStakeDto {
  @ApiProperty({
    description: 'CAIP-2 chain id. Every other field on this entry is about THIS chain only.',
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  chainId: string;

  @ApiProperty({
    description:
      'False when the stake source has no reading for this provider ON THIS CHAIN. Never ' +
      'rounded to zero — see the class comment’s table.',
  })
  hasKnownStake: boolean;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Null when `hasKnownStake` is false. Never a synthetic zero.',
  })
  staked: MoneyDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'When `staked` was read. Null when `hasKnownStake` is false.',
  })
  observedAt: string | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'Stake the provider has asked to take out on THIS chain, still inside the unbonding ' +
      'period. **Never part of `staked`** — `ProviderStake::meets_minimum` is ' +
      '`bonded >= minimum`, and folding the two would let a provider request a full unstake ' +
      'and keep serving paid traffic for the whole period. Null when `chainReadable` is false ' +
      'or there is no stake account on this chain.',
  })
  unbonding: MoneyDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'When this chain’s unbonding period started. Null when nothing is unbonding.',
  })
  unbondingStartedAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'When this chain’s unbonding period ends — the countdown the screen renders. Derived on ' +
      'chain from that chain’s own `unbonding_period_seconds`, so it cannot disagree with the ' +
      'gate that enforces it.',
  })
  unbondingCompletesAt: string | null;

  @ApiProperty({
    description:
      'False when THIS chain could not be read on this request, in which case `unbonding`, ' +
      '`unbondingStartedAt` and `unbondingCompletesAt` are `null` because they are ' +
      '**unknown**, not zero. Per chain, because an outage is an outage of one network: a ' +
      'response-wide flag would report a Solana RPC failure against an EVM chain that ' +
      'answered. True with those fields still null means either that `stakeAuthority` is null ' +
      '(nothing to read) or that the chain answered and there is no stake account at those ' +
      'seeds.',
  })
  chainReadable: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The CAIP-10 account on THIS chain whose stake account backs this provider, or null if ' +
      'they have not signed the stake-authority challenge for one. One per chain, never one ' +
      'overall — it is a column on the chain enrolment (migration `1759300000003` deleted the ' +
      'provider-wide `providers.stake_authority` for exactly this reason). Null is why this ' +
      'entry’s chain-derived fields are null with `chainReadable` still true: there is nothing ' +
      'to read.',
  })
  stakeAuthority: string | null;
}

/**
 * `GET /providers/me/stake` — everything the provider's Capital screen renders.
 *
 * ## Timestamps are ISO strings here, not `Date`
 *
 * Every date on this response is a countdown a client parses, and `Date` in a
 * DTO misdescribes the wire, where Nest has already serialised it to an ISO
 * string. Half `Date` and half `string` within one response would be worse than
 * either, so the whole response commits to the string. The bytes are unchanged.
 *
 * ## Absent is not zero, in three separate places
 *
 * `ports/provider-stake.port.ts` is explicit that a provider absent from the
 * stake source has **no known stake** — an RPC that failed and a provider that
 * never bonded both produce "absent" — while a zero stake means "we asked, and
 * the answer was zero". Collapsing the two would make an outage
 * indistinguishable from an unbonded provider on the one screen a provider
 * reads to find out whether they can take paid traffic.
 * `ProviderChainStakeDto.hasKnownStake` puts the distinction on the wire rather
 * than leaving a client to infer it from a `null` that could equally be missing
 * JSON — and it does so **per chain**, because the source can answer about one
 * chain and not another.
 *
 * The same rule governs the chain-derived block (`unbonding` and its
 * timestamps) through `ProviderChainStakeDto.chainReadable`, and the
 * requirement through `requirementTotal: null` meaning "no paid bindings,
 * nothing to stake against" rather than "$0 required".
 *
 * ## The stake is per chain; the requirement is still per binding
 *
 * {@link stake} is per chain, never summed. {@link requirement} was already a list
 * and answers a **different** question — one entry per ACTIVE PAID/FREEMIUM
 * binding, because `evaluateStakeGate` is evaluated per binding — so the two
 * lists are not parallel and must not be read as though they were.
 * `requirementTotal`, `headroom`, `shortfall` and `recommendedBuffer` are all
 * denominated in the stake floor's single asset and are therefore about the
 * floor's chain alone; they compare against that chain's entry in
 * {@link stake} and nothing else. Making the requirement per chain needs the
 * per-chain floor (`loadMinimumStakeByChain`) threaded through this service and
 * is not done yet, rather than approximated here.
 *
 * ## What this endpoint deliberately does NOT return
 *
 * The Capital screen's **Exposure** panel is made of slash-cap arithmetic — max
 * loss in any one window, max loss across all bindings in 24h (10% of stake),
 * max loss over 30 days, and the list of open SLA windows. None of that is
 * here; the cap panel belongs with the SLA-window endpoints.
 *
 * There used to be an `exposed` figure here too — the on-chain number this
 * platform asserted through `record_exposure`, meaning stake backing calls
 * served and not yet settled. The simplified contract removed the instruction and the field,
 * so there is nothing to report and it is **removed rather than reported as
 * zero**: a zero would read as "nothing outstanding" rather than as "this
 * platform no longer measures that".
 *
 * Also absent, each for a missing producer rather than an oversight: the
 * auto-sweep toggle and swept-to-date (no sweep exists), the deposit and
 * unstake actions (served by the stake-intent endpoints), the exit checklist,
 * and the "projected requirement after any pending change" (nothing records a
 * pending binding change).
 */
export class GetProviderStakeResponseDto {
  /**
   * The stake, **per chain — a list, never a sum**.
   *
   * One entry per chain the provider is enrolled on, plus the stake floor's own
   * chain always. Sorted by `chainId`, so two loads of the screen do not
   * reorder the rows. Never empty on a real provider: the floor's chain is in
   * it whether or not they have enrolled anywhere.
   *
   * This replaces a `staked` / `observedAt` / `unbonding` /
   * `unbondingStartedAt` / `unbondingCompletesAt` / `hasKnownStake` /
   * `chainReadable` / `stakeAuthority` block that described exactly one chain —
   * the floor's — while `CatalogueProviderDto.stake` already described all of
   * them for the same provider. Two provider-facing surfaces disagreeing about
   * one provider's collateral is the defect; the sum that would have "fixed" it
   * is the one that is never true for any single call.
   *
   * There is deliberately **no response-level total, and no response-level
   * `hasKnownStake`**. Either would have to be a claim across chains, and no
   * call is ever backed by more than one of them.
   */
  @ApiProperty({
    type: [ProviderChainStakeDto],
    description:
      'Stake per chain — a list, never a sum. One entry per enrolled chain plus the stake ' +
      'floor’s own chain, ordered by `chainId`.',
  })
  stake: ProviderChainStakeDto[];

  @ApiProperty({
    type: [ProviderStakeRequirementItemDto],
    description:
      'The requirement itemised per binding, ordered by tool id then binding id. ' +
      'Covers ACTIVE PAID/FREEMIUM bindings only: a FREE binding settles nothing, so no ' +
      'defection profits and no stake is required, and a DRAFT/PAUSED/SUSPENDED binding takes ' +
      'no paid traffic to require stake for.',
  })
  requirement: ProviderStakeRequirementItemDto[];

  @ApiProperty({
    enum: [STAKE_REQUIREMENT_RULE],
    description:
      'The rule combining the items into `requirementTotal`, named so the screen can print it. ' +
      'Always `max` — see `STAKE_REQUIREMENT_RULE` for why, and for which docs are wrong.',
  })
  requirementRule: StakeRequirementRule;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      '`max` over `requirement[].minimum`. Null when the provider has no ACTIVE PAID/FREEMIUM ' +
      'binding priced in the stake asset — nothing to stake against, which is not the same as ' +
      'a requirement of zero.',
  })
  requirementTotal: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      "The provider's negotiated floor, or null if they have none. Populated whenever " +
      'an override exists, **independently of `requirementTotal`** — including when the provider ' +
      'has no ACTIVE PAID/FREEMIUM binding at all, which is exactly the case `requirementTotal` ' +
      'answers `null` to. Without this field a negotiated $500 floor has no representation on ' +
      'the response until the first binding is published, so the provider reads "nothing to ' +
      'stake against", stakes nothing, and watches the requirement appear at $500 the moment ' +
      'they publish. When both are set they agree: the override replaces the computed floor on ' +
      'every item, so `requirementTotal` is the override.',
  })
  negotiatedMinimum: MoneyDto | null;

  @ApiPropertyOptional({
    type: ProviderStakeGraceSummaryDto,
    nullable: true,
    description: 'Null when no binding is in grace. A banner, not the source of truth.',
  })
  graceSummary: ProviderStakeGraceSummaryDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      '`staked - requirementTotal`, floored at zero — see `shortfall` for the other direction. ' +
      'Null when either operand is unknown.',
  })
  headroom: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      '`requirementTotal - staked`, floored at zero. Two unsigned fields rather than one signed ' +
      'one because `Money` in this codebase cannot be negative by construction ' +
      '(`MONEY_MIN_ATOMIC_UNITS = 0`), and a signed amount string would be a second money type ' +
      'nothing else on the surface understands. Exactly one of the two is ever non-zero.',
  })
  shortfall: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      '1.5x `requirementTotal`, with the reason the screen states beside it: the ' +
      'grace period is seven days, and a buffer means never using it.',
  })
  recommendedBuffer: MoneyDto | null;
}
