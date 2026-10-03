import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { ListQueryDto } from '@shared/api';
import { TransformToArray } from '@shared/decorators';

import { VerdictStatus } from '../domain/verdict';

/**
 * `GET /api/v1/verdicts` — the verdict feed, backed by
 * `verification_records`.
 *
 * `verdictStatus` is an array — repeated values within one filter are OR'd,
 * per `backend/docs/api-list-contract.md`. `toolId` / `providerId` / `sampled`
 * / `policyId` stay scalar: a screen filtering "this tool" or "sampled calls
 * only" names exactly one value.
 *
 * `policyId` filters on `decisionPolicyId` — the `(policyId, version)` pair the
 * `chk_verification_records_judged_is_whole` CHECK constraint guarantees is
 * set on every judged record. The record's other pair, `policyId` /
 * `policyVersion` (the schema/rules document), is legitimately null
 * whenever a tool's policy runs no local checks — filtering on it would silently
 * exclude every such call. See `VerificationRecordEntity`'s class comment on
 * why both pairs exist.
 */
export class ListVerdictsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    enum: VerdictStatus,
    isArray: true,
    description: 'Only records carrying one of these verdicts',
  })
  @IsOptional()
  @IsEnum(VerdictStatus, { each: true })
  @TransformToArray()
  verdictStatus?: VerdictStatus[];

  @ApiPropertyOptional({ description: 'Tool id, exact match' })
  @IsOptional()
  @IsUUID()
  toolId?: string;

  @ApiPropertyOptional({ description: 'Provider id, exact match' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    description: 'Only calls the semantic stage did (`true`) or did not (`false`) sample',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  sampled?: boolean;

  @ApiPropertyOptional({
    description: 'The decision policy id this verdict was judged under (`decisionPolicyId`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  policyId?: string;
}

/**
 * One row of the verdict feed.
 *
 * Deliberately slimmer than `VerdictDetailDto` (`GET /verdicts/:id`) — no
 * `stageResults`, `verifiers` or `tally`, which are read on the detail screen
 * only. `score` is intentionally **not sortable**: `api-list-contract.md` rule
 * 1 forbids sorting on a nullable column (a `NULL` row-value comparison drops
 * the row from pagination entirely, silently), and `score` is null on every
 * record verification has not scored. It remains filterable-by-inspection on
 * this row and sortable nowhere.
 */
export class VerdictListItemDto {
  @ApiProperty({ description: 'The verification_records row id' })
  id: string;

  @ApiProperty({ description: 'The call this judges' })
  intentId: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({ nullable: true, description: 'Null only if the router never named one' })
  providerId: string | null;

  @ApiPropertyOptional({ enum: VerdictStatus, nullable: true, description: 'Null until judged' })
  verdictStatus: VerdictStatus | null;

  @ApiPropertyOptional({ nullable: true })
  reasonCode: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '`0..1`, or null where nothing scored. Not a sortable field — see the class comment',
  })
  score: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Was the semantic stage drawn for this call',
  })
  sampled: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The decision policy that judged this call, guaranteed once judged',
  })
  decisionPolicyId: string | null;

  @ApiPropertyOptional({ nullable: true })
  decisionPolicyVersion: number | null;

  @ApiProperty({ description: '`PENDING` | `JUDGED` | `SETTLED`' })
  state: string;

  @ApiProperty()
  createdAt: Date;
}
