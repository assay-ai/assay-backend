import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

import { ListQueryDto, SortDirection } from '@shared/api';

import { ToolRequestEntity } from '@database/postgres/entities/tool-request.entity';

import { ToolRequestStatus } from '../domain/tool-request-state';

export { ToolRequestStatus };

export class ToolRequestIdParamsDto {
  @ApiProperty({ description: 'The tool request id' })
  @IsUUID()
  id: string;
}

/**
 * `POST /tool-requests`'s body — the tool request form.
 *
 * Deliberately three optional fields and two required ones. There is no
 * submitted schema and no mapping document: a proposal workflow (a schema,
 * review rounds, revision history) is later work, gated on reviewers that do
 * not exist yet. What an MVP
 * requester supplies is a title, a description of what they need, and enough
 * context for the owner's first response — not a spec for us to accept
 * verbatim.
 */
export class CreateToolRequestBodyDto {
  @ApiProperty({ description: 'Short name for the tool being requested', maxLength: 160 })
  @IsString()
  @Length(1, 160)
  title: string;

  @ApiProperty({ description: 'What it should do, and why it is needed' })
  @IsString()
  @Length(1, 8000)
  description: string;

  @ApiPropertyOptional({
    description: 'The upstream API this would wrap, if there is one',
    maxLength: 2048,
  })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @Length(1, 2048)
  upstreamUrl?: string;

  @ApiPropertyOptional({ description: 'Rough expected call volume per month' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedMonthlyCalls?: number;
}

/**
 * The requester's own view of a filed ticket.
 *
 * No submitted schema, no review rounds, no revision history — see
 * `CreateToolRequestBodyDto`'s docstring. What this renders is exactly what
 * the queue promises: who owns it, the two clocks, and how it landed.
 */
export class ToolRequestDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  description: string;

  @ApiPropertyOptional({ nullable: true })
  upstreamUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  expectedMonthlyCalls: number | null;

  @ApiProperty({ enum: ToolRequestStatus })
  status: ToolRequestStatus;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The operator who owns this ticket. Null until the first response assigns one.',
  })
  ownerOperatorId: string | null;

  @ApiProperty({ description: 'The two-working-day promise, computed at filing' })
  firstResponseDueAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description: 'When the first response landed, whichever of the three outcomes it was',
  })
  firstRespondedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  resolutionNote: string | null;

  @ApiPropertyOptional({ nullable: true })
  closedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The DRAFT standard tool an accepted request created (design spec §7.5)',
  })
  toolId: string | null;

  @ApiProperty()
  createdAt: Date;

  static fromEntity(entity: ToolRequestEntity): ToolRequestDto {
    const dto = new ToolRequestDto();
    dto.id = entity.id;
    dto.title = entity.title;
    dto.description = entity.description;
    dto.upstreamUrl = entity.upstreamUrl;
    dto.expectedMonthlyCalls = entity.expectedMonthlyCalls;
    dto.status = entity.status as ToolRequestStatus;
    dto.ownerOperatorId = entity.ownerOperatorId;
    dto.firstResponseDueAt = entity.firstResponseDueAt;
    dto.firstRespondedAt = entity.firstRespondedAt;
    dto.resolutionNote = entity.resolutionNote;
    dto.closedAt = entity.closedAt;
    dto.toolId = entity.toolId ?? null;
    dto.createdAt = entity.createdAt;
    return dto;
  }
}

/** `GET /tool-requests` — the caller's own, cursor-paginated. */
export class ListToolRequestsQueryDto extends ListQueryDto {}

/**
 * `GET /operator/tool-requests` — one row of the queue.
 *
 * Deliberately thinner than `ToolRequestDto`: the queue is a worklist, not the
 * ticket brief, so it carries what a triager scans a list for and nothing
 * that needs its own join. `organizationId` is included because the operator
 * has no tenant of their own and this is the one field that says whose
 * request it is.
 */
export class OperatorToolRequestQueueRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional({ nullable: true })
  expectedMonthlyCalls: number | null;

  @ApiProperty({ enum: ToolRequestStatus })
  status: ToolRequestStatus;

  @ApiPropertyOptional({ nullable: true })
  ownerOperatorId: string | null;

  @ApiProperty({ description: 'The clock the queue is ordered by' })
  firstResponseDueAt: Date;

  @ApiProperty()
  createdAt: Date;

  static fromEntity(entity: ToolRequestEntity): OperatorToolRequestQueueRowDto {
    const dto = new OperatorToolRequestQueueRowDto();
    dto.id = entity.id;
    dto.organizationId = entity.organizationId;
    dto.title = entity.title;
    dto.expectedMonthlyCalls = entity.expectedMonthlyCalls;
    dto.status = entity.status as ToolRequestStatus;
    dto.ownerOperatorId = entity.ownerOperatorId;
    dto.firstResponseDueAt = entity.firstResponseDueAt;
    dto.createdAt = entity.createdAt;
    return dto;
  }
}

/**
 * `GET /operator/tool-requests`'s query.
 *
 * `order` is redeclared with a default of `asc` rather than inherited from
 * `ListQueryDto`'s `desc` — the queue is "oldest-unanswered first", and
 * `SlashProposalRepository.queueQueryBuilder`'s docstring gives the reason to
 * make that a stated default rather than an ambient one: "the ordering is the
 * requirement, not a default." A client may still ask for `order=desc`; the
 * queue's own front door does not require it to.
 */
export class ListToolRequestQueueQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    description: 'Sort direction. Defaults to `asc` — the request longest overdue first.',
    enum: SortDirection,
    default: SortDirection.ASC,
  })
  @IsOptional()
  @IsEnum(SortDirection)
  override order: SortDirection = SortDirection.ASC;

  @ApiPropertyOptional({
    enum: ToolRequestStatus,
    isArray: true,
    description:
      'Only requests in these states, e.g. `?status=ACKNOWLEDGED` to accept an acknowledged ' +
      'one later, or `?status=OPEN&status=ACKNOWLEDGED`. Omitted: the unanswered queue ' +
      '(nobody has responded yet).',
  })
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : String(value).split(',')))
  @IsEnum(ToolRequestStatus, { each: true })
  status?: ToolRequestStatus[];
}

/**
 * `PATCH /operator/tool-requests/:id`'s body — acknowledge, accept or
 * decline.
 *
 * `resolutionNote` is required exactly when `status` moves to `ACCEPTED` or
 * `DECLINED`, mirroring `chk_tool_requests_closed_is_whole` at the DTO layer
 * rather than only at the database — a request that fails validation gets a
 * `400` naming the missing field instead of a `500` off a CHECK violation.
 */
export class AnswerToolRequestBodyDto {
  @ApiProperty({
    enum: [ToolRequestStatus.ACKNOWLEDGED, ToolRequestStatus.ACCEPTED, ToolRequestStatus.DECLINED],
    description: 'The queue offers three moves; `OPEN` is never a target.',
  })
  @IsEnum(ToolRequestStatus)
  status: ToolRequestStatus.ACKNOWLEDGED | ToolRequestStatus.ACCEPTED | ToolRequestStatus.DECLINED;

  @ApiPropertyOptional({
    description: 'Why. Required when accepting or declining; ignored on a bare acknowledge.',
  })
  @ValidateIf(
    (body: AnswerToolRequestBodyDto) =>
      body.status === ToolRequestStatus.ACCEPTED || body.status === ToolRequestStatus.DECLINED,
  )
  @IsString()
  @Length(1, 4000)
  resolutionNote?: string;

  @ApiPropertyOptional({
    example: 'get_tide_times',
    description:
      'ACCEPTED only: the name of the DRAFT standard tool the request creates. Derived ' +
      'from the title when omitted (snake_case, made unique).',
  })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]{1,47}$/)
  toolName?: string;

  @ApiPropertyOptional({
    example: 'weather',
    description: 'ACCEPTED only; `uncategorised` when omitted',
  })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9-]{1,63}$/)
  toolCategory?: string;
}
