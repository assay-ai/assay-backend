import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import {
  DecidedByDto,
  StageResultDto,
  VerifierVoteDto,
  VoteTallyDto,
} from '@modules/verification/dto/get-verdict.dto';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { ListQueryDto } from '@shared/api';
import { TransformToArray } from '@shared/decorators';

/**
 * `GET /providers/me/verdicts` — the verdict feed, filtered to the
 * calls this provider served.
 *
 * `verdictStatus` is an array, OR'd, mirroring `ListVerdictsQueryDto` on the
 * buyer's side. `reasonCode` is the "rule" filter: it narrows on the
 * single decisive reason code the record carries
 * (`verification_records.reason_code`) — see `ProviderVerdictListItemDto
 * .failingRules` for why the *displayed* value on each row can still be a
 * list. `agentId` and `windowId` both require a join (`payment_intents`,
 * `sla_window_calls`) that the service only adds when the corresponding
 * filter is present.
 */
export class ListProviderVerdictsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    enum: VerdictStatus,
    isArray: true,
    description: 'Only records carrying one of these verdicts',
  })
  @IsOptional()
  @IsEnum(VerdictStatus, { each: true })
  @TransformToArray()
  verdictStatus?: VerdictStatus[];

  @ApiPropertyOptional({
    description: 'The "rule" filter — exact match on `reasonCode`, the decisive reason code',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reasonCode?: string;

  @ApiPropertyOptional({ description: 'Only calls from this agent' })
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({ description: 'Only calls posted to this SLA window' })
  @IsOptional()
  @IsUUID()
  windowId?: string;
}

/**
 * One row of the provider's verdict feed.
 *
 * The verdict feed has eleven columns.
 * Nine of them have a real column or a real join behind them; two do not, and
 * both are documented here rather than fabricated:
 *
 * - **`bindingVersion` is always `null`.** Neither `payment_intents` nor
 *   `verification_records` records which `tool_bindings.mapping_version` was
 *   live when the call was mapped — only which *binding* served it
 *   (`payment_intents.binding_id`, itself null on every row written before
 *   that column existed). Joining today's `tool_bindings.mapping_version` would answer a
 *   different question — "what does this binding map like now" — and answer
 *   it wrong for any binding edited since. Open gap: no column
 *   captures the mapping version live at call time; the seam is a snapshot
 *   column on `payment_intents` or `verification_records`, written at the
 *   same moment `binding_id` is (the call-id producer, or the router
 *   write path it shares).
 * - **`failingRules` is derived, not stored.** `verification_records` has one
 *   `reason_code` column — the decisive rule. This field lists every `code`
 *   among `record.verifiers` whose `outcome` is `FAIL`, deduplicated, which is
 *   real data already on the row rather than a fabricated list. It is `[]`,
 *   not `null`, when nothing failed or nothing parses — an empty list is a
 *   true answer ("no failing rule"), unlike the two `null` fields above, which
 *   say "this platform never recorded that".
 *
 * `countedTowardWindow` and `windowId` are `null` together, for a call that
 * never posted to an SLA window (unjudged, or the binding is not enrolled).
 * `retentionState` is `null` for a verdict judged before evidence packs existed, which has no
 * evidence pack at all — see `EvidencePackService`.
 */
export class ProviderVerdictListItemDto {
  @ApiProperty({ description: 'The verification_records row id' })
  id: string;

  @ApiProperty({ description: 'The call this judges' })
  intentId: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The `X-X402-Call-Id` value (`payment_intents.call_id`)',
  })
  callId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '`PAID` | `FREE` | `TEST` | `EXPLORATION` (`payment_intents.call_class`)',
  })
  callClass: string | null;

  @ApiProperty({ description: "`PENDING` | `JUDGED` | `SETTLED` — the worker's own progress" })
  state: string;

  @ApiPropertyOptional({ enum: VerdictStatus, nullable: true, description: 'Null until judged' })
  verdictStatus: VerdictStatus | null;

  @ApiPropertyOptional({ nullable: true, description: 'The decisive reason code' })
  reasonCode: string | null;

  @ApiPropertyOptional({ nullable: true, description: '`0..1`, or null where nothing scored' })
  score: number | null;

  @ApiProperty({
    type: [String],
    description:
      'Every failed verifier code on this call, deduplicated. `[]`, never `null` — see the ' +
      'class comment on why this differs from `reasonCode`',
  })
  failingRules: string[];

  @ApiPropertyOptional({ nullable: true, description: 'The agent dimension — never the buyer org' })
  agentId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The decision policy version that judged this call',
  })
  decisionPolicyVersion: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'No source exists for this — always `null`. See the class comment',
  })
  bindingVersion: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'The SLA window this call posted to' })
  windowId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "Did this call land in an SLA window's quality denominator",
  })
  countedTowardWindow: boolean | null;

  @ApiPropertyOptional({
    enum: ['RAW', 'DIGESTED'],
    nullable: true,
    description: 'Evidence body retention state, or null when there is no sealed pack at all',
  })
  retentionState: 'RAW' | 'DIGESTED' | null;

  @ApiProperty()
  createdAt: Date;
}

