import { ToolVersionBriefDto } from '@modules/tool/dto/tool-contract-version.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { ToolTier } from '@modules/tool/ports/tool.types';

/**
 * The buyer's catalogue.
 *
 * ## The problem it closes
 *
 * `/explore/providers` and `/explore/tools` were folded from the caller's own
 * `/tool-calls` feed, because nothing enumerated the platform. That is a
 * catalogue that can only show you what you have already bought: a fresh
 * organization saw **zero** providers on a deployment holding 42 of them, and
 * two people signed in to different accounts saw two different markets. A
 * marketplace whose shop window is a function of your receipt history is not a
 * marketplace.
 *
 * ## What it lists, and what it refuses to list
 *
 * A provider appears here when they have **at least one `ACTIVE` binding**, and
 * a tool appears when at least one provider does. That is the line between a
 * shop window and a registry: a catalogue row is an invitation to call, and a
 * provider with only `DRAFT` or `PAUSED` bindings is one the router would
 * reject — advertising them is a promise the platform cannot keep. The
 * registered-but-not-serving providers are not hidden, they are simply not
 * *listed*; `GET /catalogue/providers/{providerId}` still answers for them,
 * with an empty `tools`.
 *
 * ## Every figure here is measured or absent — none is defaulted
 *
 * The three numbers a buyer chooses on are the three this platform has been
 * careful about, and each has a real "we do not know" that must survive to the
 * screen:
 *
 * - **{@link CatalogueProviderDto.quality}** is `null` until the provider has
 *   an SLA window in the last 30 days. Not `0`, and not `1`. Roughly two thirds of providers on
 *   a young deployment have never been measured, and rendering that as 100%
 *   would make the least-proven provider look like the best one.
 * - **{@link CatalogueProviderDto.stake}** is a list per chain and is EMPTY
 *   when the stake source cannot say — an RPC outage, an unproved stake
 *   authority, a provider staked in a mode this deployment does not read.
 *   `ProviderStakePort` is explicit that an absent entry is "no known stake"
 *   and *never* zero, and a `$0.00` on a card would read as "this provider has
 *   nothing at risk", which is a different and much stronger claim. A list
 *   rather than one figure because collateral is per chain and is not shared:
 *   a sum advertises protection no single call has.
 * - **{@link CatalogueToolDto.price}** is `null` when no binding is currently
 *   routable, and {@link CatalogueToolDto.unroutableReason} says why.
 */

/**
 * `Money` on the wire: atomic units as a decimal string, plus the asset that
 * gives the number meaning. Never a bare amount — see
 * `chains/ports/money.types.ts`.
 */
export class CatalogueMoneyDto {
  @ApiProperty({ description: 'Atomic units as a decimal integer string', example: '250000' })
  amount: string;

  @ApiProperty({ description: 'CAIP-19 asset id' })
  asset: string;

  @ApiProperty({ description: 'The scale `amount` is quoted in', example: 6 })
  decimals: number;
}

/**
 * One chain's bonded stake.
 *
 * `chainId` is on the entry rather than implied by `asset`, even though a
 * CAIP-19 asset already names its chain: the screen groups and labels by chain,
 * and re-parsing an asset id to draw a row heading is a derivation on the
 * rendering path that a wrong asset would silently corrupt.
 */
export class CatalogueChainStakeDto {
  @ApiProperty({ description: 'CAIP-2 chain id this collateral is posted on' })
  chainId: string;

  @ApiProperty({ description: 'Atomic units as a decimal integer string', example: '90000000' })
  amount: string;

  @ApiProperty({ description: 'CAIP-19 asset id — names this same chain' })
  asset: string;

  @ApiProperty({ description: 'The scale `amount` is quoted in', example: 6 })
  decimals: number;
}

