import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

import { MoneyDto } from './get-balances.dto';

/** `GET /statements/balance` — one statement period, `[from, to)`. */
export class GetStatementBalanceQueryDto {
  @ApiProperty({ description: 'ISO-8601, inclusive (a UTC month start)' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO-8601, exclusive (the next month start)' })
  @IsISO8601()
  to: string;
}

/** How the derived closing balance compares with the escrow, read now. */
export class StatementBalanceCheckDto {
  @ApiProperty({ type: MoneyDto, description: 'The escrow balance, read from the chain now' })
  escrowBalance: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      'Paid on this statement but not taken from the escrow yet (a payment still being ' +
      'settled): in the escrow balance, and in Paid',
  })
  stillSettling: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description: '`escrowBalance − stillSettling − closing`; may be negative (sign in `amount`)',
  })
  difference: MoneyDto;

  @ApiProperty({ description: 'Whether `difference` is zero' })
  matches: boolean;

  @ApiProperty({ description: 'ISO-8601: when the escrow was read' })
  observedAt: string;
}

/**
 * One escrow's money for the period: `opening + deposits − withdrawals − paid
 * = closing`. Every figure is derived from recorded deposits, indexed
 * withdrawals and charged calls; none is stored.
 */
export class StatementBalanceDto {
  @ApiProperty({ description: 'CAIP-10: the escrow' })
  account: string;

  @ApiProperty({ description: 'CAIP-2' })
  chainId: string;

  @ApiProperty({ type: MoneyDto })
  opening: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  deposits: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  withdrawals: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Charged paid calls taken from this escrow' })
  paid: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Derived, never written' })
  closing: MoneyDto;

  @ApiPropertyOptional({
    type: StatementBalanceCheckDto,
    nullable: true,
    description:
      'Only for a period that has not ended: the closing balance checked against the escrow. ' +
      'Null for a past period, or when the chain could not be read',
  })
  check: StatementBalanceCheckDto | null;
}

export class GetStatementBalanceResponseDto {
  @ApiProperty({
    type: [StatementBalanceDto],
    description: 'One per escrow whose withdrawals are indexed (eip155)',
  })
  items: StatementBalanceDto[];
}
