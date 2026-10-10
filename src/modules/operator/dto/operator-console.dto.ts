import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { ListQueryDto } from '@shared/api/dto/list-query.dto';
import { ArbitrationOutcome, DisputeClaimType } from '@modules/slash/domain/arbitration';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';

import { ApprovalMode, OperatorRole, OverrideFamily } from '../domain/override-register';

/** Who is holding the token, as the console renders them. */
export class OperatorDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'The SSO subject, e.g. `dan@`' })
  subject: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty({ enum: OperatorRole, isArray: true })
  roles: OperatorRole[];

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Per-action ceiling. Null means unbounded, correct for roles that move no money.',
  })
  authorityLimit: MoneyDto | null;

  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] })
  status: 'ACTIVE' | 'SUSPENDED';
}

/** The six tiles across the top of the operator console. */
export class PlatformHealthDto {
  @ApiProperty({ description: 'Payment intents created in the last minute' })
  intentsPerMinute: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Change against the same figure an hour ago, as a share. Null on a cold start.',
  })
  intentsPerMinuteDeltaVsHour: number | null;

  @ApiProperty({ description: 'Verification records still PENDING' })
  verificationBacklog: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'p95 age of the backlog, in seconds. Null when the backlog is empty.',
  })
  verificationBacklogP95AgeSeconds: number | null;

  @ApiProperty({
    description:
      'Our own false-positive rate: overturns that count against us, over proposals resolved ' +
      'in the trailing window. The single number 07-risks names as able to kill supply overnight.',
  })
  falsePositiveRate: number;

  @ApiProperty({ description: 'The gate the rate is measured against — 2%' })
  falsePositiveGate: number;

  @ApiProperty()
  policiesInShadow: number;

  @ApiProperty()
  policiesTotal: number;

  @ApiProperty({ type: MoneyDto, description: 'Stake bonded across every provider' })
  stakeLocked: MoneyDto;

  @ApiProperty()
  providersWithStake: number;

  @ApiProperty({ description: 'Cases in DISPUTED, UNDER_REVIEW or AWAITING_SECOND' })
  openDisputes: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Age of the oldest open case, in seconds. Null when there are none.',
  })
  oldestOpenDisputeAgeSeconds: number | null;
}

/**
 * One row of the adjudication queue.
 *
 * The ordering is fixed: **time-to-deadline, then penalty size — not
 * FIFO.** FIFO against a hard deadline guarantees the oldest case expires
 * first, which under the platform-miss rule means we lose it.
 */
export class AdjudicationQueueRowDto {
  @ApiProperty()
  proposalId: string;

  @ApiProperty({ description: 'e.g. `w_4471 · bnd_7QK`' })
  caseLabel: string;

  @ApiPropertyOptional({ nullable: true })
  disputeId: string | null;

  @ApiProperty()
  providerId: string;

  @ApiProperty()
  providerName: string;

  @ApiProperty({ type: MoneyDto })
  penaltyAmount: MoneyDto;

  @ApiPropertyOptional({ enum: DisputeClaimType, nullable: true })
  claimType: DisputeClaimType | null;

  @ApiProperty({ enum: SlashProposalStatus })
  status: SlashProposalStatus;

  @ApiPropertyOptional({ nullable: true, description: 'Our deadline' })
  dueAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  secondsToDeadline: number | null;

  @ApiProperty({
    description: 'True once our deadline has passed. The sweeper overturns these against us.',
  })
  overdue: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The named owner. NULL is rendered in red on purpose: a case with no owner and a running ' +
      'clock is the failure the queue exists to prevent.',
  })
  ownerSubject: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Set when this case shares a suspected root cause with others — decide once.',
  })
  rootCauseKey: string | null;

  @ApiProperty({
    description: 'How many open cases share this root cause, including this one. 1 when ungrouped.',
  })
  rootCauseGroupSize: number;

  @ApiProperty({
    description:
      'Co-failure count: other bindings on the same tool whose failure rate moved in the same ' +
      'period. This is the item that settles most platform-defect cases in seconds.',
  })
  coFailureCount: number;
}

