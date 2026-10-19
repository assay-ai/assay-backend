import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import { ListQueryDto } from '@shared/api';

import { SlaWindowOutcome, SlaWindowStatus } from '../domain/sla/sla-window';

/**
 * `GET /providers/me/sla-windows` (the live SLA list, and the verdict feed's window filter).
 *
 * `windowId` is a uuid now, not `w_YYYY-MM-DD` — there is a real `sla_windows`
 * table behind this endpoint; see
 * `ProviderSlaWindowsService`'s own comment for what the fold it replaces got
 * wrong. `from`/`to` (inherited from `ListQueryDto`) filter on `openedAt`.
 */
export class ListSlaWindowsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Only windows for this binding' })
  @IsOptional()
  @IsUUID()
  bindingId?: string;

  @ApiPropertyOptional({ enum: SlaWindowStatus, description: 'Only windows in this status' })
  @IsOptional()
  @IsIn(Object.values(SlaWindowStatus))
  status?: SlaWindowStatus;

  @ApiPropertyOptional({
    enum: SlaWindowOutcome,
    description: 'Only closed windows with this outcome. Implies status=CLOSED.',
  })
  @IsOptional()
  @IsIn(Object.values(SlaWindowOutcome))
  outcome?: SlaWindowOutcome;
}

export class GetSlaWindowParamsDto {
  @ApiProperty({ description: 'The window id, from GET /providers/me/sla-windows' })
  @IsUUID()
  windowId: string;
}

/** Alias kept for readability at the evidence route — same shape, same id. */
export class GetSlaWindowEvidenceParamsDto extends GetSlaWindowParamsDto {}

/** One row of `GET /providers/me/sla-windows` — the frozen half plus the live counters. */
export class SlaWindowSummaryDto {
  @ApiProperty({ description: 'The window id (uuid)' })
  windowId: string;

  @ApiProperty({ description: 'Provider-facing name, e.g. `w_4482` — quotable in a dispute' })
  label: string;

  @ApiProperty({ description: '1-based, per binding' })
  sequence: number;

  @ApiProperty()
  bindingId: string;

  @ApiProperty({ description: "The tool this binding implements (the catalogue's slug id)" })
  toolId: string;

  @ApiProperty({ enum: SlaWindowStatus })
  status: SlaWindowStatus;

  @ApiPropertyOptional({
    enum: SlaWindowOutcome,
    nullable: true,
    description: '`null` while OPEN',
  })
  outcome: SlaWindowOutcome | null;

  @ApiProperty()
  openedAt: Date;

  @ApiProperty({ description: '`openedAt` + the 7-day max age frozen at open' })
  deadlineAt: Date;

  @ApiPropertyOptional({ nullable: true, description: '`null` while OPEN' })
  closedAt: Date | null;

  @ApiProperty({
    description:
      'The binding’s declared failure rate as it stood when this window opened, `0..1`. May differ ' +
      'from the binding’s current `slaFailureRate`, which only takes effect at the next window boundary.',
  })
  declaredFailureRate: number;

  @ApiProperty({
    description: 'Below this many verified calls, the window cannot be slashed at all',
  })
  minVerifiedCalls: number;

  @ApiProperty({ description: 'Every call posted to this window, whatever its verdict' })
  totalCalls: number;

  @ApiProperty({ description: 'Calls carrying a quality verdict — PASS or FAIL, nothing else' })
  verifiedCalls: number;

  @ApiProperty({ description: 'The subset of verifiedCalls whose verdict was FAIL' })
  failedCalls: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'failedCalls / verifiedCalls, `0..1`. `null` when verifiedCalls is 0 — never a bare 0%.',
  })
  observedFailureRate: number | null;

  @ApiProperty({ description: 'Sum of price_amount over every posted call, minor units' })
  totalCallAmount: string;

  @ApiProperty()
  assetId: string;

  @ApiPropertyOptional({
    enum: ['WARNING', 'CRITICAL'],
    nullable: true,
    description: 'The highest warning level already delivered for this window',
  })
  warningLevel: 'WARNING' | 'CRITICAL' | null;

  @ApiProperty({
    description:
      'Set when the window closed INSUFFICIENT_SAMPLE: this binding’s sample rate should be ' +
      'escalated until 400 verified calls is reachable',
  })
  samplingEscalationRequested: boolean;
}

export class ConfidenceIntervalDto {
  @ApiProperty()
  lower: number;

