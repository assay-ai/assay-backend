import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

import { ArbitrationOutcome, DisputeClaimType, ResolutionKind } from '../domain/arbitration';
import { ChainProposalStatus } from '../domain/chain-slash-outcome';
import { OnChainDisputeState } from '../domain/on-chain-dispute';
import { SlashProposalStatus } from '../domain/slash-proposal-state';

/** Matches `chk_slash_proposals_source`. */
export enum SlashProposalSource {
  /** A window closed `BREACH_PROPOSED` and wrote an `sla_strikes` row. */
  SLA_STRIKE = 'SLA_STRIKE',
  /** A single call was judged `FAIL` — the only slashable verdict. */
  DATA_FAIL = 'DATA_FAIL',
}

export { ArbitrationOutcome, DisputeClaimType, ResolutionKind, SlashProposalStatus };

export class SlashProposalIdParamsDto {
  @ApiProperty({ description: 'The slash proposal id' })
  @IsUUID()
  proposalId: string;
}

/**
 * The two clocks, together, because the dispute case screen promises exactly
 * this: *"both clocks are visible, including ours."*
 *
 * Every deadline in the lifecycle except one runs against the provider. The
 * platform-miss rule adds the one that runs against us, and a client that could
 * render only the provider's half would quietly restore the asymmetry.
 */
export class SlashProposalClocksDto {
  @ApiProperty({ description: 'When the proposal was issued' })
  proposedAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'When the notification was DELIVERED. The case is proposed on chain only after delivery, ' +
      'so the provider has heard of it before any stake is reserved.',
  })
  notifiedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  acknowledgedAt: Date | null;

  @ApiProperty({
    description: 'Nothing executes before this, even if the provider does nothing at all.',
  })
  earliestExecutionAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Seconds left on whichever clock is currently running. Null when none is.',
  })
  secondsRemaining: number | null;

  @ApiProperty({
    description: 'Which clock `secondsRemaining` refers to: PROVIDER (the dispute window) or NONE.',
    enum: ['PROVIDER', 'NONE'],
  })
  runningClock: 'PROVIDER' | 'NONE';

  @ApiPropertyOptional({
    description:
      'The mirrored on-chain record state (`ChainProposalStatus`). `PENDING` with a non-null ' +
      '`chainDisputedAt` and no disputed part means the arbiter upheld the dispute.',
    enum: ChainProposalStatus,
  })
  chainStatus: ChainProposalStatus;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The record’s own `executableAt`, mirrored from the chain: the dispute window closes and ' +
      'execution may start here. An uphold moves it. Null until a record stands on chain.',
  })
  chainExecutableAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The chain’s `disputedAt`: when the provider disputed the record on chain. A record is ' +
      'disputed at most once, so it stays set after an uphold. Null when never disputed.',
  })
  chainDisputedAt: Date | null;

  @ApiPropertyOptional({
    description: 'How many of the current parts are `Disputed` on chain, awaiting the arbiter.',
  })
  chainDisputedParts: number;

  @ApiPropertyOptional({
    nullable: true,
    enum: OnChainDisputeState,
    description:
      'The state of the case’s on-chain records, derived per record: DISPUTED while any is, ' +
      'UPHELD when every pending record was disputed and upheld, PENDING while one stands ' +
      'undisputed, EXECUTED once every record executed, PARTIALLY_EXECUTED once some executed ' +
      'and the others were cancelled or expired, else CANCELLED (cancelSlash), ' +
      'EXPIRED (a dispute nobody ruled on), LAPSED (a record that expired unexecuted) or ' +
      'RELEASED (cancelled for a reason never recorded). Null off EVM or before a record ' +
      'stands on chain.',
  })
  chainState: OnChainDisputeState | null;

  @ApiPropertyOptional({
    description:
      'Review R2-3: how many on-chain records (current parts) the case has. 0 off EVM, before ' +
      'a record stands, and for a case proposed as one single record.',
  })
  chainRecords: number;

  @ApiPropertyOptional({
    description:
      'The records of `chainRecords` cancelled or expired on chain, nothing taken. With ' +
      '`chainState` PARTIALLY_EXECUTED the case was executed in part only.',
  })
  cancelledRecords: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The deadline to dispute on chain: the earliest `executableAt` of a record still PENDING ' +
      'and never disputed, whatever its sibling records or the case status. Null when none.',
  })
  disputeBy: Date | null;
}

