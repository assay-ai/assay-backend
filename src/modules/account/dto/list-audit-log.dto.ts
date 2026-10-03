import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { ListQueryDto } from '@shared/api';

/**
 * `GET /api/v1/audit-log` — who did what.
 *
 * Read-only: `audit_log_entries` is append-only (see the entity's class
 * comment), so this module has no write endpoint for it, only this one.
 */
export class ListAuditLogQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Exact match on actor_id' })
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional({ description: 'Exact match, e.g. `spend_policy.updated`' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Exact match, e.g. `spend_policy`, `agent_credential`' })
  @IsOptional()
  @IsString()
  resourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resourceId?: string;
}

export class AuditLogEntryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['user', 'agent', 'system', 'provider'] })
  actorType: string;

  @ApiProperty()
  actorId: string;

  @ApiProperty({ description: 'Dotted, past-tense — e.g. `credential.revoked`' })
  action: string;

  @ApiProperty()
  resourceType: string;

  @ApiPropertyOptional({ nullable: true })
  resourceId: string | null;

  @ApiPropertyOptional({ nullable: true })
  before: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  after: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  ipAddress: string | null;

  @ApiPropertyOptional({ nullable: true })
  userAgent: string | null;

  @ApiPropertyOptional({ nullable: true })
  requestId: string | null;

  @ApiProperty()
  createdAt: Date;
}
