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
 * `provider_amount + platform_fee = price_amount` CHECK keeps in lockstep.
 * Credited means paid out of the BUYER's escrow: the platform never pays or
 * owes a provider, so a call that was not collected (`forfeited`,
 * `uncollected`) is in neither, and an open buyer debt (`debtOutstanding`) is
 * not earned until the buyer settles it.
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
      'Σ provider_amount over SETTLED calls the provider FORFEITED: it caused the payment to ' +
      'fail (stake below the minimum, or blocked), so the buyer was not charged and nobody — ' +
      'the platform included — pays it. Not in `earned`. `null` — see `earned`.',
  })
  forfeited: MoneyDto | null;

  @ApiProperty({ description: 'Calls counted in `forfeited`' })
  forfeitedCalls: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'Σ provider_amount over SETTLED calls whose payment is BUYER DEBT: it could not be ' +
      'collected yet, the price is still held in the buyer’s escrow, and the provider is paid ' +
      'from it once the buyer signs a replacement voucher (or never, if the debt is written ' +
      'off after 30 days). Not in `earned`. `null` — see `earned`.',
  })
  debtOutstanding: MoneyDto | null;

  @ApiProperty({ description: 'Calls counted in `debtOutstanding`' })
  debtOutstandingCalls: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'Σ provider_amount over SETTLED calls whose payment is still held in the buyer’s escrow ' +
      'and not yet payable: inside the dispute window, held by an open dispute, or being ' +
      'collected right after it. Paid once collected; never if an upheld dispute refunds it. ' +
      'Not in `earned`. `null` — see `earned`.',
  })
  pendingInWindow: MoneyDto | null;

  @ApiProperty({ description: 'Calls counted in `pendingInWindow`' })
  pendingInWindowCalls: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'Σ provider_amount over SETTLED calls never collected: a buyer debt written off after 30 ' +
      'days (and historical calls absorbed before buyer debt existed). Nobody owes it. Not in ' +
      '`earned`. `null` — see `earned`.',
  })
  uncollected: MoneyDto | null;

  @ApiProperty({ description: 'Calls counted in `uncollected`' })
  uncollectedCalls: number;
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