/**
 * Quality as the platform itself measures it, not as a provider claims it.
 *
 * Summed from `sla_windows`, whose per-window counters were folded from
 * `sla_window_calls.counted_as_quality` / `counted_as_failure` — the same
 * figures that decide a strike and, eventually, a slash. So the number on the
 * card is the number the provider is held to, rather than a second opinion
 * computed for display.
 *
 * **The last 30 days, open and closed windows** (owner decision D5). Closed
 * windows alone left a provider's current traffic out of the figure, and a few
 * old windows could stand for thousands of newer calls. The penalty path does
 * not read this sum: strikes and slashes still judge one closed window at a time.
 *
 * `measuredCalls` rides along because a rate without a denominator is not
 * comparable: 100% of four calls and 95% of sixteen thousand are not the same
 * claim, and the screen has to be able to say so.
 */
export class CatalogueQualityDto {
  @ApiProperty({ description: 'Passed ÷ measured, 0..1.', example: 0.95 })
  rate: number;

  @ApiProperty({ description: 'The denominator — calls whose verdict moved the metric.' })
  measuredCalls: number;

  @ApiProperty({ description: 'The numerator of the complement.' })
  failedCalls: number;
}

export class CatalogueProviderDto {
  @ApiProperty({ description: 'The id every call row and receipt carries for this provider.' })
  providerId: string;

  @ApiProperty({ description: 'The provider’s own registered name.' })
  legalName: string;

  @ApiProperty({
    description:
      'An identity check, not a gate. It says who you are buying from, not whether they are ' +
      'any good — quality does that.',
  })
  verified: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'ISO-8601, or null.' })
  verifiedAt: string | null;

  @ApiProperty({ description: 'NEW | ESTABLISHED | TRUSTED' })
  tier: string;

  @ApiProperty({ description: 'Tool ids this provider serves with an ACTIVE binding.' })
  toolIds: string[];

  @ApiProperty({ description: 'How many ACTIVE bindings back those tools.' })
  activeBindings: number;

  @ApiPropertyOptional({
    type: CatalogueMoneyDto,
    nullable: true,
    description: 'Cheapest ACTIVE binding. A floor across this provider’s own tools.',
  })
  fromPrice: CatalogueMoneyDto | null;

  /**
   * Bonded stake, **per chain — a list, never a sum**.
   *
   * A call settles on one chain and is backed only by that chain's collateral,
   * so a total would advertise protection no single call has: $90 on Solana
   * plus $40 on `eip155:4663` renders as $130 and clears a floor neither chain
   * clears. The two are different CAIP-19 assets, so they cannot be compared to
   * pick the lower either — a "lowest" across them is an FX rate assumed to be
   * 1, on the number a buyer uses to decide whether to trust a provider.
   *
   * **An empty list is "we could not say"** — an RPC outage, an unproved stake
   * authority, a provider staked in a mode this deployment does not read. It is
   * never "staked nothing": a chain with a reading of zero appears here as a
   * zero-amount entry, and a chain nobody could read does not appear at all.
   * Absent is not zero, the same rule the field carried when it was one value.
   *
   * This replaces a single nullable `CatalogueMoneyDto`, which rendered `null`
   * for a provider staked on two chains. That collided with the meaning `null`
   * already had here, so the best-collateralised participant on the platform
   * displayed identically to one whose RPC was down — and this screen must not
   * hide what it knows.
   */
  @ApiProperty({
    type: [CatalogueChainStakeDto],
    description: 'Bonded stake per chain — a list, never a sum. Empty means not known, never zero.',
  })
  stake: CatalogueChainStakeDto[];

  @ApiPropertyOptional({
    type: CatalogueQualityDto,
    nullable: true,
    description:
      'null until a call has been checked in the last 30 days. Not measured is not the same as perfect.',
  })
  quality: CatalogueQualityDto | null;

  /**
   * The chains a call to this provider can settle on right now: the union of
   * the known {@link CatalogueProviderToolDto.chains} over its tools. Empty
   * when the router would take no call to it on any chain (paused at the
   * circuit, at its ceiling, short of stake, on a slash hold); `null` when no
   * tool's chains could be read — unknown, never "takes no call".
   */
  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'CAIP-2 chains a call to this provider can settle on now, by the router’s own gates. ' +
      'Empty when it takes no call on any chain right now; null when that could not be read.',
  })
  chains: string[] | null;

  /**
   * Whether this provider takes a call from the **caller's** agents now: one of
   * {@link chains} is a chain one of the caller's agents pays on. Only the
   * signed-in routes fill it, from the caller's own agents; `null` when nobody
   * is asking, or when the provider's chains could not be read.
   */
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Per caller: a call from one of your agents can settle with this provider now (on your ' +
      'agents’ chains, less a chain with a standing withdrawal). null when unknown.',
  })
  servesYou: boolean | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['WITHDRAWING'],
    description:
      'Per caller, when servesYou is false for a reason of your own: WITHDRAWING (every agent ' +
      'has a standing withdrawal, so no chain is left to pay on). null otherwise.',
  })
  notServedReason: 'WITHDRAWING' | null;
}