/** One line of the arithmetic, exactly as the case screen's "The measurement" table renders it. */
export class SlashArithmeticRowDto {
  @ApiProperty({ description: 'e.g. `observed_rate`' })
  key: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The working, e.g. `92 / 612 =`. Null where there is none to show.',
  })
  expression: string | null;

  @ApiProperty({ description: 'The value, already formatted for display' })
  value: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The aside, e.g. `observed 15.03% > 7.27% → breach`',
  })
  note: string | null;

  @ApiProperty({
    enum: ['NEUTRAL', 'GOOD', 'BAD'],
    description: 'How the value should read. Drives colour only; carries no meaning of its own.',
  })
  tone: 'NEUTRAL' | 'GOOD' | 'BAD';
}

/** The case screen's "failures by rule" / "failures by agent" columns. */
export class SlashAttributionRowDto {
  @ApiProperty()
  key: string;

  @ApiProperty()
  count: number;

  @ApiPropertyOptional({ nullable: true, description: 'Share of the window’s failures, 0–1' })
  share: number | null;
}

/** One bar of the case screen's "previous 5 windows" sparkline. */
export class PriorWindowRowDto {
  @ApiProperty()
  windowId: string;

  @ApiProperty({ description: 'The provider-facing label, e.g. `w_4470`' })
  label: string;

  @ApiProperty({ description: 'Observed failure rate, 0–1' })
  observedRate: number;

  @ApiProperty()
  closedAt: Date;

  @ApiProperty({ description: 'True for the window this proposal is about' })
  isSubject: boolean;
}

/**
 * The change-overlay banner. The case screen renders it as *"71 of your 92 failures
 * occurred after a binding change on … by …"*.
 *
 * The co-failure panel and the change overlay are the two items that settle
 * most cases. This is the change overlay:
 * `binding_versions` supplies the edit, and the failures are bucketed either
 * side of it.
 *
 * Null when no binding or mapping edit falls inside the window — which is the
 * common case and, read honestly, is itself evidence.
 */
export class ChangeOverlayDto {
  @ApiProperty()
  changedAt: Date;

  @ApiProperty({ description: 'Who made the edit' })
  changedBy: string;

  @ApiProperty({ description: 'e.g. `v2 → v3`' })
  fromVersion: string;

  @ApiProperty()
  toVersion: string;

  @ApiProperty({ description: 'Verified calls before the change' })
  verifiedBefore: number;

  @ApiProperty()
  failuresBefore: number;

  @ApiProperty()
  verifiedAfter: number;

  @ApiProperty()
  failuresAfter: number;

  @ApiProperty({ description: 'Failure rate before, 0–1' })
  rateBefore: number;

  @ApiProperty()
  rateAfter: number;
}

/**
 * What the case screen's "What happens if you do nothing" panel needs.
 *
 * The most common response to a proposal is no response, so its consequence is
 * stated rather than left to be discovered.
 */
export class InactionForecastDto {
  @ApiProperty()
  executesAt: Date;

  @ApiProperty({ type: MoneyDto, description: 'Stake now' })
  stakeBefore: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Stake after the penalty, if it executes' })
  stakeAfter: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  minimumRequired: MoneyDto;

  @ApiProperty({ description: 'True when `stakeAfter` falls below `minimumRequired`' })
  fallsBelowMinimum: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Hours of grace that would open. Null when the floor is not breached.',
  })
  graceHours: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Estimated hours until unpaid earnings restore the floor on their own. Null when the ' +
      'floor is not breached, or when there is no earnings run-rate to project from.',
  })
  projectedRestoreHours: number | null;

  @ApiProperty({ description: 'Routing is unaffected by a proposal. Always true; stated anyway.' })
  routingContinues: boolean;
}

/**
 * A slash proposal, in full.
 *
 * One shape for both audiences. The provider reads it on the case screen and the
 * adjudicator reads the same object with a case brief attached; serving two
 * representations of one row is how the two come to disagree about what the
 * penalty was.
 */
