import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

export enum ProviderEarningsGroupBy {
  DAY = 'day',
  TOOL = 'tool',
}

export class GetProviderEarningsQueryDto {
  @ApiProperty({ description: 'ISO 8601 — inclusive lower bound', example: '2026-08-01T00:00:00Z' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO 8601 — exclusive upper bound', example: '2026-08-16T00:00:00Z' })
  @IsISO8601()
  to: string;

  @ApiProperty({ enum: ProviderEarningsGroupBy })
  @IsEnum(ProviderEarningsGroupBy)
  groupBy: ProviderEarningsGroupBy;

  @ApiPropertyOptional({
    description: 'CAIP-19 asset id — required if the window spans more than one',
  })
  @IsOptional()
  @IsString()
  asset?: string;
}

/**
 * One group's earnings figures, in atomic units of one asset.
 *
 * `earned` and `platformFee` are both `Σ` over credited `SETTLED` intents only —
 * `payment_intents.provider_amount` / `.platform_fee` respectively, which the
 * `provider_amount + platform_fee = price_amount` CHECK keeps in lockstep —
 * except that `platformFee` leaves out `absorbed` calls, which took no fee.
 * `withheld` is the earnings screen's "withheld itemised with reasons": `Σ
 * provider_amount` over intents that reached a terminal state paying the
 * provider nothing (`REFUNDED`, `VOIDED`, `EXPIRED`, restricted to intents that
 * actually held funds) — the provider's side of the same `WITHHELD_STATUSES`
 * set `ledger/domain/withheld.ts` defines for the agent's side, applied to
 * `provider_amount` instead of `price_amount`.
 */
export class ProviderEarningsFiguresDto {
  @ApiProperty({ description: 'Calls in this group, any terminal or in-flight status' })
  calls: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'Σ provider_amount over SETTLED intents. `null` when the window matched no rows and no ' +
      '`asset` filter was given — there is then no asset to denominate a zero in, and an empty ' +
      'CAIP-19 id would be a malformed value wearing the shape of a valid one.',
  })
  earned: MoneyDto | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Σ platform_fee over SETTLED intents. `null` — see `earned`.',
  })
  platformFee: MoneyDto | null;

  @ApiProperty({
    type: MoneyDto,
    description:
      'Σ provider_amount the provider would have earned had verification not withheld it',
  })
  withheld: MoneyDto | null;

  @ApiProperty({ description: 'Calls counted in `withheld`' })
  withheldCalls: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'The part of `earned` credited from platform funds because the voucher could never be ' +
      'redeemed (the buyer kept the money). Owed to the provider by the platform; it never ' +
      'reached the provider wallet on chain. `null` — see `earned`.',
  })
  absorbed: MoneyDto | null;

  @ApiProperty({ description: 'Calls counted in `absorbed`' })
  absorbedCalls: number;
}

export class ProviderEarningsGroupDto extends ProviderEarningsFiguresDto {
  @ApiProperty({ description: 'The day (`YYYY-MM-DD`) or tool id this row groups' })
  key: string;
}

export class GetProviderEarningsResponseDto {
  @ApiProperty({ type: [ProviderEarningsGroupDto] })
  groups: ProviderEarningsGroupDto[];

  @ApiProperty({ type: ProviderEarningsFiguresDto, description: 'Σ of every row in `groups`' })
  totals: ProviderEarningsFiguresDto;

  @ApiProperty({
    nullable: true,
    description:
      'CAIP-19 asset id every total is denominated in. `null` when the window matched no rows ' +
      'and no `asset` filter narrowed it.',
  })
  asset: string | null;
}
