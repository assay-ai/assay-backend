import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { OfficialToolsetDto } from '@modules/toolset/dto/official-toolset.dto';
import { PLAIN_TEXT_RE } from '@modules/toolset/dto/toolset-publishing.dto';
import {
  CATEGORY_RE,
  TAG_RE,
  TOOLSET_ICONS,
  TOOLSET_SLUG_RE,
} from '@modules/toolset/dto/toolset.dto';
import { OFFICIAL_TOOLSET_LIMITS } from '@modules/toolset/services/official-toolsets.service';

import { ContractActionBodyDto } from './operator-contracts.dto';

/**
 * Official tool sets in the operator console (`/operator/toolsets/official`,
 * design spec §7.10). Drafting is not an override; publishing is `P-13`,
 * two-person. Delist and relist are the existing `A-15` / `A-20` routes.
 */
/** The fields a create and an update share, all optional. */
class OfficialToolsetFieldsDto {
  @ApiPropertyOptional({ maxLength: 280, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  @Matches(PLAIN_TEXT_RE)
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Changes the live row at once (not versioned); inferred from the tools when omitted on create',
  })
  @IsOptional()
  @Matches(CATEGORY_RE)
  category?: string | null;

  @ApiPropertyOptional({
    type: [String],
    maxItems: OFFICIAL_TOOLSET_LIMITS.tags,
    description: 'Changes the live row at once (not versioned)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(OFFICIAL_TOOLSET_LIMITS.tags)
  @Matches(TAG_RE, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: TOOLSET_ICONS, nullable: true })
  @IsOptional()
  @IsIn(TOOLSET_ICONS)
  icon?: (typeof TOOLSET_ICONS)[number] | null;

  @ApiPropertyOptional({
    type: [String],
    maxItems: OFFICIAL_TOOLSET_LIMITS.pinnedTools,
    description: '"Always loaded" tool names, each one of the set',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(OFFICIAL_TOOLSET_LIMITS.pinnedTools)
  @IsString({ each: true })
  @MaxLength(48, { each: true })
  pinnedTools?: string[];
}

const TOOL_IDS_DESCRIPTION =
  'The tools, in order. Each a LISTED, ACTIVE tool; routed to its current major (a tool ' +
  'already in the set keeps its range), provider mode BEST';

/** `POST /operator/toolsets/official` — a Draft; not an override. */
export class CreateOfficialToolsetBodyDto extends OfficialToolsetFieldsDto {
  @ApiProperty({ example: 'web-research', description: 'Fixed from the first publish' })
  @Matches(TOOLSET_SLUG_RE)
  slug: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @Length(1, 80)
  @Matches(PLAIN_TEXT_RE)
  name: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: OFFICIAL_TOOLSET_LIMITS.tools,
    description: TOOL_IDS_DESCRIPTION,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OFFICIAL_TOOLSET_LIMITS.tools)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  toolIds: string[];
}

/** `PATCH /operator/toolsets/official/:id` — every field optional; not an override. */
export class UpdateOfficialToolsetBodyDto extends OfficialToolsetFieldsDto {
  @ApiPropertyOptional({ example: 'web-research', description: 'Fixed from the first publish' })
  @IsOptional()
  @Matches(TOOLSET_SLUG_RE)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  @Matches(PLAIN_TEXT_RE)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: OFFICIAL_TOOLSET_LIMITS.tools,
    description: TOOL_IDS_DESCRIPTION,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OFFICIAL_TOOLSET_LIMITS.tools)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  toolIds?: string[];
}

/** `POST /operator/toolsets/official/:id/publish` — P-13. */
export class PublishOfficialToolsetBodyDto extends ContractActionBodyDto {
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

export class PendingOfficialPublishDto {
  @ApiProperty()
  approvalId: string;

  @ApiProperty({ description: 'Operator id of who asked' })
  requestedBy: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

export class OperatorOfficialToolsetDto extends OfficialToolsetDto {
  @ApiProperty({
    type: PendingOfficialPublishDto,
    nullable: true,
    description:
      'A publish waiting for its second operator. The Draft is frozen until it is approved, ' +
      'rejected or expires',
  })
  pendingPublish: PendingOfficialPublishDto | null;
}

export class OperatorOfficialToolsetListDto {
  @ApiProperty({ type: [OperatorOfficialToolsetDto] })
  toolsets: OperatorOfficialToolsetDto[];
}
