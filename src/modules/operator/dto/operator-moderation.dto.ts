import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

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

export class ModerationCutoffDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['TOOLSET', 'HANDLE', 'TOOL'] })
  targetType: string;

  @ApiProperty()
  targetId: string;

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
