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
 * Owner and reporter organization ids, a toolset id where the path that
 * answered does not serve the toolset, the unlisted token (except on the
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

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Also return `diff` from this version to `v`; both must be served by the link',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  diffFrom?: number;
}

export class PublicToolsetVersionPathDto extends PublicToolsetPathDto {
  @ApiProperty({ minimum: 1, example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  v: number;
}

export class PublicToolsetVersionQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    description: 'Also return `diff` from this version; it must be served on `/@…` too',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  diffFrom?: number;
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
  @ApiProperty({
    format: 'uuid',
    description:
      'For `POST /toolsets/:id/copy`, reports and access. Only on a toolset served on the path ' +
      'that answered (listed, or the link the caller holds); those calls re-check it by id.',
  })
  id: string;

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

  @ApiProperty({
    description:
      '"Routes to the publisher\'s own provider": for at least one tool, the published rules ' +
      "leave only providers of the publisher's organization (by effect, whatever the mode)",
  })
  routesToPublisher: boolean;
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

  @ApiProperty({ description: 'A tool not reviewed for the catalogue: "Not reviewed"' })
  notReviewed: boolean;

  @ApiProperty({ type: String, nullable: true, example: '^1', description: 'Contract majors (T3)' })
  toolVersionRange: string | null;

  @ApiProperty({ type: [String], description: '"Must return": required output fields (T3)' })
  requireOutputFields: string[];
}

export class PublicToolsetDiffDto {
  @ApiProperty()
  from: number;

  @ApiProperty()
  to: number;

  @ApiProperty({ type: [String], description: 'Tool names' })
  added: string[];

  @ApiProperty({ type: [String], description: 'Tool names' })
  removed: string[];

  @ApiProperty({ type: [String], description: 'Tools in both whose provider rules differ' })
  rulesChanged: string[];

  @ApiProperty({
    type: [String],
    description: 'discovery, searchThreshold, pinnedTools, name, description, icon',
  })
  settingsChanged: string[];
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

  @ApiProperty({ description: 'Any entry is "Not reviewed"' })
  notReviewed: boolean;

  @ApiProperty({
    type: PublicToolsetDiffDto,
    nullable: true,
    description: 'Only on `POST …/by-token` with `diffFrom`',
  })
  diff: PublicToolsetDiffDto | null;

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

/** One version served on `/@…`, with its snapshot: what a follower is offered. */
export class PublicToolsetVersionDetailDto extends PublicToolsetVersionDto {
  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  icon: string | null;

  @ApiProperty({ type: [String] })
  toolIds: string[];

  @ApiProperty({ type: [PublicToolsetEntryDto] })
  entries: PublicToolsetEntryDto[];

  @ApiProperty({ description: 'Any entry is "Not reviewed"' })
  notReviewed: boolean;

  @ApiProperty({ description: 'As on the card, for this version' })
  routesToPublisher: boolean;

  @ApiProperty({
    type: PublicToolsetDiffDto,
    nullable: true,
    description: 'From `diffFrom` to this version; `null` without `diffFrom`',
  })
  diff: PublicToolsetDiffDto | null;
}

export class PublicToolsetVersionListDto {
  @ApiProperty({ type: [PublicToolsetVersionDto] })
  versions: PublicToolsetVersionDto[];
}

/** One LISTED provider tool on a public name's page (§7.4 `/@{handle}`, §7.10). */
export class PublicHandleToolDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'acme__search_posts', description: '`{handle}__{tool}`' })
  name: string;

  @ApiProperty({ description: 'The 200-character summary an agent reads in tools/list' })
  summary: string;

  @ApiProperty()
  category: string;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ enum: ['UNVERIFIED', 'VERIFIED'], description: 'Never GUARANTEED (§7.6)' })
  tier: string;

  @ApiProperty({ example: '1.2.0', nullable: true })
  version: string | null;

  @ApiProperty({ enum: ['PROVIDER'] })
  kind: 'PROVIDER';

  @ApiProperty({ description: 'Always true here: only reviewed (LISTED) tools are shown' })
  reviewed: boolean;

  @ApiProperty({ nullable: true, description: 'The standard tool it points to, when promoted' })
  replacementName: string | null;
}

export class PublicHandleProfileDto {
  @ApiProperty()
  handle: string;

  @ApiProperty({ nullable: true, description: 'Set when the name asked for is an old one' })
  renamedTo: string | null;

  @ApiProperty({ type: [PublicToolsetCardDto] })
  toolsets: PublicToolsetCardDto[];

  @ApiProperty({
    type: [PublicHandleToolDto],
    description: 'Every LISTED provider tool (`{handle}__{tool}`) of this public name',
  })
  tools: PublicHandleToolDto[];

  @ApiProperty({
    nullable: true,
    description:
      '`/@{handle}`: serves every tool above; null when there is none (that URL is a 404)',
  })
  mcpUrl: string | null;
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
