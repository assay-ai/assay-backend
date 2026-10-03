import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { DecisionTrigger, VerifierOutcome } from '../domain/aggregation';
import { StageStatus, VerificationStage } from '../domain/stage';
import { VerdictStatus } from '../domain/verdict';

export class GetVerdictParamsDto {
  @ApiProperty({ description: 'The verification_records row id' })
  @IsUUID()
  id: string;
}

/** One pipeline stage's result — the receipt row shape, on the verdict. */
export class StageResultDto {
  @ApiProperty({ enum: VerificationStage })
  stage: VerificationStage;

  @ApiProperty({ enum: StageStatus })
  status: StageStatus;

  @ApiProperty({ description: 'Human label, e.g. "passed", "not reached"' })
  label: string;

  @ApiPropertyOptional({ nullable: true, description: 'The explanatory sentence for this status' })
  note: string | null;

  @ApiProperty({ description: 'True only for `StageStatus.PASSED` — see `isStagePass`' })
  passed: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Stable machine-readable reason. Null on a pass',
  })
  code: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'One human sentence with the specifics' })
  detail: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '`0..1`, or null when this stage produced no score',
  })
  score: number | null;
}

/** One verifier's vote — the aggregator's input, on the verdict. */
export class VerifierVoteDto {
  @ApiProperty({ description: 'Stable, appears verbatim in the decision policy document' })
  verifierId: string;

  @ApiProperty({ enum: VerifierOutcome })
  outcome: VerifierOutcome;

  @ApiPropertyOptional({ nullable: true })
  code: string | null;

  @ApiPropertyOptional({ nullable: true })
  detail: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '`0..1`, or null where the verifier does not score',
  })
  score: number | null;

  @ApiProperty({
    description: 'What obtaining this vote cost. Zero for the cheap deterministic layers',
  })
  costUsd: number;

  @ApiPropertyOptional({
    enum: VerificationStage,
    nullable: true,
    description:
      'The pipeline stage this vote came from, where it came from one of the built-in four',
  })
  stage: VerificationStage | null;
}

/** The quorum arithmetic behind the verdict — `VoteTally`, so a receipt can show its working. */
export class VoteTallyDto {
  @ApiProperty({ description: 'Declared verifiers. The `4` in "2 of 4"' })
  declared: number;

  @ApiProperty({ description: '`PASS + FAIL` — the quorum denominator' })
  votes: number;

  @ApiProperty()
  passed: number;

  @ApiProperty()
  failed: number;

  @ApiProperty()
  misapplied: number;

  @ApiProperty()
  unavailable: number;

  @ApiProperty()
  abstained: number;

  @ApiPropertyOptional({
    nullable: true,
    description: '`failed / votes`, or null when nobody voted',
  })
  failedFraction: number | null;

  @ApiProperty({
    description: 'Results discarded because the policy does not declare that verifier',
  })
  unregistered: number;
}

/** Which clause decided the verdict, or the `otherwise` default. */
export class DecidedByDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Index into the policy clauses, null for `otherwise`',
  })
  clauseIndex: number | null;

  @ApiPropertyOptional({ enum: DecisionTrigger, nullable: true })
  trigger: DecisionTrigger | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The sentence the receipt prints for this clause',
  })
  label: string | null;
}

/**
 * `GET /api/v1/verdicts/:id` — one verdict in full.
 *
 * The gap this closes: the agent-side UI needed `stageResults`, the verifiers that
 * voted and the tally, and until this endpoint only `status` / `score` /
 * `reason` / `policyVersion` / `sampled` were reachable anywhere on the
 * surface.
 */
export class VerdictDetailDto {
  @ApiProperty({ description: 'The verification_records row id' })
  id: string;

  @ApiProperty()
  intentId: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({ nullable: true })
  providerId: string | null;

  @ApiProperty({ description: "`PENDING` | `JUDGED` | `SETTLED` — the worker's own progress" })
  state: string;

  @ApiPropertyOptional({ enum: VerdictStatus, nullable: true, description: 'Null until judged' })
  verdictStatus: VerdictStatus | null;

  @ApiPropertyOptional({ nullable: true })
  reasonCode: string | null;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiPropertyOptional({ nullable: true, description: '`0..1`, or null when nothing scored' })
  score: number | null;

  @ApiProperty({
    type: [StageResultDto],
    description: 'All four pipeline stages, always, in pipeline order — never omitted',
  })
  stageResults: StageResultDto[];

  @ApiProperty({
    type: [VerifierVoteDto],
    description: "Every declared verifier's result, in declaration order",
  })
  verifiers: VerifierVoteDto[];

  @ApiPropertyOptional({ type: VoteTallyDto, nullable: true })
  tally: VoteTallyDto | null;

  @ApiPropertyOptional({ type: DecidedByDto, nullable: true })
  decidedBy: DecidedByDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The schema/rules document, when one ran locally',
  })
  policyId: string | null;

  @ApiPropertyOptional({ nullable: true })
  policyVersion: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The decision policy that turned the votes into this status. Set on every judged record',
  })
  decisionPolicyId: string | null;

  @ApiPropertyOptional({ nullable: true })
  decisionPolicyVersion: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'One of `PolicyLifecycle` at the time this was judged',
  })
  lifecycle: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Was the semantic stage actually drawn for this call',
  })
  sampled: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The odds this call had of being semantically judged',
  })
  sampleRate: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'The published sentence — "1 in 13 calls"' })
  sampleDisplay: string | null;

  @ApiPropertyOptional({ nullable: true })
  settlementOutcome: string | null;

  @ApiPropertyOptional({ nullable: true })
  evaluatedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  settledAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
