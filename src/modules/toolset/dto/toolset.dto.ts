import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { ProviderTier } from '@modules/provider/ports/provider.types';
import { OnEmpty, ProviderMode } from '@modules/tool/domain/routing';
import { ListQueryDto } from '@shared/api';

export const TOOLSET_SLUG_RE = /^[a-z0-9-]{2,64}$/;
const CATEGORY_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ATOMIC_AMOUNT_RE = /^\d{1,78}$/;

/** The fixed icon set a toolset may pick from (design spec §7.2). */
export const TOOLSET_ICONS = [
  'search',
  'weather',
  'finance',
  'crypto',
  'maps',
  'web',
  'knowledge',
  'code',
  'data',
  'chat',
  'news',
  'social',
  'tools',
  'star',
] as const;

export const TOOLSET_DISCOVERY_MODES = ['AUTO', 'FULL', 'SEARCH'] as const;

/** An upper bound on a request body; the product limits (§7.13) are the service's. */
const MAX_ENTRIES_IN_BODY = 1_000;

export class EntryMaxPriceDto {
  @ApiProperty({ description: 'Atomic units', example: '10000' })
  @Matches(ATOMIC_AMOUNT_RE)
  amount: string;

  @ApiProperty({ description: 'CAIP-19 asset id; the decimals come from the asset registry' })
  @IsString()
  @MaxLength(256)
  asset: string;
}

/** One entry of a toolset's Draft, as written. */
export class ToolsetEntryInputDto {
  @ApiProperty({ description: '`tools.id`' })
  @IsUUID()
  toolId: string;

  @ApiPropertyOptional({
    enum: ProviderMode,
    default: ProviderMode.BEST,
    description: 'BEST = Assay picks; ONLY these providers; EXCLUDE these providers',
  })
  @IsOptional()
  @IsIn(Object.values(ProviderMode))
  providerMode?: ProviderMode;