export class CatalogueProviderListDto {
  @ApiProperty({ type: [CatalogueProviderDto], description: 'Every provider serving traffic.' })
  providers: CatalogueProviderDto[];
}

/**
 * What a call costs on one chain, and whose listing sets that price.
 *
 * A buyer pays on one chain, so the price that matters to them is that chain's
 * — the router's quote for a buyer funded there. One tool can settle at $0.10
 * on one chain and $0.25 on another, and a single headline figure would be
 * wrong for one of the two readers.
 */
export class CatalogueChainPriceDto {
  @ApiProperty({ description: 'CAIP-2 chain a call settles on at this price' })
  chainId: string;

  @ApiProperty({
    type: CatalogueMoneyDto,
    description: 'The routed quote for a buyer paying on this chain — the most a call is charged.',
  })
  price: CatalogueMoneyDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The provider whose listing sets this price; null when several eligible listings share it.',
  })
  providerId: string | null;

  @ApiProperty({
    description:
      'Eligible listings on this chain the price was taken over. Name the provider only when 1.',
    example: 1,
  })
  listings: number;
}

export class CatalogueToolDto {
  @ApiProperty({ example: '06399979-f8b8-4c9e-a9b1-bd2a5924d442' })
  id: string;

  @ApiProperty({ example: 'get_weather' })
  name: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ description: 'The current version’s summary (at most 200 characters).' })
  summary: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1.1.0',
    description: 'tools.current_version',
  })
  version: string | null;

  @ApiProperty({
    type: [ToolVersionBriefDto],
    description: 'Every published version, newest first, with status, sunset and changelog.',
  })
  versions: ToolVersionBriefDto[];

  @ApiProperty({
    type: [Number],
    example: [1],
    description: 'Majors that are DEPRECATED (still serving until their sunset).',
  })
  deprecatedMajors: number[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'What replaces the deprecated majors: the tool to call (this tool at a newer major, or ' +
      'the operator-named replacement tool, only when it is LISTED). `null` with no deprecated ' +
      'major or no replacement.',
  })
  replacementToolId: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'get_weather' })
  replacementName: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 2, description: 'The major to call it at' })
  replacementMajor: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2.0.0',
    description: 'The replacement’s served version',
  })
  replacementVersion: string | null;

  @ApiProperty({ enum: ToolTier, description: 'A provider tool is never GUARANTEED (§7.6).' })
  tier: ToolTier;

  @ApiProperty({
    enum: ['STANDARD', 'PROVIDER'],
    description: 'STANDARD: backed by several providers. PROVIDER: one maker’s own API.',
  })
  kind: 'STANDARD' | 'PROVIDER';

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'acme',
    description: 'The maker’s public name, on a PROVIDER tool (`{handle}__{tool}`).',
  })
  handle: string | null;

  @ApiProperty({
    description:
      'The "Not reviewed" badge: a provider tool no operator approved. Always false in the ' +
      'catalogue, which lists reviewed (LISTED) tools only.',
  })
  notReviewed: boolean;

  @ApiProperty({
    example: 'weather',
    description: 'The tool’s topic (`tools.category`), as `?category=` filters on.',
  })
  category: string;

  @ApiProperty({ type: [String], example: ['temperature', 'conditions'] })
  tags: string[];

  @ApiProperty({ description: 'Distinct providers with an ACTIVE binding for this tool.' })
  providerCount: number;

  @ApiPropertyOptional({
    type: CatalogueMoneyDto,
    nullable: true,
    description: 'Cheapest ACTIVE binding — what browsing compares on.',
  })
  fromPrice: CatalogueMoneyDto | null;

  /**
   * What a call would actually be held for, straight from `ProviderRouterService.quote`
   * — and so the most it can be charged.
   *
   * It is **not** {@link fromPrice}, and the gap is deliberate rather than a
   * rounding difference: the router quotes the *dearest* eligible binding, so
   * that the hold covers whichever provider failover lands on. The charge is
   * the price of the binding that serves, somewhere between the two, and the
   * rest of the hold is returned. Publishing only the floor would hide the
   * worst case; publishing only the quote would hide how cheap the market's
   * floor is. Both, named for what they are.
   */
  @ApiPropertyOptional({
    type: CatalogueMoneyDto,
    nullable: true,
    description:
      'The routed quote — dearest eligible binding, the most a call is charged (it pays the ' +
      'serving binding). null when nothing is routable.',
  })
  price: CatalogueMoneyDto | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'FREE | FREEMIUM | PAID' })
  pricingMode: string | null;

  /**
   * Free first, then paid: the free calls a day one agent gets before a call
   * is charged — the most generous free-capable binding's per-agent allowance.
   * A `FREEMIUM` tool reads *"N free per day, then up to {@link price}"*.
   * `null` when the tool is quoted `PAID` (or nothing is routable).
   */
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Free calls per agent per day before a call is paid (FREE and FREEMIUM tools); ' +
      'null for a PAID tool.',
  })
  freeCallsPerDay: number | null;

  @ApiProperty({ description: 'Whether a call placed now would find a provider.' })
  routable: boolean;

  /**
   * How many bindings the quote was taken over — `ProviderRouterService.quote`'s
   * own count. `tools/list` prints its price as "up to $X" when this is above
   * one, because the call pays the serving binding, which may be cheaper than
   * the hold. The catalogue publishes the count so a screen can say the same.
   * Not `providerCount`: a listed provider the router cannot use right now
   * (a stake on another asset, a ceiling hit) is in that and not in this.
   */
  @ApiProperty({
    description:
      'Bindings the router could serve this tool from right now — the set the quote is the ' +
      'dearest of. 0 when nothing is routable.',
  })
  routableBindings: number;

  /**
   * How many of {@link routableBindings} can be charged (`PAID` or
   * `FREEMIUM`). "up to $X" is about these: a `FREE` binding beside one paid
   * binding does not make the paid price a range (review 2026-10-15, L2).
   */
  @ApiProperty({
    description:
      'Routable bindings that can be charged (PAID or FREEMIUM). Print "up to" only when ' +
      'this is above one.',
  })
  paidBindings: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Why nothing is routable — the router’s own summary, not a guess.',
  })
  unroutableReason: string | null;

  /**
   * Every chain a routable binding of this tool could settle on, CAIP-2.
   *
   * ## What it is for
   *
   * A tool that settles somewhere the buyer cannot pay must be **shown
   * with a caveat, not hidden** — hiding it makes the platform look like it
   * lacks the tool. This catalogue is anonymous and is deliberately NOT
   * narrowed to any buyer's chains, so {@link price} is a price some readers
   * cannot use, and this is the field that says so. Without it the first thing
   * a buyer learns about the mismatch is `PAYMENT_NO_SETTLEABLE_CHAIN` on a
   * call they have already decided to make.
   *
   * ## The same fact the MCP surface publishes, from the same derivation
   *
   * `tools/list` publishes this as `x402/settlementChains`
   * (`X402_SETTLEMENT_CHAINS`), and both come from the identical expression:
   * `ProviderRouterService.quote(...).settlementChains`, the union of
   * `settleableChains(candidate, context)` over the ELIGIBLE set. Same name,
   * same CAIP-2 values, one derivation. A second derivation off
   * `tool_bindings.settlement_chains` would have been easy and would drift
   * from the router's answer invisibly — the binding's declared list is
   * narrowed by the provider's ACTIVE enrolments and by `ENABLED_CHAINS`
   * before it becomes a chain a call can actually settle on.
   *
   * ## `null` is UNKNOWN, and it is never an empty array
   *
   * `null` when nothing is routable ({@link routable} is `false`, and
   * {@link unroutableReason} says why). There is then no set of chains a call
   * would settle on, because there is no call to be had — and an empty array
   * would say the opposite of that: it reads as "settles nowhere you can pay",
   * which turns a temporarily unroutable tool into one the buyer is told to
   * give up on. A false negative that hides a working tool is exactly what
   * must not happen, and it would be indistinguishable from the real thing.
   *
   * This is where the shape diverges from the MCP annotation, which is
   * unconditional and may be empty — and the divergence is forced by a state
   * the MCP surface does not have. `tools/list` omits a tool with no price
   * entirely, so its list is a union over at least one eligible candidate and
   * `filterEligible` rejects a candidate whose settleable set is empty. This
   * catalogue LISTS the unroutable tool, so it is the only one of the two that
   * ever has to say "not known".
   *
   * A non-empty list is therefore the only other value: exactly the chains a
   * call placed now would settle on.
   */
  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description:
      'CAIP-2 chains a call placed now would settle on. `null` means NOT KNOWN — ' +
      'nothing is routable — and is never an empty array, which would read as “settles ' +
      'nowhere”.',
  })
  settlementChains: string[] | null;

  @ApiProperty({
    type: [CatalogueChainPriceDto],
    description:
      'The price per chain a call can settle on, with the provider setting it — at most one entry ' +
      'per `settlementChains` entry; a chain that cannot be quoted right now is left out. Empty ' +
      'when nothing is routable.',
  })
  prices: CatalogueChainPriceDto[];
}

