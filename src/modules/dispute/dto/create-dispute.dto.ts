import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { DisputeSubjectType } from './dispute.dto';

/**
 * `POST /api/v1/disputes` — open a dispute.
 *
 * `subjectId` is a plain string, not `@IsUUID()`, even though all three
 * subject types are uuid today (`SLA_WINDOW`'s `windowId` included — see
 * `ListSlaWindowsQueryDto`'s comment: "a uuid now, not `w_YYYY-MM-DD`" — the
 * `w_<sequence>` form is only `label`, a display name, never what gets
 * submitted here). The column (`character varying(128)`) stays untyped at
 * the DTO layer so a future non-uuid subject id does not need a column
 * change; `DisputeService` validates the uuid shape itself for every subject
 * type that needs one, which today is all three.
 */
export class CreateDisputeBodyDto {
  @ApiProperty({ enum: DisputeSubjectType })
  @IsEnum(DisputeSubjectType)
  subjectType: DisputeSubjectType;

  @ApiProperty({ description: 'The id of the thing being disputed, within its own id space' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  subjectId: string;

  @ApiProperty({ description: 'What kind of claim this is — open-ended, not a closed enum' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  claimType: string;

  @ApiProperty({ description: 'One human explanation' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  reason: string;

  @ApiPropertyOptional({
    type: [Object],
    description: 'Free-form supporting material. Never rewritten once filed',
  })
  @IsOptional()
  @IsArray()
  evidence?: unknown[];
}
