import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * `GET /providers/me/reconciliation`.
 *
 * Deliberately not a `ListQueryDto` — this is one aggregate object over the
 * window, the same shape as `GetProviderEarningsQueryDto`, not a paged
 * collection. See `docs/api-list-contract.md`'s own scope (UI-paged
 * collections) and `ProviderEarningsService`'s doc comment for the same
 * reasoning applied to a sibling report endpoint.
 */
export class GetProviderReconciliationQueryDto {
  @ApiProperty({ description: 'ISO 8601 — inclusive lower bound', example: '2026-07-01T00:00:00Z' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO 8601 — exclusive upper bound', example: '2026-08-01T00:00:00Z' })
  @IsISO8601()
  to: string;

  @ApiPropertyOptional({
    description: 'CAIP-19 asset id — required if the window spans more than one',
  })
  @IsOptional()
  @IsString()
  asset?: string;
}

/**
 * One row of "why we credited less than you served" — the class breakdown table.
 *
 * `class` is a {@link CallReconciliationClass} member
 * (`@modules/provider/domain/call-reconciliation`), kept as a bare `string`
 * here rather than the enum type: this DTO is Swagger-facing wire shape, and
 * the enum already has one canonical export site.
 *
 * **Every member appears, always** — including the four with no producer yet
 * (`TEST`, `EXPLORATION`, `EXCLUDED`, and canaries folded into
 * `PAID_CREDITED`; see {@link GetProviderReconciliationResponseDto.monthlyCanaryAggregate}).
 * A class the platform has never produced a call for is a real `calls: 0`
 * row, not an absent one — the "every row has one" rule
 * would be broken by an endpoint that quietly dropped the classes it has
 * nothing to say about yet.
 */
export class ReconciliationClassRowDto {
  @ApiProperty({ description: 'A `CallReconciliationClass` member' })
  class: string;

  @ApiProperty({ description: 'Calls in this class, any status' })
  calls: number;

  @ApiProperty({
    description: 'calls / total calls in the window (our side), 0 when the window is empty',
  })
  share: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'NET. Σ provider_amount over this class’s SETTLED rows with a committed hold — what ' +
      'reached the provider, after the platform fee; the rows sum to `net` below, not to ' +
      '`gross`. `null` only when the whole window has no resolvable asset (see `asset` on the ' +
      'response).',
  })
  credited: MoneyDto | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'GROSS. Σ price_amount over the same rows as `credited` — what the buyer was billed, ' +
      'before the platform fee. The rows sum to `gross` on the response; `gross − credited` ' +
      'is the platform fee taken on this class. `null` exactly when `credited` is.',
  })
  gross: MoneyDto | null;

  @ApiProperty({ description: 'The one-line reason a human reads next to the number' })
  note: string;
}

/**
 * "This is our defect, not yours." Non-zero only when a call's `(call_class,
 * status, classification)` combination could not be mapped by
 * `classifyForReconciliation` — a case that function is written to make
 * unreachable (see its own doc comment), so this is a belt the code wears
 * rather than an expected state. Kept as a real, always-present field rather
 * than an exception the caller has to catch, so "the unexplained bucket is
 * zero" is something a client can assert on every response instead of
 * inferring from an absence.
 */
export class ReconciliationUnexplainedDto {
  @ApiProperty({
    description: 'Calls that classified into nothing. Must be 0 in a healthy system.',
  })
  calls: number;

  @ApiProperty({
    nullable: true,
    description: 'A stable reference for this incident, or `null` when `calls` is 0.',
  })
  reference: string | null;
}

/**
 * The one canary number that ever crosses to a provider: a monthly count per
 * binding, never a per-call flag. **No producer exists yet** — nothing in
 * this codebase records which settled call was a canary
 * (`SampleRateOverride.CANARY` has no writer; see `verification/domain/
 * sampling.ts`) — so this is always `[]` today. Present, not omitted: an
 * absent field would read as "this concept doesn't apply here" rather than
 * "the platform has nothing to report yet."
 */
export class ReconciliationCanaryAggregateRowDto {
  @ApiProperty()
  bindingId: string;

  @ApiProperty()
  canaryCalls: number;
}

export class GetProviderReconciliationResponseDto {
  @ApiProperty()
  from: string;

  @ApiProperty()
  to: string;

  @ApiProperty({
    nullable: true,
    description:
      'CAIP-19 asset id every amount is denominated in. `null` when the window matched no ' +
      'calls and no payouts, and no `asset` filter narrowed it.',
  })
  asset: string | null;

  @ApiProperty({
    description: 'Our call count for the period — every class summed, unexplained included',
  })
  callCount: number;

  @ApiProperty({ type: [ReconciliationClassRowDto] })
  classBreakdown: ReconciliationClassRowDto[];

  @ApiProperty({ type: ReconciliationUnexplainedDto })
  unexplained: ReconciliationUnexplainedDto;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'GROSS. Σ price_amount over the SETTLED rows with a committed hold — what buyers were ' +
      'billed for this window, before the platform fee. Equals `net + platformTake` and the ' +
      'sum of `classBreakdown[].gross` (not of `classBreakdown[].credited`, which is net).',
  })
  gross: MoneyDto | null;

  @ApiProperty({
    description:
      'The take rate calls are charged at today, in percent: `PLATFORM_FEE_BPS / 100` (default ' +
      '1000 bps = 10), the value every live call is split with. `platformTake` is not derived ' +
      'from it: it is the real Σ platform_fee stored on each call when it was priced, so the ' +
      'observed rate `platformTake / gross` equals this one only when every call in the window ' +
      'was charged at the current rate. A difference means calls priced under another rate ' +
      '(a rate change inside the window, or data written with a different PLATFORM_FEE_BPS).',
  })
  platformTakeRatePercent: number;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'PLATFORM TAKE. Σ platform_fee over the same rows as `gross` — the fee actually taken, ' +
      'per call, at the rate each call was priced at. `gross − net`, exactly.',
  })
  platformTake: MoneyDto | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'NET. Σ provider_amount over the same rows as `gross` — what the provider is owed after ' +
      'the platform fee. `gross − platformTake`, exactly, and the sum of ' +
      '`classBreakdown[].credited`.',
  })
  net: MoneyDto | null;

  @ApiProperty({ type: [ReconciliationCanaryAggregateRowDto] })
  monthlyCanaryAggregate: ReconciliationCanaryAggregateRowDto[];
}
