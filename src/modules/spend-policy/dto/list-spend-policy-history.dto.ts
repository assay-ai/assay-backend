import { ApiProperty } from '@nestjs/swagger';

import { ListQueryDto } from '@shared/api';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { SpendPolicyScope } from './get-spend-policy.dto';

/** `GET /spend-policy/history` — no extra filters beyond the shared envelope. */
export class ListSpendPolicyHistoryQueryDto extends ListQueryDto {}

export class SpendPolicyHistoryEntryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: SpendPolicyScope })
  scope: SpendPolicyScope;

  @ApiProperty({ nullable: true })
  agentId: string | null;

  @ApiProperty()
  policyVersion: number;

  @ApiProperty({ type: MoneyDto, nullable: true })
  perCallMax: MoneyDto | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  dailyCap: MoneyDto | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  monthlyCap: MoneyDto | null;

  @ApiProperty({ nullable: true })
  maxCallsPerHour: number | null;

  @ApiProperty({ nullable: true, description: 'Per-minute call limit' })
  maxCallsPerMinute: number | null;

  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Spend-per-hour limit' })
  maxSpendPerHour: MoneyDto | null;

  @ApiProperty({ type: MoneyDto, nullable: true })
  requireApprovalAbove: MoneyDto | null;

  @ApiProperty()
  paused: boolean;

  @ApiProperty({ description: 'Who changed it' })
  changedBy: string;

  @ApiProperty({ nullable: true })
  changeReason: string | null;

  @ApiProperty({ description: 'ISO-8601 — when it changed' })
  changedAt: string;

  @ApiProperty({
    nullable: true,
    description: 'ISO-8601. `null` on exactly one row per scope: the live one',
  })
  supersededAt: string | null;
}
