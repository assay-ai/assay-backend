import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import {
  TAKEDOWN_PUBLIC_NOTE_MAX,
  TakedownReasonCode,
} from '@modules/toolset/domain/takedown-reason';

import { QueryBoolean, ReasonCode, Trimmed, TrimmedOrAbsent } from './operator-console.dto';

/** The body every moderation action carries into the override register. */
export class ModerationBodyDto {
  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 1000)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;

  @ApiPropertyOptional({ description: 'The report this acts on; resolved with it' })
  @IsOptional()
  @IsUUID()
  reportId?: string;
}

/** `POST /operator/tools/:id/takedown`: the register body, and what the provider is told. */
export class TakedownToolBodyDto extends ModerationBodyDto {
  @ApiProperty({
    enum: TakedownReasonCode,
    description: 'The reason the provider sees. `note` stays the operator’s and is never shown',
  })
  @IsEnum(TakedownReasonCode)
  publicReasonCode: TakedownReasonCode;

  @ApiPropertyOptional({
    maxLength: TAKEDOWN_PUBLIC_NOTE_MAX,
    description: 'A note written for the provider: what to fix, or whom to contact',
  })
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(TAKEDOWN_PUBLIC_NOTE_MAX)
  publicNote?: string;
}

export class RenameHandleBodyDto extends ModerationBodyDto {
  @ApiProperty({ example: 'acme-labs' })
  @Matches(/^[a-z][a-z0-9-]{2,23}$/)
  newHandle: string;
}

export class ReassignHandleBodyDto extends ModerationBodyDto {
  @ApiProperty({ description: 'The verified organization that receives the name' })
  @IsUUID()
  toOrganizationId: string;
}

export const REPORT_RESOLUTIONS = ['DISMISSED', 'DELISTED', 'TAKEN_DOWN', 'ACTIONED'] as const;

export class ResolveReportBodyDto extends ModerationBodyDto {
  @ApiProperty({ enum: REPORT_RESOLUTIONS })
  @IsIn(REPORT_RESOLUTIONS)
  resolution: (typeof REPORT_RESOLUTIONS)[number];
}

export class HandleParamDto {
  @ApiProperty()
  @Matches(/^[a-z][a-z0-9-]{2,23}$/)
  handle: string;
}

export class ListModerationQueryDto {
  @ApiPropertyOptional({
    description: 'Only the ones still waiting (unconfirmed cutoffs, open reports)',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  pending?: boolean;
}

export const CUTOFF_TARGET_TYPES = ['TOOLSET', 'HANDLE', 'TOOL'] as const;

export class ListCutoffsQueryDto {
  @ApiPropertyOptional({ description: 'Only the ones still waiting for a second operator' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  pending?: boolean;

  @ApiPropertyOptional({ enum: CUTOFF_TARGET_TYPES, description: 'Only cutoffs of this kind' })
  @IsOptional()
  @IsIn(CUTOFF_TARGET_TYPES)
  targetType?: (typeof CUTOFF_TARGET_TYPES)[number];
}

export class ModerationCutoffDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: CUTOFF_TARGET_TYPES })
  targetType: string;

  @ApiProperty()
  targetId: string;

  @ApiProperty({
    nullable: true,
    description:
      'What the target is called: a tool’s name (`acme__search_posts`), a toolset’s name, or ' +
      'the handle. Null when the target no longer exists',
  })
  targetName: string | null;

  @ApiProperty({ enum: ['DELIST', 'TAKEDOWN'] })
  action: string;

  @ApiProperty()
  actedBy: string;

  @ApiProperty()
  actedAt: string;

  @ApiProperty({ description: 'Reverted automatically unless confirmed by then' })
  confirmBy: string;

  @ApiProperty({ nullable: true })
  confirmedBy: string | null;

  @ApiProperty({ nullable: true })
  confirmedAt: string | null;

  @ApiProperty({ nullable: true })
  revertedAt: string | null;

  @ApiProperty({ nullable: true, enum: ['EXPIRED', 'REJECTED', 'LIFTED', 'REASSIGNED'] })
  revertReason: string | null;

  @ApiProperty({ nullable: true })
  reportId: string | null;

  @ApiProperty()
  note: string;
}

export class OperatorReportDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ nullable: true })
  toolsetId: string | null;

  @ApiProperty({ nullable: true })
  toolId: string | null;

  @ApiProperty({ nullable: true })
  handle: string | null;

  @ApiProperty()
  reporterOrgId: string;

  @ApiProperty()
  reason: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({ nullable: true })
  resolvedAt: string | null;

  @ApiProperty({ nullable: true })
  resolution: string | null;
}
