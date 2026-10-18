import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { MoneyDto } from './get-balances.dto';

/** The longest statement period: a year, with a leap day to spare. */
export const STATEMENT_MAX_SPAN_MS = 366 * 86_400_000;

/** `to` after `from`, and at most {@link STATEMENT_MAX_SPAN_MS} later: a bounded scan and chain read. */
@ValidatorConstraint({ name: 'statementPeriod', async: false })
export class StatementPeriodConstraint implements ValidatorConstraintInterface {
  validate(to: unknown, args: ValidationArguments): boolean {
    const from = Date.parse(String((args.object as { from?: unknown }).from));
    const end = Date.parse(String(to));
    if (Number.isNaN(from) || Number.isNaN(end)) return true; // IsISO8601 reports it
    return end > from && end - from <= STATEMENT_MAX_SPAN_MS;
  }

  defaultMessage(): string {
    return 'to must be after from, and at most 366 days later';
  }
}

/** `GET /statements/balance` — one statement period, `[from, to)`. */
export class GetStatementBalanceQueryDto {
  @ApiProperty({ description: 'ISO-8601, inclusive (a UTC month start)' })
  @IsISO8601()
  from: string;

  @ApiProperty({
    description: 'ISO-8601, exclusive (the next month start); after from, at most 366 days later',
  })
  @IsISO8601()
  @Validate(StatementPeriodConstraint)
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
