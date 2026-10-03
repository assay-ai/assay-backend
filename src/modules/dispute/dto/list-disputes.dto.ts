import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { ListQueryDto } from '@shared/api';
import { TransformToArray } from '@shared/decorators';

import { DisputeSubjectType, DisputeState } from './dispute.dto';

/**
 * `GET /api/v1/disputes`.
 *
 * `state` is an array — repeated values within one filter are OR'd, per
 * `backend/docs/api-list-contract.md`. `subjectType`, `claimType` and
 * `providerId` stay scalar: a screen filtering "verdict disputes" or "this
 * provider" names exactly one.
 */
export class ListDisputesQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    enum: DisputeState,
    isArray: true,
    description: 'Only disputes in one of these states',
  })
  @IsOptional()
  @IsEnum(DisputeState, { each: true })
  @TransformToArray()
  state?: DisputeState[];

  @ApiPropertyOptional({ enum: DisputeSubjectType })
  @IsOptional()
  @IsEnum(DisputeSubjectType)
  subjectType?: DisputeSubjectType;

  @ApiPropertyOptional({ description: 'Exact match, e.g. "MAPPING_ERROR"' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  claimType?: string;

  @ApiPropertyOptional({ description: 'Provider id, exact match' })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}