export class SlashProposalDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: SlashProposalStatus })
  status: SlashProposalStatus;

  @ApiProperty({ enum: SlashProposalSource })
  source: SlashProposalSource;

  @ApiProperty()
  providerId: string;

  @ApiProperty()
  bindingId: string;

  @ApiProperty({ description: 'The provider-facing binding label, e.g. `bnd_7QK`' })
  bindingLabel: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The tool’s name, e.g. `search_web`; null when the catalogue cannot name it',
  })
  toolName: string | null;

  @ApiPropertyOptional({ nullable: true })
  windowId: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'e.g. `w_4471`' })
  windowLabel: string | null;

  @ApiProperty({
    type: MoneyDto,
    description:
      'The uncapped formula result. The per-window ceiling and the 10%-of-stake daily cap are ' +
      'enforced on chain against a signed attestation, so what is finally taken may be less.',
  })
  penaltyAmount: MoneyDto;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'What the chain actually took. Null until executed.',
  })
  appliedAmount: MoneyDto | null;

  @ApiProperty({ type: SlashProposalClocksDto })
  clocks: SlashProposalClocksDto;

  @ApiPropertyOptional({ nullable: true })
  disputeId: string | null;

  @ApiPropertyOptional({ enum: ResolutionKind, nullable: true })
  resolutionKind: ResolutionKind | null;

  @ApiPropertyOptional({
    enum: ArbitrationOutcome,
    nullable: true,
    description:
      'One of six. Null for every automatic resolution — an outcome is a judgement, and there ' +
      'are three ways a case ends without one.',
  })
  outcome: ArbitrationOutcome | null;

  @ApiPropertyOptional({ nullable: true })
  resolvedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  executedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, description: 'The confirmed transaction signature' })
  executionSignature: string | null;

  @ApiPropertyOptional({ nullable: true })
  reversedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  reversalSignature: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The fleet sweep that reached this case, if any — including uncomplained ones.',
  })
  sweepId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** The provider's case screen in one response: the proposal, plus everything it renders. */
export class SlashProposalCaseDto {
  @ApiProperty({ type: SlashProposalDto })
  proposal: SlashProposalDto;

  @ApiProperty({ type: InactionForecastDto })
  inaction: InactionForecastDto;

  @ApiProperty({
    type: [SlashArithmeticRowDto],
    description: 'The measurement, worked. The evidence pack does not carry this today.',
  })
  arithmetic: SlashArithmeticRowDto[];

  @ApiProperty({ type: [PriorWindowRowDto], description: 'This window and the previous five' })
  priorWindows: PriorWindowRowDto[];

  @ApiPropertyOptional({ type: ChangeOverlayDto, nullable: true })
  changeOverlay: ChangeOverlayDto | null;

  @ApiProperty({ type: [SlashAttributionRowDto], description: 'Failures by rule' })
  failuresByRule: SlashAttributionRowDto[];

  @ApiProperty({ type: [SlashAttributionRowDto], description: 'Failures by agent' })
  failuresByAgent: SlashAttributionRowDto[];

  @ApiProperty({ description: 'Verdicts in the evidence pack for this window' })
  evidenceVerdictCount: number;
}

/** One row of the dispute case timeline. */
export class SlashProposalEventDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  occurredAt: Date;

  @ApiProperty()
  kind: string;

  @ApiProperty({ enum: ['provider', 'operator', 'system'] })
  actorType: 'provider' | 'operator' | 'system';

  @ApiPropertyOptional({ nullable: true })
  actorId: string | null;

  @ApiProperty()
  summary: string;

  @ApiProperty({ type: Object })
  detail: Record<string, unknown>;
}

/**
 * The dispute case screen's "If this is overturned — the restoration record".
 *
 * Its subtitle is the requirement: *"an overturn that does not visibly undo the
 * damage is a loss you paid for twice."* Every row states what would be
 * restored and whether it already has been, so the promise and its fulfilment
 * are the same list.
 */
export class RestorationRowDto {
  @ApiProperty({ description: 'e.g. `Strikes removed from w_4471`' })
  label: string;

  @ApiProperty({ description: 'Already formatted; may be a count, a share or an amount' })
  value: string;

  @ApiProperty({
    enum: ['ON_DECISION', 'RESTORED', 'NOT_APPLICABLE'],
    description:
      '`ON_DECISION` while the case is open, `RESTORED` once done, `NOT_APPLICABLE` where the ' +
      'outcome does not restore this — an insufficient-evidence overturn leaves strikes standing.',
  })
  status: 'ON_DECISION' | 'RESTORED' | 'NOT_APPLICABLE';
}
