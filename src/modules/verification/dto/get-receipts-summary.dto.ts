import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';

import { ReceiptsSummaryGroupBy } from '@database/postgres/repositories/payment-intent.repository';

import { MoneyDto } from './get-receipt.dto';

export { ReceiptsSummaryGroupBy };

/** The one value this ever takes. A discriminated set of one still needs naming. */
export enum SummaryCompareTo {
  PREVIOUS_PERIOD = 'previous_period',
}

/**
 * `GET /receipts/summary`.
 *
 * ## `groupBy` / `compareTo`, renamed from `group_by` / `compare_to`
 *
 * These were first named in snake_case because that is how the UI
 * specifications wrote them, and it was the only endpoint of its kind at the
 * time. The dashboard API surface puts roughly
 * forty query parameters on the surface — `toolId`, `providerId`, `unreadOnly`,
 * `verdictStatus`, `subjectType`, `resourceType` — every one of them camelCase,
 * matching the JSON bodies. Two of them in snake_case is not a naming
 * preference, it is the "one filter style" the API surface exists to establish,
 * broken on the two endpoints a dashboard hits most.
 *
 * A client cannot infer which convention an unfamiliar parameter uses, so it
 * guesses; under this app's `forbidNonWhitelisted` `ValidationPipe` a guess is
 * a 400 rather than a silent drop, which is survivable but is a papercut on
 * every screen that reads a summary.
 *
 * No `@Expose({ name: … })` alias is kept. An alias would mean the surface
 * accepts both spellings forever, which is the inconsistency rather than a
 * migration away from it — and there is no external client yet to migrate.
 */
