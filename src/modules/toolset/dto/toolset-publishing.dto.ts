import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

import { ToolsetVisibility } from '../domain/sharing';
import { ToolsetDto } from './toolset.dto';

/** The shape `/u/` accepts; anything else cannot be a token. */
export const UNLISTED_TOKEN_RE = /^[a-z0-9_-]{22,32}$/;

/** No control characters in text shown on public pages. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const PLAIN_TEXT_RE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

/** `POST /toolsets/:id/publish` — the Share dialog, in one step. */
export class PublishToolsetBodyDto {
  @ApiProperty({
    enum: ToolsetVisibility,
    description:
      'Only my team / Anyone with the link / Listed in the catalogue. UNLISTED and PUBLIC need ' +
      'a public name (`PUT /org/handle`); PRIVATE on a shared tool set stops sharing.',
  })
  @IsIn(Object.values(ToolsetVisibility))
  visibility: ToolsetVisibility;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Generated from the diff with the previous version when omitted',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(PLAIN_TEXT_RE)
  changelog?: string;
}

/** `POST /toolsets/:id/copy` — "Make my own version". */
export class CopyToolsetBodyDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'The version to copy; the latest published one when omitted (your own Draft for your own tool set)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({
    description: "Another organization's link-only tool set: the token from its link",
  })
  @IsOptional()
  @Matches(UNLISTED_TOKEN_RE)
  unlistedToken?: string;

  @ApiPropertyOptional({ maxLength: 80, description: 'The source name when omitted' })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;
}

export class ToolsetVersionParamDto {
  @ApiProperty()
  @Matches(/^[0-9a-f-]{36}$/i)
  id: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}

export class ToolsetVersionSummaryDto {
  @ApiProperty()
  version: number;

  @ApiProperty()
  publishedAt: string;

  @ApiProperty({ nullable: true })
  changelog: string | null;

  @ApiProperty()
  name: string;

  @ApiProperty()
  toolCount: number;
}

export class ToolsetVersionEntryDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty({ description: 'The name at publish time' })
  toolName: string;

  @ApiProperty({ enum: ['BEST', 'ONLY', 'EXCLUDE'] })
  providerMode: string;

  @ApiProperty({ type: [String] })
  providerIds: string[];

  @ApiProperty({ nullable: true })
  minTier: string | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  maxPrice: MoneyDto | null;

  @ApiProperty({ nullable: true })
  minQuality: number | null;

  @ApiProperty({ enum: ['FAIL', 'FALLBACK_BEST'] })
  onEmpty: string;
}

export class ToolsetVersionDto extends ToolsetVersionSummaryDto {
  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  icon: string | null;

  @ApiProperty({ enum: ['AUTO', 'FULL', 'SEARCH'] })
  discovery: string;

  @ApiProperty()
  searchThreshold: number;

  @ApiProperty({ type: [String] })
  pinnedTools: string[];

  @ApiProperty({ type: [ToolsetVersionEntryDto] })
  entries: ToolsetVersionEntryDto[];
}

export class ToolsetDiffDto {
  @ApiProperty({ type: [String] })
  added: string[];

  @ApiProperty({ type: [String] })
  removed: string[];

  @ApiProperty({ type: [String] })
  rulesChanged: string[];

  @ApiProperty({ type: [String] })
  settingsChanged: string[];
}

export class PublishResultDto {
  @ApiProperty({ type: ToolsetDto })
  toolset: ToolsetDto;

  @ApiProperty({ type: ToolsetVersionSummaryDto, nullable: true, description: 'The new version' })
  version: ToolsetVersionSummaryDto | null;

  @ApiProperty({
    type: ToolsetDiffDto,
    nullable: true,
    description: 'Against the previous version',
  })
  diff: ToolsetDiffDto | null;
}

export class CopyExcludedToolDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty()
  toolName: string;

  @ApiProperty({
    enum: ['LINK_ONLY', 'REMOVED'],
    description:
      "LINK_ONLY: another organization's link-only provider tool — keep its link connected to use it",
  })
  reason: string;
}

export class CopyResultDto {
  @ApiProperty({ type: ToolsetDto, description: 'The new PRIVATE copy' })
  toolset: ToolsetDto;

  @ApiProperty({ type: [CopyExcludedToolDto] })
  excluded: CopyExcludedToolDto[];
}

export class ToolsetOwnStatsDto {
  @ApiProperty({
    nullable: true,
    description: 'The Monday these were published; `null` before the first week',
  })
  weekStart: string | null;

  @ApiProperty({ description: 'Public figures, rounded and k-checked (`PublicFigures`)' })
  figures: Record<string, unknown> | null;

  @ApiProperty({
    description:
      'Calls, error and not-charged rates per tool, and version adoption; every cell 1–4 orgs ' +
      'contribute to reads "Fewer than 5 orgs" (`DashboardFigures`)',
  })
  dashboard: Record<string, unknown> | null;
}
