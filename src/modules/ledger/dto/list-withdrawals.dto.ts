import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { MoneyDto } from './get-balances.dto';

/** One withdrawal from the buyer's escrow: a request and what became of it. */
export class WithdrawalDto {
  @ApiProperty({ description: 'Stable id: the event that opened it' })
  id: string;

  @ApiProperty({ description: 'CAIP-2' })
  chainId: string;

  @ApiProperty({ description: 'CAIP-10: the escrow it came out of' })
  account: string;

  @ApiProperty({
    enum: ['PENDING', 'CLAIMED', 'CANCELLED', 'REPLACED'],
    description:
      'PENDING as far as the index has read; `GET /escrow` is the live authority on whether a ' +
      'request stands. REPLACED: a newer request overwrote it before it was claimed',
  })
  status: 'PENDING' | 'CLAIMED' | 'CANCELLED' | 'REPLACED';

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'What was asked for. Null for a claim whose request predates the index',
  })
  requested: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'What the contract paid; below `requested` if a payment landed during the hour',
  })
  received: MoneyDto | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO-8601' })
  requestedAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO-8601, as the contract froze it' })
  claimableAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO-8601: claimed, cancelled or replaced' })
  closedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  requestTransactionHash: string | null;

  @ApiPropertyOptional({ nullable: true })
  closeTransactionHash: string | null;
}

export class ListWithdrawalsResponseDto {
  @ApiProperty({ type: [WithdrawalDto], description: 'Newest first, at most 100' })
  items: WithdrawalDto[];
}