/** One row of the override log — its five columns, plus what a filter needs. */
export class OverrideLogEntryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ enum: OverrideFamily })
  family: OverrideFamily;

  @ApiProperty({ description: 'The register row, e.g. `S-3`' })
  code: string;

  @ApiProperty({ description: 'The register row’s label, rendered as-is' })
  label: string;

  @ApiProperty({ description: 'Dotted past tense, e.g. `dispute.decided`' })
  action: string;

  @ApiProperty({ description: 'Who did it' })
  actorSubject: string;

  @ApiPropertyOptional({ nullable: true, description: 'Who approved it, on two-person rows' })
  approverSubject: string | null;

  @ApiProperty({ enum: ApprovalMode })
  approvalMode: ApprovalMode;

  @ApiProperty()
  targetType: string;

  @ApiProperty()
  targetId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The subject’s organization, when there is one',
  })
  organizationId: string | null;

  @ApiProperty()
  reasonCode: string;

  @ApiProperty()
  reason: string;

  @ApiProperty({ type: Object, description: 'The relevant fields before — not the whole row' })
  before: Record<string, unknown>;

  @ApiProperty({ type: Object })
  after: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  ticketRef: string | null;

  @ApiProperty()
  breakGlass: boolean;
}

export class ListOverrideLogQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: OverrideFamily })
  @IsOptional()
  @IsEnum(OverrideFamily)
  family?: OverrideFamily;

  @ApiPropertyOptional({ description: 'Filter to one operator’s actions' })
  @IsOptional()
  @IsUUID()
  actorOperatorId?: string;

  @ApiPropertyOptional({ description: 'e.g. `slash_proposal`' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  targetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  targetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;

  @ApiPropertyOptional({
    description: 'Full-text search over the reason — the field an incident review actually greps',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  q?: string;
}

/**
 * A query-string boolean. `@Type(() => Boolean)` is `Boolean(value)`, which reads
 * `'false'` as `true`; anything other than `'true'`/`'false'` is left for
 * `@IsBoolean` to refuse.
 */
const QueryBoolean = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });

export class ListQueueQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Only cases assigned to the calling operator' })
  @IsOptional()
  @IsBoolean()
  @QueryBoolean()
  mine?: boolean;

  @ApiPropertyOptional({ description: 'Only cases with no owner' })
  @IsOptional()
  @IsBoolean()
  @QueryBoolean()
  unassigned?: boolean;

  @ApiPropertyOptional({ description: 'Only cases past our own deadline' })
  @IsOptional()
  @IsBoolean()
  @QueryBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ description: 'Group by a suspected root cause — decide once' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  rootCauseKey?: string;
}

/**
 * The decision body.
 *
 * A reason code from a closed list **and** a hand-written explanation
 * of at least 120 characters, with no path around it for a lead or an admin.
 * Both are validated here and again at the database — `class-validator` refuses
 * the request, `chk_override_log_entries_decision_reason_length` refuses the
 * row, and neither is redundant: the first gives a usable error and the second
 * survives a second write path.
 */
export class DecideCaseBodyDto {
  @ApiProperty({ enum: ArbitrationOutcome })
  @IsEnum(ArbitrationOutcome)
  outcome: ArbitrationOutcome;

