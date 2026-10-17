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
}

export class ToolsetDto extends ToolsetSummaryDto {
  @ApiProperty({ type: [ToolsetEntryDto] })
  entries: ToolsetEntryDto[];
}
