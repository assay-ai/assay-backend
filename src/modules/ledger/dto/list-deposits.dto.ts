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

/**
 * Where a `SETTLED` deposit stands with chain finality. Settling credits the
 * ledger's `pending` bucket; a separate finality sweep later moves it to
 * `available` (`CONFIRMED`) or drops it after a reorg (`REJECTED`).
 */
export enum DepositFinality {
  /** Settled, credited as pending; the finality sweep has not decided yet. */
  PENDING = 'PENDING',
  /** Final: the amount is in the available balance. */
  CONFIRMED = 'CONFIRMED',
  /** Dropped by a reorg: the pending credit was reversed and nothing is available. */
  REJECTED = 'REJECTED',
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

  @ApiProperty({
    enum: DepositFinality,
    nullable: true,
    description:
      'Only for `SETTLED`: `PENDING` until chain finality, then `CONFIRMED` (available to ' +
      'spend) or `REJECTED` (reorged out). `null` for every other status. What a ' +
      'pending-deposit wait polls for, instead of `GET /balances`.',
  })
  finality: DepositFinality | null;

  @ApiProperty({ description: 'ISO-8601' })
  expiresAt: string;

  @ApiProperty({ description: 'ISO-8601' })
  createdAt: string;
}