  @ApiProperty({
    isArray: true,
    type: String,
    description: 'Reason codes, all of which must be valid for the chosen outcome',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  reasonCodes: string[];

  @ApiProperty({ minLength: 120, description: 'The reasoning, in the adjudicator’s own words' })
  @IsString()
  @Length(120, 4096)
  note: string;

  @ApiPropertyOptional({
    description:
      'Names a suspected shared root cause, so sibling cases are decided once rather than N times',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  rootCauseKey?: string;

  @ApiPropertyOptional({ description: 'The ticket this was worked under' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;

  @ApiPropertyOptional({
    description:
      'Only for UPHELD_RECALCULATED: the corrected penalty, in minor units. Must be ≤ the ' +
      'original — an adjudication may reduce a penalty and may never raise one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  recalculatedAmount?: string;
}

/** The second reader signs, or objects — and an objection needs a reason too. */
export class SecondSignatureBodyDto {
  @ApiProperty({ enum: ['SIGNED', 'OBJECTED'] })
  @IsIn(['SIGNED', 'OBJECTED'])
  kind: 'SIGNED' | 'OBJECTED';

  @ApiProperty({ minLength: 20 })
  @IsString()
  @Length(20, 2048)
  note: string;
}

/** `S-11`. Only the two outcomes that are findings about us may open one. */
export class OpenFleetSweepBodyDto {
  @ApiProperty({
    description: 'What the affected cases have in common — a binding, mapping or policy version',
  })
  @IsString()
  @MaxLength(128)
  defectKey: string;

  @ApiProperty({ description: 'How far back to sweep, in hours' })
  @IsInt()
  @Min(1)
  @Max(24 * 90)
  lookbackHours: number;

  @ApiProperty({ minLength: 120 })
  @IsString()
  @Length(120, 4096)
  note: string;

  @ApiProperty({ description: 'The reason code, from the source case’s outcome' })
  @IsString()
  @MaxLength(64)
  reasonCode: string;
}

export class FleetSweepDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ArbitrationOutcome })
  outcome: ArbitrationOutcome;

  @ApiProperty()
  defectKey: string;

  @ApiProperty()
  windowFrom: Date;

  @ApiProperty()
  windowTo: Date;

  @ApiProperty({ enum: ['OPEN', 'COMPLETED', 'FAILED'] })
  status: 'OPEN' | 'COMPLETED' | 'FAILED';

  @ApiProperty({ description: 'Cases the defect key matched' })
  matchedCount: number;

  @ApiProperty({
    description:
      'Cases the sweep actually changed. Lower than `matchedCount` when a match was already ' +
      'decided the same way — reporting one number would make an idempotent re-run look inert.',
  })
  appliedCount: number;

  @ApiProperty()
  openedBySubject: string;

  @ApiPropertyOptional({ nullable: true })
  completedAt: Date | null;
}

/** `S-1` and `S-2`: stop a proposal before anything is signed. */
export class SuspendProposalBodyDto {
  @ApiProperty({ minLength: 20 })
  @IsString()
  @Length(20, 2048)
  note: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  reasonCode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/**
 * `S-5`, step two: the signature of a compensation the treasury has already
 * paid.
 *
 * `SuspendProposalBodyDto`'s fields plus the one thing that makes this route
 * different from every other override — a transaction somebody else signed.
 * It is verified against the cluster before anything is written; see
 * `SlashExecutionService.markCompensated`.
 */
export class CompensatedBodyDto {
  @ApiProperty({ description: 'The confirmed deposit_stake signature, base58' })
  @IsString()
  @Length(64, 128)
  signature: string;

  @ApiProperty({ minLength: 20 })
  @IsString()
  @Length(20, 2048)
  note: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  reasonCode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/**
 * `S-5`, step one — the unsigned `deposit_stake` an operator carries to the
 * treasury's signers.
 */
export class CompensationIntentDto {
  @ApiProperty({ description: 'Base64 wire bytes, unsigned. The treasury signs it.' })
  transaction: string;

  @ApiProperty({ description: "The provider's stake authority, base58" })
  provider: string;

  @ApiProperty({ description: 'What the chain took, in minor units' })
  amountMinor: string;

  @ApiProperty({ description: '`Config.treasury`, base58 — the funder and the fee payer' })
  depositor: string;
}

/**
 * The unsigned `cancel_slash` an operator carries to the settlement admin.
 *
 * Lean v3 made `Config.admin` the instruction's only signer, so withdrawing a
 * standing judgement is a human act with a hardware key rather than something
 * this backend completes inside a request.
 */
export class CancelIntentDto {
  @ApiProperty({ description: 'Base64 wire bytes, unsigned. The settlement admin signs it.' })
  transaction: string;

  @ApiProperty({ description: '`Config.admin`, base58 — the only signer, and the fee payer' })
  admin: string;

  @ApiProperty({ description: "The record's 32-byte request id, lower-case hex" })
  requestId: string;

  @ApiProperty({ description: "The provider's stake authority, base58" })
  provider: string;
}

/** `S-8`. Extending a deadline also extends body retention for that window. */
export class ExtendDeadlineBodyDto {
  @ApiProperty({ description: 'Additional hours on the provider’s clock' })
  @IsInt()
  @Min(1)
  @Max(24 * 14)
  additionalHours: number;

  @ApiProperty({ minLength: 20 })
  @IsString()
  @Length(20, 2048)
  note: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  reasonCode: string;
}

/** `V-7`: set or clear a provider’s verified label. */
export class VerifyProviderCheckDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  check: string;

  @ApiProperty({ enum: ['PASS', 'FAIL', 'NOT_CHECKED'] })
  @IsIn(['PASS', 'FAIL', 'NOT_CHECKED'])
  result: 'PASS' | 'FAIL' | 'NOT_CHECKED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

export class VerifyProviderBodyDto {
  @ApiProperty()
  @IsBoolean()
  verified: boolean;

  @ApiProperty({ description: 'How it was checked, e.g. MANUAL_REVIEW' })
  @IsString()
  @MaxLength(64)
  method: string;

  /**
   * A verified row with an empty check list is the shape `verification_checks`
   * exists to prevent — the entity says so and the database does not enforce
   * it, so it is enforced here.
   */
  @ApiProperty({ isArray: true, type: VerifyProviderCheckDto })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => VerifyProviderCheckDto)
  checks: VerifyProviderCheckDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  evidenceUrl?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  reasonCode: string;

  @ApiProperty({ minLength: 120 })
  @IsString()
  @Length(120, 4096)
  note: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}