export class CatalogueToolListDto {
  @ApiProperty({ type: [CatalogueToolDto], description: 'Every tool a provider serves.' })
  tools: CatalogueToolDto[];
}

/** One tool as one provider serves it. */
export class CatalogueProviderToolDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty({ description: 'The catalogue name, or the id when the tool is not in the seed.' })
  name: string;

  @ApiProperty({ description: 'FREE | FREEMIUM | PAID' })
  pricingMode: string;

  @ApiProperty({ type: CatalogueMoneyDto })
  price: CatalogueMoneyDto;

  @ApiProperty({
    description:
      'The failure rate this listing promises, 0..1 (`tool_bindings.sla_failure_rate`) — the ' +
      'line its penalties are measured against.',
    example: 0.05,
  })
  promisedFailureRate: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Free calls one agent gets from this binding per UTC day — the binding’s own quota, or ' +
      'the platform default when it set none. null for a PAID binding.',
  })
  freeCallsPerAgentPerDay: number | null;

  /**
   * The chains a call to this listing can settle on now. Each enabled chain is
   * asked of the router on its own, as a call from an agent on that chain
   * would be routed (`payerChains: [chain]`), over this provider's candidates
   * only, so the stake, slash-hold, ceiling and circuit gates are the router's
   * own. `null` when the router could not be asked; `[]` when it takes no call
   * on any chain right now.
   */
  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'CAIP-2 chains a call to this listing can settle on now; [] when it takes no call; ' +
      'null when that could not be read.',
  })
  chains: string[] | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Per caller: one of your agents’ chains is in `chains`. null when unknown or unasked.',
  })
  servesYou: boolean | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['WITHDRAWING'],
    description:
      'Per caller, when servesYou is false for a reason of your own: WITHDRAWING (every agent ' +
      'has a standing withdrawal, so no chain is left to pay on). null otherwise.',
  })
  notServedReason: 'WITHDRAWING' | null;
}

export class CatalogueProviderDetailDto extends CatalogueProviderDto {
  @ApiProperty({
    type: [CatalogueProviderToolDto],
    description:
      'What this provider serves right now. Empty for a provider registered but not yet ' +
      'publishing — which is a real state, not an error.',
  })
  tools: CatalogueProviderToolDto[];
}

export class GetCatalogueProviderParamsDto {
  @ApiProperty({ description: 'The provider id.' })
  @IsUUID()
  providerId: string;
}

export class GetCatalogueToolParamsDto {
  @ApiProperty({ description: 'The tool id (`tools.id`).' })
  @IsUUID()
  toolId: string;
}
