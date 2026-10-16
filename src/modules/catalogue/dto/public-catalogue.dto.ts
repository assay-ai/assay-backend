import { ApiProperty } from '@nestjs/swagger';

import { ToolTier } from '@modules/tool/ports/tool.types';

/**
 * The public Explorer's catalogue — an explicit **allowlist**, not the
 * signed-in catalogue's DTOs.
 *
 * Every class here is copied field by field by `PublicCatalogueService`, never
 * spread, so a field added to the internal `Catalogue*Dto` later does not reach
 * an anonymous reader until somebody adds it here too and argues for it. The
 * key sets are pinned in `public-catalogue.service.spec.ts`.
 *
 * ## What was audited and dropped
 *
 * - `unroutableReason` — the router's own message, and on a failed quote the
 *   raw error text. Internal; `routable: false` is all a visitor needs.
 * - `verifiedAt`, `activeBindings` — no value to a visitor beyond `verified`
 *   and `toolIds`.
 *
 * Nothing in the source DTOs carries an endpoint URL, a mapping, a contact, a
 * payout or stake-authority address, and none is added here.
 *
 * ## What stays, and why it is safe
 *
 * - `providerId` — the provider's catalogue handle, needed for the detail
 *   route. Every signed-in user already sees it; it authorizes nothing, since
 *   every write is scoped to the caller's own session.
 * - `stake` — the bonded amount per chain, the same figure that is readable on
 *   chain. Amounts only: no account or authority address.
 * - `quality` — the measured pass rate over closed SLA windows, aggregated
 *   across all buyers; it names no buyer.
 */
export class PublicMoneyDto {
  @ApiProperty({ description: 'Atomic units as a decimal integer string', example: '250000' })
  amount: string;

  @ApiProperty({ description: 'CAIP-19 asset id' })
  asset: string;

  @ApiProperty({ example: 6 })
  decimals: number;
}

export class PublicChainStakeDto extends PublicMoneyDto {
  @ApiProperty({ description: 'CAIP-2 chain the collateral is posted on' })
  chainId: string;
}

export class PublicQualityDto {
  @ApiProperty({ description: 'Passed ÷ measured, 0..1', example: 0.95 })
  rate: number;

  @ApiProperty({ description: 'Calls whose verdict counted toward the rate' })
  measuredCalls: number;

  @ApiProperty()
  failedCalls: number;
}

export class PublicProviderDto {
  @ApiProperty({ description: 'The provider’s catalogue id — the detail route’s parameter.' })
  providerId: string;

  @ApiProperty({ description: 'The provider’s registered name.' })
  name: string;

  @ApiProperty({ description: 'Identity checked by the platform. Not a quality claim.' })
  verified: boolean;

  @ApiProperty({ description: 'NEW | ESTABLISHED | TRUSTED' })
  tier: string;

  @ApiProperty({ type: [String], description: 'Tool ids this provider serves right now.' })
  toolIds: string[];

  @ApiProperty({ type: PublicMoneyDto, nullable: true, description: 'Cheapest listed price.' })
  fromPrice: PublicMoneyDto | null;

  @ApiProperty({
    type: [PublicChainStakeDto],
    description: 'Bonded stake per chain — a list, never a sum. Empty means not known.',
  })
  stake: PublicChainStakeDto[];

  @ApiProperty({
    type: PublicQualityDto,
    nullable: true,
    description: 'null until measured. Not measured is not the same as perfect.',
  })
  quality: PublicQualityDto | null;
}

export class PublicProviderListDto {
  @ApiProperty({ type: [PublicProviderDto] })
  providers: PublicProviderDto[];
}

export class PublicProviderToolDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty({ example: 'get_weather' })
  name: string;

  @ApiProperty({ description: 'FREE | FREEMIUM | PAID' })
  pricingMode: string;

  @ApiProperty({ type: PublicMoneyDto })
  price: PublicMoneyDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Free calls one agent gets per UTC day; null for a PAID binding.',
  })
  freeCallsPerAgentPerDay: number | null;
}

export class PublicProviderDetailDto extends PublicProviderDto {
  @ApiProperty({ type: [PublicProviderToolDto] })
  tools: PublicProviderToolDto[];
}

export class PublicToolDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'get_weather' })
  name: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ enum: ToolTier })
  tier: ToolTier;

  @ApiProperty({ description: 'Distinct providers serving this tool.' })
  providerCount: number;

  @ApiProperty({ type: PublicMoneyDto, nullable: true, description: 'Cheapest listed price.' })
  fromPrice: PublicMoneyDto | null;

  @ApiProperty({
    type: PublicMoneyDto,
    nullable: true,
    description: 'The most a call is held for (and charged). null when nothing is routable.',
  })
  price: PublicMoneyDto | null;

  @ApiProperty({ type: String, nullable: true, description: 'FREE | FREEMIUM | PAID' })
  pricingMode: string | null;

  /** `CatalogueToolDto.freeCallsPerDay`: free calls one agent gets a day before a call is paid. */
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Free calls per agent per day before a call is paid (FREE and FREEMIUM tools); ' +
      'null for a PAID tool.',
  })
  freeCallsPerDay: number | null;

  /** `CatalogueToolDto.paidBindings`: print "up to {price}" only when this is above one. */
  @ApiProperty({
    description:
      'Routable bindings that can be charged (PAID or FREEMIUM). Print "up to" only when ' +
      'this is above one.',
  })
  paidBindings: number;

  @ApiProperty({ description: 'Whether a call placed now would find a provider.' })
  routable: boolean;

  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'CAIP-2 chains a call would settle on; null when nothing is routable.',
  })
  settlementChains: string[] | null;
}

export class PublicToolListDto {
  @ApiProperty({ type: [PublicToolDto] })
  tools: PublicToolDto[];
}