  @ApiProperty()
  upper: number;
}

/**
 * `GET /providers/me/sla-windows/:windowId` — live SLA position.
 *
 * The window's stored columns plus its full live position, computed by the
 * pure `positionFor` (`domain/sla/sla-window.ts`) from those same columns —
 * nothing here is re-derived independently of what closed (or would close)
 * the window.
 */
export class GetSlaWindowResponseDto extends SlaWindowSummaryDto {
  @ApiProperty({
    enum: ['BELOW_SAMPLE_GATE', 'WITHIN_SLA', 'PROJECTED_BREACH'],
    description:
      'The live SLA state label — independent of `slashable`; a thin window can still ' +
      'project a breach',
  })
  state: 'BELOW_SAMPLE_GATE' | 'WITHIN_SLA' | 'PROJECTED_BREACH';

  @ApiProperty({
    description: 'Has the window reached the sample gate? Below it no penalty is possible.',
  })
  slashable: boolean;

  @ApiPropertyOptional({
    type: ConfidenceIntervalDto,
    nullable: true,
    description: 'Wilson 99% interval',
  })
  confidenceInterval: ConfidenceIntervalDto | null;

  @ApiProperty({ description: 'The sample size the window is expected to have when it closes' })
  projectedSampleAtClose: number;

  @ApiProperty({ description: 'The threshold that will apply at that size' })
  effectiveThresholdAtClose: number;

  @ApiProperty()
  toleranceAtClose: number;

  @ApiProperty({
    description: 'Failures the window can absorb in total, at the projected close size',
  })
  errorBudgetCalls: number;

  @ApiProperty()
  errorBudgetUsedCalls: number;

  @ApiProperty()
  errorBudgetRemainingCalls: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'used / budget. `null` when the budget is zero. Can exceed 1.',
  })
  errorBudgetUsedFraction: number | null;

  @ApiPropertyOptional({ nullable: true, description: "Today's rate, held to close" })
  projectedFailureRate: number | null;

  @ApiPropertyOptional({ nullable: true })
  projectedFailedCalls: number | null;

  @ApiProperty({ description: 'Would the current rate, held to close, breach?' })
  projectedBreach: boolean;

  @ApiProperty({
    description:
      'Is the observation already strong enough to say the true rate exceeds the declaration — ' +
      'the one-sided 99% lower bound above declaredFailureRate',
  })
  confidentlyAboveDeclared: boolean;
}

export class SlaWindowEvidenceCallDto {
  @ApiProperty()
  intentId: string;

  @ApiProperty()
  agentId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "One of VerdictStatus, or the 'UNVERIFIED' sentinel",
  })
  verdict: string | null;

  @ApiPropertyOptional({ nullable: true })
  reasonCode: string | null;

  @ApiProperty({ description: 'Did this call land in the denominator (a PASS or FAIL verdict)?' })
  countedAsQuality: boolean;

  @ApiProperty({ description: 'Did it land in the numerator? Implies countedAsQuality.' })
  countedAsFailure: boolean;

  @ApiProperty({ description: "The call's price, minor units" })
  priceAmount: string;

  @ApiProperty()
  assetId: string;

  @ApiProperty({
    description: 'When the call was posted to the window — when it was judged, not made',
  })
  postedAt: Date;
}

export class SlaWindowFailureGroupDto {
  @ApiProperty({ description: 'The reason code or agent id this group is keyed by' })
  key: string;

  @ApiProperty()
  count: number;
}

/**
 * The evidence pack for one window. Retrievable for **any** syntactically
 * valid window id, whether or not it led to a slash — providers
 * audit their own quality continuously, not only when accused.
 */
export class GetSlaWindowEvidenceResponseDto extends SlaWindowSummaryDto {
  @ApiProperty({ type: [SlaWindowEvidenceCallDto] })
  calls: SlaWindowEvidenceCallDto[];

  @ApiProperty({
    type: [SlaWindowFailureGroupDto],
    description:
      'Failing calls grouped by reason code, most common first, e.g. ' +
      '"MIN_ARRAY_LENGTH 6 · FRESHNESS 3"',
  })
  failuresByReasonCode: SlaWindowFailureGroupDto[];

  @ApiProperty({
    type: [SlaWindowFailureGroupDto],
    description:
      'Failing calls grouped by agent id, most active first, e.g. "ag_7K2 (4), 5 others"',
  })
  failuresByAgentId: SlaWindowFailureGroupDto[];
}
