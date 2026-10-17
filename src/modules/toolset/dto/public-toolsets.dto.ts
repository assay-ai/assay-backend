import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { UNLISTED_TOKEN_RE } from './toolset-publishing.dto';

/**
 * The public toolset catalogue (design spec §7.9) — an explicit **allowlist**.
 *
 * Every class here is filled field by field by `PublicToolsetsService`, never
 * spread from an entity, so a column added later does not reach an anonymous
 * reader until somebody adds it here. The key sets are pinned in
 * `public-toolsets.spec.ts`.
 *
 * ## What is published
 *
 * Only what the owner published: the name, description and icon come from the
 * newest version published while shared, never from the Draft. Figures are
 * the weekly `toolset_stats_published` row, already rounded and k-checked.
 *
 * ## What is never here
 *
 * Owner and reporter organization ids, the unlisted token (except on the
 * by-token page, which the caller sent it to), grace and moderation columns,
 * the Draft, buyer identities, the publisher dashboard.
 */

export const PUBLISHER_FILTERS = ['official', 'provider', 'community'] as const;
export const TOOLSET_SORTS = ['popular', 'trending', 'new'] as const;

export class ListPublicToolsetsQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Name, description, tags, category, tool names',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ example: 'weather' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9-]{1,63}$/)
  category?: string;

  @ApiPropertyOptional({ enum: PUBLISHER_FILTERS })
  @IsOptional()
  @IsIn(PUBLISHER_FILTERS)
  publisher?: (typeof PUBLISHER_FILTERS)[number];

  @ApiPropertyOptional({ enum: TOOLSET_SORTS, default: 'popular' })
  @IsOptional()
  @IsIn(TOOLSET_SORTS)
  sort?: (typeof TOOLSET_SORTS)[number];

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  offset?: number;
}

export class PublicToolsetPathDto {
  @ApiProperty({ example: 'acme' })
  @Matches(/^[a-z][a-z0-9-]{2,23}$/)
  handle: string;

  @ApiProperty({ example: 'twitter-kit' })
  @Matches(/^[a-z0-9-]{2,64}$/)
  slug: string;
}

export class PublicHandleParamDto {
  @ApiProperty({ example: 'acme' })
  @Matches(/^[a-z][a-z0-9-]{2,23}$/)
  handle: string;
}

export class PublicToolsetByTokenBodyDto {
  @ApiProperty({
    description: 'From the link’s fragment; sent in the body so it stays out of logs',
  })
  @Matches(UNLISTED_TOKEN_RE)
  token: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  v?: number;
}

export class PublicFigureDto {
  @ApiProperty({ nullable: true, description: 'Rounded; `null` when withheld' })
  value: number | null;

  @ApiProperty({ example: 'Fewer than 5' })
  display: string;
}

export class PublicToolsetStatsDto {
  @ApiProperty({ nullable: true, description: 'The Monday the figures were published' })
  weekStart: string | null;

  @ApiProperty({ type: PublicFigureDto, nullable: true })
  activeUsers: PublicFigureDto | null;

  @ApiProperty({ type: PublicFigureDto, nullable: true })
  agents: PublicFigureDto | null;

  @ApiProperty({ type: PublicFigureDto, nullable: true })
  calls30d: PublicFigureDto | null;

  @ApiProperty({ type: PublicFigureDto, nullable: true })
  copies: PublicFigureDto | null;

  @ApiProperty({ nullable: true, enum: ['UP', 'DOWN', 'FLAT'] })
  trend: string | null;

  @ApiProperty({ nullable: true, description: 'Shown from 20 active orgs, a multiple of 10' })
  onLatestVersionPercent: number | null;
}

export class PublicToolsetUrlsDto {
  @ApiProperty({ description: 'Follows the latest version' })
  latest: string;

  @ApiProperty({
    description:
      'Pinned to the current version — what Connect hands out for Community and Provider sets',
  })
  pinned: string;

  @ApiProperty({ description: 'What the Connect sheet should offer by default' })
  recommended: string;
}

export class PublicToolsetCardDto {
  @ApiProperty({ example: 'acme' })
  handle: string;

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

  @ApiProperty({ nullable: true })
  icon: string | null;

  @ApiProperty({ enum: ['OFFICIAL', 'PROVIDER', 'COMMUNITY'] })
  badge: string;

  @ApiProperty()
  version: number;

  @ApiProperty()
  toolCount: number;

  @ApiProperty({
    type: [String],
    description: 'Tool ids, to join with `/public/catalogue/tools` for prices and backups',
  })
  toolIds: string[];

  @ApiProperty({ type: PublicFigureDto, nullable: true })
  activeUsers: PublicFigureDto | null;

  @ApiProperty({ type: PublicToolsetUrlsDto })
  mcpUrls: PublicToolsetUrlsDto;
}

export class PublicToolsetListDto {
  @ApiProperty({ type: [PublicToolsetCardDto] })
  toolsets: PublicToolsetCardDto[];

  @ApiProperty()
  total: number;
}

export class PublicToolsetEntryDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty()
  toolName: string;

  @ApiProperty({
    enum: ['BEST', 'ONLY', 'EXCLUDE'],
    description: 'Any provider / Only these / All except',
  })
  providerMode: string;

  @ApiProperty()
  providerCount: number;

  @ApiProperty({ nullable: true })
  minTier: string | null;

  @ApiProperty({ enum: ['FAIL', 'FALLBACK_BEST'] })
  onEmpty: string;

  @ApiProperty({ description: 'No longer served (removed or retired): "Removed"' })
  removed: boolean;
}

export class PublicForkedFromDto {
  @ApiProperty()
  handle: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ nullable: true })
  version: number | null;
}

export class PublicToolsetPageDto extends PublicToolsetCardDto {
  @ApiProperty({ nullable: true })
  changelog: string | null;

  @ApiProperty()
  publishedAt: string;

  @ApiProperty({ type: [PublicToolsetEntryDto] })
  entries: PublicToolsetEntryDto[];

  @ApiProperty({ type: PublicToolsetStatsDto })
  stats: PublicToolsetStatsDto;

  @ApiProperty({
    type: PublicForkedFromDto,
    nullable: true,
    description: '"Copied from @handle/slug vN", when the source is listed',
  })
  forkedFrom: PublicForkedFromDto | null;

  @ApiProperty({
    nullable: true,
    description: 'Old URLs stop serving then (a link-only page in its grace period)',
  })
  sharingEndsAt: string | null;
}

export class PublicToolsetVersionDto {
  @ApiProperty()
  version: number;

  @ApiProperty()
  publishedAt: string;

  @ApiProperty({ nullable: true })
  changelog: string | null;

  @ApiProperty()
  toolCount: number;
}

export class PublicToolsetVersionListDto {
  @ApiProperty({ type: [PublicToolsetVersionDto] })
  versions: PublicToolsetVersionDto[];
}

export class PublicHandleProfileDto {
  @ApiProperty()
  handle: string;

  @ApiProperty({ nullable: true, description: 'Set when the name asked for is an old one' })
  renamedTo: string | null;

  @ApiProperty({ type: [PublicToolsetCardDto] })
  toolsets: PublicToolsetCardDto[];

  @ApiProperty({
    type: [String],
    description: 'Provider tools (`{handle}__{tool}`); arrives with provider tools',
  })
  tools: string[];
}

export class PublicCategoryDto {
  @ApiProperty()
  category: string;

  @ApiProperty()
  tools: number;

  @ApiProperty()
  toolsets: number;
}

export class PublicCategoryListDto {
  @ApiProperty({ type: [PublicCategoryDto] })
  categories: PublicCategoryDto[];
}
