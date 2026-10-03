import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { ListQueryDto } from '@shared/api';
import { TransformToArray } from '@shared/decorators';

import { LedgerHoldStatus } from '../ports/ledger.types';
import { MoneyDto } from './get-balances.dto';

/**
 * `GET /holds` — enumerated holds, `OPEN` by default.
 *
 * `status` is a filter, same AND/OR rule as every other list endpoint: absent
 * means "OPEN only", the state the dashboard screens actually need (money
 * currently reserved). Passing `status` explicitly opts into seeing resolved
 * holds too — the close-account "blocking holds" panel is the OPEN default;
 * an activity view over resolved holds is the explicit case.
 */
export class ListHoldsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    enum: LedgerHoldStatus,
    isArray: true,
    description: 'Defaults to `OPEN` only when omitted.',
  })
  @IsOptional()
  @IsEnum(LedgerHoldStatus, { each: true })
  @TransformToArray()
  status?: LedgerHoldStatus[];
}

export class HoldDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'The call this reservation is for' })
  intentId: string;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({ enum: LedgerHoldStatus })
  status: LedgerHoldStatus;

  @ApiProperty({ description: 'ISO-8601. When the reservation was taken' })
  createdAt: string;

  @ApiProperty({ description: 'Seconds since `createdAt`, computed at read time' })
  ageSeconds: number;

  @ApiProperty({
    nullable: true,
    description: 'After this, the sweeper releases the hold. `null` if the hold does not expire',
  })
  expiresAt: string | null;
}
