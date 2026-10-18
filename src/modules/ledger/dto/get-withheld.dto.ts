import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional } from 'class-validator';

import { WithheldReconciliationDto } from './get-balances.dto';

/**
 * `withheld` is a summary, not a list — no cursor, no `sort`. `from`/`to`
 * follow the same half-open `[from, to)` convention as `ListQueryDto` so a
 * caller does not have to learn a second windowing rule for the one endpoint
 * that is not a list (`api-list-contract.md`).
 */
export class GetWithheldQueryDto {
  @ApiPropertyOptional({
    description: 'Inclusive lower bound on the intent’s terminal timestamp (ISO-8601).',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({
    description: 'Exclusive upper bound on the intent’s terminal timestamp (ISO-8601).',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class GetWithheldResponseDto {
  @ApiProperty({
    type: [WithheldReconciliationDto],
    description:
      'One entry per asset that has ever had a balance in this organization. Each total is ' +
      'the receipts summary’s not-charged figure for the same window: refunded, voided or ' +
      'expired calls, plus served calls never collected and not owed (bucket NOT_COLLECTED).',
  })
  withheld: WithheldReconciliationDto[];
}