  @ApiPropertyOptional({
    type: [String],
    description: 'Provider ids. Empty for BEST, at least one for ONLY and EXCLUDE.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  providerIds?: string[];

  @ApiPropertyOptional({ enum: ProviderTier, nullable: true })
  @IsOptional()
  @IsIn(Object.values(ProviderTier))
  minTier?: ProviderTier | null;

  @ApiPropertyOptional({ type: EntryMaxPriceDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EntryMaxPriceDto)
  maxPrice?: EntryMaxPriceDto | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 1,
    description: 'Stored; has no effect until provider quality is measured (backlog G1.1)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1)
  minQuality?: number | null;

  @ApiPropertyOptional({ enum: OnEmpty, default: OnEmpty.FAIL })
  @IsOptional()
  @IsIn(Object.values(OnEmpty))
  onEmpty?: OnEmpty;

  @ApiPropertyOptional({
    example: '^1',
    maxLength: 32,
    description:
      'The contract majors this entry routes to (T3): `^1`, or `^1 || ^2`. When omitted, ' +
      "an entry already in the Draft keeps its range and a new one gets the tool's current " +
      'major. FALLBACK_BEST never leaves it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^\^\d{1,4}(\s*\|\|\s*\^\d{1,4})*$/, {
    message: 'toolVersionRange must be a range of majors, e.g. ^1 or ^1 || ^2',
  })
  toolVersionRange?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['uv_index'],
    description:
      '"Must return": output fields every serving provider must return (T3). A hard ' +
      'constraint: providers that do not declare an optional one are skipped, and ' +
      'FALLBACK_BEST keeps it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  requireOutputFields?: string[];
}

export class CreateToolsetBodyDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional({ description: 'Generated from the name when omitted', example: 'research' })
  @IsOptional()
  @Matches(TOOLSET_SLUG_RE)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 280, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Inferred from the tools when omitted' })
  @IsOptional()
  @Matches(CATEGORY_RE)
  category?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(TAG_RE, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: TOOLSET_ICONS, nullable: true })
  @IsOptional()
  @IsIn(TOOLSET_ICONS)
  icon?: (typeof TOOLSET_ICONS)[number] | null;

  @ApiPropertyOptional({ enum: TOOLSET_DISCOVERY_MODES, default: 'AUTO' })
  @IsOptional()
  @IsIn(TOOLSET_DISCOVERY_MODES)
  discovery?: (typeof TOOLSET_DISCOVERY_MODES)[number];

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 25, description: 'API only' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  searchThreshold?: number;

  @ApiPropertyOptional({ type: [String], description: '"Always loaded" tool names, at most 5' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  pinnedTools?: string[];

  @ApiPropertyOptional({ type: [ToolsetEntryInputDto], description: 'The Draft, in order' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ENTRIES_IN_BODY)
  @ValidateNested({ each: true })
  @Type(() => ToolsetEntryInputDto)
  entries?: ToolsetEntryInputDto[];
}

/** Every field optional; `null` clears a nullable one. Entries are `PUT …/entries`. */
export class UpdateToolsetBodyDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({ description: 'Changeable until the first share (T2)' })
  @IsOptional()
  @Matches(TOOLSET_SLUG_RE)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 280, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(CATEGORY_RE)
  category?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(TAG_RE, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: TOOLSET_ICONS, nullable: true })
  @IsOptional()
  @IsIn(TOOLSET_ICONS)
  icon?: (typeof TOOLSET_ICONS)[number] | null;

  @ApiPropertyOptional({ enum: TOOLSET_DISCOVERY_MODES })
  @IsOptional()
  @IsIn(TOOLSET_DISCOVERY_MODES)
  discovery?: (typeof TOOLSET_DISCOVERY_MODES)[number];

  @ApiPropertyOptional({ minimum: 1, maximum: 500 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  searchThreshold?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  pinnedTools?: string[];
}

export class ReplaceToolsetEntriesBodyDto {
  @ApiProperty({ type: [ToolsetEntryInputDto], description: 'The whole Draft, in order' })
  @IsArray()
  @ArrayMaxSize(MAX_ENTRIES_IN_BODY)
  @ValidateNested({ each: true })
  @Type(() => ToolsetEntryInputDto)
  entries: ToolsetEntryInputDto[];
}

export class ToolsetIdParamDto {
  @ApiProperty()
  @IsUUID()
  id: string;
}

export class ListToolsetsQueryDto extends ListQueryDto {}

export class ToolsetEntryDto {
  @ApiProperty()
  position: number;

  @ApiProperty()
  toolId: string;

  @ApiProperty({ description: 'The name an agent sees' })
  toolName: string;

  @ApiProperty()
  category: string;

  @ApiProperty({ enum: ProviderMode })
  providerMode: ProviderMode;

  @ApiProperty({ type: [String] })
  providerIds: string[];

  @ApiProperty({ enum: ProviderTier, nullable: true })
  minTier: ProviderTier | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  maxPrice: MoneyDto | null;

  @ApiProperty({ nullable: true })
  minQuality: number | null;

  @ApiProperty({ enum: OnEmpty })
  onEmpty: OnEmpty;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '^1',
    description: 'The contract majors this entry routes to; null follows the current major.',
  })
  toolVersionRange: string | null;

  @ApiProperty({ type: [String], description: '"Must return": required output fields.' })
  requireOutputFields: string[];

  @ApiProperty({
    enum: ['STANDARD', 'PROVIDER'],
    description: 'PROVIDER: one maker’s own API — "No backup provider"',
  })
  kind: 'STANDARD' | 'PROVIDER';

  @ApiProperty({ description: 'The "Not reviewed" chip: a provider tool no operator approved' })
  notReviewed: boolean;

  @ApiProperty({
    enum: ['PRIVATE', 'UNLISTED', 'LISTED'],
    description:
      'A PRIVATE one keeps the set from being shared by link; an unlisted one from the catalogue',
  })
  toolVisibility: string;
}

export class ToolsetUrlsDto {
  @ApiProperty({ description: 'The live Draft, `/my/{slug}`; keys of your organization only' })
  draft: string;

  @ApiProperty({ nullable: true, description: '"Lock to vN": `/my/{slug}@{latest}`' })
  myPinned: string | null;

  @ApiProperty({ nullable: true, description: '`/@{handle}/{slug}` while PUBLIC' })
  public: string | null;

  @ApiProperty({ nullable: true, description: '`/@{handle}/{slug}@{latest}` while PUBLIC' })
  publicPinned: string | null;

  @ApiProperty({
    nullable: true,
    description: '`/u/{token}` while shared — the link is the permission',
  })
  unlisted: string | null;

  @ApiProperty({ nullable: true, description: '`/u/{token}@{latest}` while shared' })
  unlistedPinned: string | null;
}

export class ForkedFromDto {
  @ApiProperty()
  toolsetId: string;

  @ApiProperty({ nullable: true, description: "`null`: copied from its owner's Draft" })
  version: number | null;
}

export class ToolsetSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  category: string | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ nullable: true, enum: TOOLSET_ICONS })
  icon: string | null;

  @ApiProperty({ enum: ['PRIVATE', 'UNLISTED', 'PUBLIC'] })
  visibility: string;

  @ApiProperty({ enum: TOOLSET_DISCOVERY_MODES })
  discovery: string;

  @ApiProperty()
  searchThreshold: number;

  @ApiProperty({ type: [String] })
  pinnedTools: string[];

  @ApiProperty({
    description:
      'The MCP URL that serves the live Draft (`/my/{slug}`): edits reach connected agents at once',
    example: 'https://mcp.assay.ai/my/research',
  })
  mcpUrl: string;

  @ApiProperty()
  toolCount: number;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;

  @ApiProperty({ enum: ['USER', 'PLATFORM', 'PROVIDER'], description: 'The badge' })
  publisherKind: string;

  @ApiProperty({ nullable: true, description: 'Your public name, when it is claimed' })
  handle: string | null;

  @ApiProperty({ nullable: true, enum: ['LISTED', 'DELISTED'] })
  listingStatus: string | null;

  @ApiProperty({ nullable: true, description: 'The newest published version; `null` before v1' })
  latestVersion: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Old shared URLs keep serving until then ("This tool set stops working on …")',
  })
  sharingEndsAt: string | null;

  @ApiProperty({ description: 'An operator delisted it; ask to be relisted' })
  delisted: boolean;

  @ApiProperty({ description: 'Taken down for abuse: only `/my/` serves' })
  removed: boolean;

  @ApiProperty({ type: ToolsetUrlsDto })
  urls: ToolsetUrlsDto;

  @ApiProperty({ nullable: true, description: 'The link-only token while shared; owners only' })
  unlistedToken: string | null;

  @ApiProperty({
    type: ForkedFromDto,
    nullable: true,
    description: '"Copied from @handle/slug vN"',
  })
  forkedFrom: ForkedFromDto | null;
}

export class ToolsetDto extends ToolsetSummaryDto {
  @ApiProperty({ type: [ToolsetEntryDto] })
  entries: ToolsetEntryDto[];
}
