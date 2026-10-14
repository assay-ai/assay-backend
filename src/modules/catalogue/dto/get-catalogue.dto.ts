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
 * - **{@link CatalogueProviderDto.quality}** is `null` until the provider has a
 *   closed SLA window. Not `0`, and not `1`. Roughly two thirds of providers on
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
 * **Closed windows only.** An open window's counters are still moving, and a
 * rate that changes while a buyer compares two providers is not a measurement.
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
    description: 'null until a window has closed. Not measured is not the same as perfect.',
  })
  quality: CatalogueQualityDto | null;
}

export class CatalogueProviderListDto {
  @ApiProperty({ type: [CatalogueProviderDto], description: 'Every provider serving traffic.' })
  providers: CatalogueProviderDto[];
}

export class CatalogueToolDto {
  @ApiProperty({ example: '06399979-f8b8-4c9e-a9b1-bd2a5924d442' })
  id: string;

  @ApiProperty({ example: 'get_weather' })
  name: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ enum: ToolTier })
  tier: ToolTier;

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

  @ApiProperty({ description: 'Whether a call placed now would find a provider.' })
  routable: boolean;

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

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Free calls one agent gets from this binding per UTC day — the binding’s own quota, or ' +
      'the platform default when it set none. null for a PAID binding.',
  })
  freeCallsPerAgentPerDay: number | null;
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
