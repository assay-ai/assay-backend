import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import type { OperatorApprovalStatus } from '@database/postgres/entities/operator-approval.entity';
import { ListQueryDto } from '@shared/api/dto/list-query.dto';

const STATUSES: OperatorApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];

/** What a two-person route answers, with HTTP 202, when it queued the action instead. */
export class ApprovalQueuedDto {
  @ApiProperty({ description: 'Give this to a second operator to approve' })
  approvalId: string;

  @ApiProperty({ enum: ['PENDING'] })
  status: 'PENDING';

  @ApiProperty({ description: 'The queued action, e.g. `account.unblock`' })
  action: string;

  @ApiProperty()
  expiresAt: Date;
}

export class ListOperatorApprovalsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: OperatorApprovalStatus;
}

export class OperatorApprovalDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'e.g. `slash.suspend`, `account.unblock`, `operator.add`' })
  action: string;

  @ApiProperty({ description: 'The register row the action writes, e.g. `A-10`' })
  code: string;

  @ApiProperty({ description: '`<type>:<id>` of what the action is about' })
  target: string;

  @ApiProperty({ description: 'The original request, exactly as it will be re-run' })
  payload: Record<string, unknown>;

  @ApiProperty({ enum: STATUSES })
  status: OperatorApprovalStatus;

  @ApiProperty({ description: 'Subject of the operator who asked' })
  requestedBy: string;

  @ApiProperty()
  requestedById: string;

  @ApiPropertyOptional({ nullable: true })
  approvedBy: string | null;

  @ApiPropertyOptional({ nullable: true })
  rejectedBy: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional({ nullable: true })
  decidedAt: Date | null;

  @ApiProperty()
  expiresAt: Date;
}

export class ApprovalDecisionDto {
  @ApiProperty({ type: OperatorApprovalDto })
  approval: OperatorApprovalDto;

  @ApiPropertyOptional({
    description: 'On approve: what the action returned, the same body its own route answers with',
  })
  result?: unknown;
}