/**
 * The production consequence — what happened to the money.
 *
 * `settlementOutcome` / `settledAt` are read straight off the record: they are
 * the instruction the worker actually applied (the aggregator's `effectiveConsequence`
 * already folded `SHADOW` into `PASS` before writing them), so this does not
 * re-derive anything from `verdictStatus` and cannot disagree with what
 * actually happened to the hold. `strike` is `settlementOutcome === 'REFUND'`
 * — `VERDICT_CONSEQUENCE` (`domain/verdict.ts`) proves exactly one status maps
 * to `REFUND` and it is the one that strikes, so the two are one fact, not two.
 *
 * `intentStatus` and the four money fields are nullable for one reason only:
 * a `verification_records` row with no matching `payment_intents` row, which
 * every judged verdict is supposed to make impossible (`intentId` names it).
 * If that join ever comes back empty it is a data-integrity anomaly, not a
 * legitimate "unpriced" call, and this reports it as absence rather than
 * inventing a zero-value intent that never existed.
 */
export class ProviderVerdictConsequenceDto {
  @ApiPropertyOptional({
    nullable: true,
    description: '`SETTLE` | `REFUND` | `VOID`, or null while `JUDGED` and unsettled',
  })
  settlementOutcome: string | null;

  @ApiPropertyOptional({ nullable: true })
  settledAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The payment_intents row status, or null — see the class comment',
  })
  intentStatus: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Did this call record a strike — null until settled',
  })
  strike: boolean | null;

  @ApiPropertyOptional({ type: MoneyDto, nullable: true, description: 'The listed price' })
  price: MoneyDto | null;

  @ApiPropertyOptional({ type: MoneyDto, nullable: true, description: "The provider's cut" })
  providerAmount: MoneyDto | null;

  @ApiPropertyOptional({ type: MoneyDto, nullable: true })
  platformFee: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'What the chain actually moved. Null until settled',
  })
  settledAmount: MoneyDto | null;
}

/**
 * `GET /providers/me/verdicts/:id` — the verdict decomposition, the
 * stage results, and the production consequence.
 *
 * **Deliberately not the evidence pack.** The five-pane body content
 * (mapped request, upstream response, mapped output, coverage, verdict) is
 * `GET /providers/me/verdicts/:id/evidence` on this same controller —
 * `evidenceUrl` links to it rather than this DTO duplicating it. What is here
 * is the half the verdict detail screen also needs that the evidence route does not carry:
 * which verifiers voted which way, the quorum arithmetic, which clause
 * decided, and what the verdict did to the money.
 */
export class ProviderVerdictDetailDto {
  @ApiProperty({ description: 'The verification_records row id' })
  id: string;

  @ApiProperty()
  intentId: string;

  @ApiProperty()
  toolId: string;

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
    description: 'All four pipeline stages, always, in pipeline order',
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
    description: 'The schema/rules document version, when one ran locally',
  })
  policyId: string | null;

  @ApiPropertyOptional({ nullable: true })
  policyVersion: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'The decision policy id' })
  decisionPolicyId: string | null;

  @ApiPropertyOptional({ nullable: true })
  decisionPolicyVersion: number | null;

  @ApiPropertyOptional({ nullable: true })
  lifecycle: string | null;

  @ApiPropertyOptional({ nullable: true })
  sampled: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  sampleRate: number | null;

  @ApiPropertyOptional({ nullable: true })
  sampleDisplay: string | null;

  @ApiPropertyOptional({ nullable: true })
  evaluatedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: ProviderVerdictConsequenceDto })
  consequence: ProviderVerdictConsequenceDto;

  @ApiProperty({ description: 'The five-pane evidence body for this call' })
  evidenceUrl: string;
}
