import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import {
  NOT_CREDITED_CLASSES,
  NotCreditedClass,
} from '@modules/provider/domain/call-reconciliation';

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

/** One not-credited reason: a per-call export class, its calls and their worth. */
export class NotCreditedClassFigureDto {
  @ApiProperty({ enum: NOT_CREDITED_CLASSES, description: 'The per-call export class' })
  class: NotCreditedClass;

  @ApiProperty({ description: 'Calls of this class' })
  calls: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Σ provider_amount over those calls. `null` — see `earned`.',
  })
  amount: MoneyDto | null;
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
 * `withheld` is the provider's "Not credited": `Σ provider_amount` over the
 * calls the per-call export classifies as not credited (`NOT_CREDITED_CLASSES`
 * in `provider/domain/call-reconciliation.ts`: a failed check, an endpoint
 * error, a refused request), held or not. `withheldByClass` itemises it, and
 * `withheld` / `withheldCalls` are exactly the sum of its rows.
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
    nullable: true,
    description:
      'Not credited: Σ provider_amount over the calls that earned nothing because of their ' +
      'answer or request (a failed check, an endpoint error, a refused request), held or not. ' +
      'Exactly the sum of `withheldByClass`. `null` — see `earned`.',
  })
  withheld: MoneyDto | null;

  @ApiProperty({ description: 'Calls counted in `withheld`; the sum of `withheldByClass` calls' })
  withheldCalls: number;

  @ApiProperty({
    type: [NotCreditedClassFigureDto],
    description:
      '`withheld` by reason: one row per not-credited class, always all three, in a fixed order',
  })
  withheldByClass: NotCreditedClassFigureDto[];

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
      'Σ provider_amount over SETTLED calls whose payment is HELD for the dispute window or by ' +
      'an open dispute (rail B: in the escrow’s hold; rail A: credit withheld) and not yet ' +
      'payable. Credited once collected; never if an upheld dispute refunds it. Not in ' +
      '`earned`. `null` — see `earned`.',
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

  // ── Payout stages (SPEC-W2 §11, API-W2 §3.2): current state, not windowed ──

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Passed, being recorded on chain',
  })
  awaitingSettlement?: MoneyDto | null;

  @ApiPropertyOptional()
  awaitingSettlementCalls?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Upper bound (ISO) by which the OLDEST call awaiting settlement is settled on chain: its ' +
      "admission plus the longer of the two doors' maximum waits. Usually sooner.",
  })
  nextSettleAt?: string | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'On chain, in the dispute hold',
  })
  inDisputeHold?: MoneyDto | null;

  @ApiPropertyOptional()
  inDisputeHoldCalls?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Earliest end of a dispute hold among those (ISO)',
  })
  disputeHoldEndsAt?: string | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Hold ended, paid in the next payout',
  })
  readyForPayout?: MoneyDto | null;

  @ApiPropertyOptional()
  readyForPayoutCalls?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Estimated next payout (ISO): the earliest over both payment doors, never before the ' +
      'earliest hold end. Per-call holds: an upper bound (64 items or the maximum wait).',
  })
  nextPayoutAt?: string | null;

  @ApiPropertyOptional({ enum: ['HOURLY', 'EVERY_6_HOURS'] })
  payoutCadence?: 'HOURLY' | 'EVERY_6_HOURS';

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'Paid out, but set aside by the escrow because the token refused the transfer (an issuer ' +
      'freeze on the payout address): NOT in your wallet yet. Paid once the freeze lifts and the ' +
      'platform claims it.',
  })
  unpaid?: MoneyDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Since when the oldest unpaid payout waits (ISO)',
  })
  unpaidSince?: string | null;

  @ApiPropertyOptional({
    description:
      'The unpaid payouts per asset, every asset whatever `asset` asked for: `{ amount, since }` ' +
      'each. Empty with nothing unpaid.',
  })
  unpaidByAsset?: Array<{ amount: MoneyDto; since: string | null }>;
}