export class GetReceiptsSummaryQueryDto {
  @ApiProperty({ description: 'ISO 8601 — inclusive lower bound', example: '2026-08-01T00:00:00Z' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO 8601 — exclusive upper bound', example: '2026-08-16T00:00:00Z' })
  @IsISO8601()
  to: string;

  @ApiProperty({ enum: ReceiptsSummaryGroupBy })
  @IsEnum(ReceiptsSummaryGroupBy)
  groupBy: ReceiptsSummaryGroupBy;

  @ApiPropertyOptional({ enum: SummaryCompareTo })
  @IsOptional()
  @IsEnum(SummaryCompareTo)
  compareTo?: SummaryCompareTo;

  /**
   * CAIP-19 asset id. Not part of the documented contract, but required in
   * practice the moment an organization has activity in more than one asset:
   * a `Money` sum across assets is not a number (`MoneyUtil.sum` refuses it),
   * so a window with mixed assets and no filter is rejected rather than
   * silently summed as if both were the same currency. See `ReceiptSummaryService`.
   */
  @ApiPropertyOptional({
    description: 'CAIP-19 asset id — required if the window spans more than one',
  })
  @IsOptional()
  @IsString()
  asset?: string;
}

export class ReceiptsSummaryFigures {
  @ApiProperty()
  calls: number;

  @ApiProperty({ type: MoneyDto })
  listedTotal: MoneyDto;

  /**
   * Served and collected (or being collected). An open or written-off buyer
   * debt is not in here: it is {@link owedTotal}.
   */
  @ApiProperty({
    type: MoneyDto,
    description:
      'Served and collected, or being collected. Excludes open and written-off buyer debt ' +
      '(owedTotal).',
  })
  chargedTotal: MoneyDto;

  /**
   * The guarantee's `withheld`: the price of `REFUNDED` / `VOIDED` / `EXPIRED`
   * calls that had a hold — the figure that reconciles to `Σ HOLD_RELEASE`.
   * It is part of {@link notChargedTotal}, not all of it.
   */
  @ApiProperty({
    type: MoneyDto,
    description: 'Held then released without a charge (REFUNDED / VOIDED / EXPIRED with a hold)',
  })
  withheldTotal: MoneyDto;

  /**
   * Everything the buyer was not charged for and does not owe: refunded,
   * voided and expired calls, and served calls that were never collected and
   * are not owed (forfeited by the provider, voided debt). A written-off debt
   * is not in here: the buyer still owes it ({@link owedTotal}).
   *
   * `listedTotal = chargedTotal + notChargedTotal + owedTotal + inProgressTotal`,
   * exactly, in every group and in `totals` (R17b-B-01).
   */
  @ApiProperty({
    type: MoneyDto,
    description:
      'Not charged: refunded / voided / expired, or served but never collected and not owed ' +
      '(forfeited, voided debt). listed = charged + notCharged + owed + inProgress.',
  })
  notChargedTotal: MoneyDto;

  @ApiProperty({ description: 'Calls in notChargedTotal' })
  notChargedCalls: number;

  /**
   * Served, payment not collected yet, and still owed by the buyer: an open
   * buyer debt, or a written-off one (the write-off ends the provider's wait,
   * not the buyer's debt: paid calls stay refused until it re-signs). Neither
   * charged nor not charged.
   */
  @ApiProperty({
    type: MoneyDto,
    description:
      'Buyer debt, open or written off: served, payment not collected yet, still owed by the ' +
      'buyer (neither charged nor not charged)',
  })
  owedTotal: MoneyDto;

  @ApiProperty({ description: 'Calls in owedTotal' })
  owedCalls: number;

  /** Calls not finished yet, at their listed price. */
  @ApiProperty({ type: MoneyDto, description: 'Calls not finished yet, at their listed price' })
  inProgressTotal: MoneyDto;

  @ApiProperty({ description: 'Calls in inProgressTotal' })
  inProgressCalls: number;

  /**
   * Calls this group refunded — the numerator of {@link failRate}, published
   * beside it so the rate is checkable rather than asserted.
   */
  @ApiProperty({ description: 'Calls whose verdict struck the response down (REFUNDED)' })
  refundedCalls: number;

  /**
   * **Verification failures only** — `refundedCalls / calls`, `null` when
   * `calls` is 0.
   *
   * Deliberately *not* "calls that went wrong". `VOIDED` and `EXPIRED` calls
   * are excluded: a provider timeout is not the verification engine catching
   * bad data, and the two must
   * stay separated everywhere precisely because merging them oversells the
   * guarantee. The same split is why `withheld` has two buckets — read
   * `withheldTotal`'s decomposition for the other half of the picture.
   *
   * `null` rather than `0` on an empty group: no calls means no rate, and a
   * rendered `0%` would read as "nothing failed" on a group where nothing
   * happened. No design doc defines this metric; this is the definition.
   */
  @ApiPropertyOptional({
    nullable: true,
    description:
      'refundedCalls / calls — verification failures only, excluding VOIDED and EXPIRED. ' +
      'null when calls is 0.',
  })
  failRate: number | null;
}

/** A signed comparison amount. Never `Money` — a delta may be negative, `Money` may not. */
export class SignedAmountDto {
  @ApiProperty({
    description: 'Signed atomic units as a decimal integer string',
    example: '-15000',
  })
  amount: string;

  @ApiProperty()
  asset: string;

  @ApiProperty()
  decimals: number;
}

export class ReceiptsSummaryComparison extends ReceiptsSummaryFigures {
  @ApiProperty()
  deltaCalls: number;

  @ApiProperty({ type: SignedAmountDto })
  deltaListedTotal: SignedAmountDto;

  @ApiProperty({ type: SignedAmountDto })
  deltaChargedTotal: SignedAmountDto;

  @ApiProperty({ type: SignedAmountDto })
  deltaWithheldTotal: SignedAmountDto;

  @ApiProperty({ type: SignedAmountDto })
  deltaNotChargedTotal: SignedAmountDto;

  @ApiProperty({ type: SignedAmountDto })
  deltaOwedTotal: SignedAmountDto;
}

export class ReceiptsSummaryGroupDto extends ReceiptsSummaryFigures {
  @ApiProperty({
    description: 'The tool id / provider id / day / status / verdict this row groups',
  })
  key: string;

  @ApiPropertyOptional({
    type: ReceiptsSummaryComparison,
    nullable: true,
    description: 'Present only when compareTo=previous_period was requested',
  })
  comparison: ReceiptsSummaryComparison | null;
}

export class GetReceiptsSummaryResponseDto {
  @ApiProperty({ type: [ReceiptsSummaryGroupDto] })
  groups: ReceiptsSummaryGroupDto[];

  @ApiProperty({
    type: ReceiptsSummaryFigures,
    description: 'Σ of every row in `groups` — reconciles exactly, by construction',
  })
  totals: ReceiptsSummaryFigures;

  @ApiProperty({ description: 'CAIP-19 asset id every total above is denominated in' })
  asset: string;
}

/**
 * `from`/`to` stay strings on the DTO (the exact ISO text the caller sent,
 * useful for error messages) and are parsed once, here, into the `Date` pair
 * the repository query actually wants — shared so the service and its tests
 * use one parsing rule rather than two.
 */
export function parseSummaryWindow(query: { readonly from: string; readonly to: string }): {
  readonly from: Date;
  readonly to: Date;
} {
  return { from: new Date(query.from), to: new Date(query.to) };
}
