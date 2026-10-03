import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { ListQueryDto } from '@shared/api';
import { TransformToArray } from '@shared/decorators';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';

import { MoneyDto } from './get-balances.dto';

/** `GET /deposits` — deposit intents, filterable by status. */
export class ListDepositsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: DepositIntentStatus, isArray: true })
  @IsOptional()
  @IsEnum(DepositIntentStatus, { each: true })
  @TransformToArray()
  status?: DepositIntentStatus[];
}

export class DepositDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: DepositIntentStatus })
  status: DepositIntentStatus;

  @ApiProperty({ nullable: true })
  statusReason: string | null;

  @ApiProperty()
  agentId: string;

  @ApiProperty({ description: 'CAIP-10' })
  agentAccount: string;

  @ApiProperty({ type: MoneyDto, description: 'What the `402` requirements advertised' })
  requestedAmount: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'What actually landed, once observed on chain. `null` until settlement is observed',
  })
  settledAmount: MoneyDto | null;

  @ApiProperty({ description: 'CAIP-2' })
  chainId: string;

  @ApiProperty({ nullable: true, description: 'The settlement transaction signature, once known' })
  chainTxRef: string | null;

  @ApiProperty({ description: 'ISO-8601' })
  expiresAt: string;

  @ApiProperty({ description: 'ISO-8601' })
  createdAt: string;
}
