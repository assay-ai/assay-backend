import { ToolVersionBriefDto } from '@modules/tool/dto/tool-contract-version.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';

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
 * - `quality` — the measured pass rate over the last 30 days of SLA windows,
 *   open and closed, aggregated across all buyers; it names no buyer.
 * - `prices` — the quote per chain with the `providerId` setting it, the same
 *   public id the provider list already carries.
 * - `promisedFailureRate` — the rate a listing promises; the provider published it.
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

export class PublicChainPriceDto {
  @ApiProperty({ description: 'CAIP-2 chain a call settles on at this price' })
  chainId: string;

  @ApiProperty({ type: PublicMoneyDto, description: 'The most a call on this chain is charged.' })
  price: PublicMoneyDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The provider whose listing sets this price; null when none can be named.',
  })
  providerId: string | null;
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

  @ApiProperty({ description: 'The failure rate this listing promises, 0..1.', example: 0.05 })
  promisedFailureRate: number;

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

  @ApiProperty({
    type: [PublicChainPriceDto],
    description:
      'The price per chain, with the provider setting it. Empty when nothing is routable.',
  })
  prices: PublicChainPriceDto[];
}

export class PublicToolListDto {
  @ApiProperty({ type: [PublicToolDto] })
  tools: PublicToolDto[];
}

/** `GET /public/catalogue/tools?category=` — one topic of the catalogue. */
export class ListPublicToolsQueryDto {
  @ApiPropertyOptional({
    example: 'weather',
    description: 'Only tools in this category. Unknown categories answer an empty list.',
  })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9-]{1,63}$/)
  category?: string;

  @ApiPropertyOptional({
    enum: ['STANDARD', 'PROVIDER'],
    description: 'Only standard tools ("Backed by several providers") or provider tools.',
  })
  @IsOptional()
  @IsIn(['STANDARD', 'PROVIDER'])
  kind?: 'STANDARD' | 'PROVIDER';
}
