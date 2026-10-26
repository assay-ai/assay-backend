import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { EmptyResultDisposition } from '@modules/verification/domain/policy.types';
import { TrialLabel } from '@modules/verification/services/policy-evidence.service';

import { ContractActionBodyDto, ToolIdParamDto } from './operator-contracts.dto';
import { QueryBoolean, Trimmed, TrimmedOrAbsent } from './operator-console.dto';

/**
 * Verification policies from the operator console: register a trial
 * (SHADOW) policy for a standard tool (P-2), label its trial calls, ask to
 * switch it on (P-1, two-person, on evidence the server measures), withdraw
 * it (P-3, kill switch).
 */

export class EmptyResultBodyDto {
  @ApiProperty({ enum: EmptyResultDisposition })
  @IsIn(Object.values(EmptyResultDisposition))
  whenUncorroborated: EmptyResultDisposition;
}

export class RegisterPolicyBodyDto extends ContractActionBodyDto {
  @ApiPropertyOptional({
    type: [Object],
    description:
      'Verification rules in the existing dialect (MIN_ARRAY_LENGTH, REQUIRED_FIELDS, ' +
      'FRESHNESS, VALUE_RANGE, VALID_URL, NO_DUPLICATES), at most 20. None: shape only.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  rules?: Record<string, unknown>[];

  @ApiPropertyOptional({ minimum: 0, maximum: 1, default: 0.7 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  passThreshold?: number;

  @ApiPropertyOptional({ type: EmptyResultBodyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmptyResultBodyDto)
  emptyResult?: EmptyResultBodyDto;
}

/** P-3: the note is the withdrawal's recorded reason, so it fits that column. */
export class WithdrawPolicyBodyDto extends ContractActionBodyDto {
  @ApiProperty({ minLength: 20, maxLength: 500 })
  @Trimmed()
  @IsString()
  @Length(20, 500)
  note: string;
}

export class PolicyVersionParamDto extends ToolIdParamDto {
  @ApiProperty({
    example: 2,
    description: 'The policy version (`verification_policies.policy_version`)',
  })
  @Matches(/^[1-9]\d{0,8}$/)
  version: string;
}

export class RecordIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  recordId: string;
}

export class ListTrialRecordsQueryDto {
  @ApiPropertyOptional({ description: '`false`: unlabelled only; `true`: labelled only' })
  @IsOptional()
  @QueryBoolean()
  @IsIn([true, false])
  labelled?: boolean;

  @ApiPropertyOptional({ description: '`nextCursor` of the previous page' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class LabelRecordBodyDto {
  @ApiProperty({ enum: TrialLabel })
  @IsIn(Object.values(TrialLabel))
  label: TrialLabel;

  @ApiPropertyOptional({ maxLength: 500 })
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PolicyEvidenceDto {
  @ApiProperty({ description: 'Judged calls this version decided while in SHADOW' })
  shadowCalls: number;

  @ApiProperty({ description: 'Of those, how many an operator labelled' })
  labelledSamples: number;

  @ApiProperty({ description: 'Labelled calls the policy failed and the label says it was wrong' })
  falsePositives: number;

  @ApiProperty({ type: Number, nullable: true, description: 'null until something is labelled' })
  falsePositiveRate: number | null;

  @ApiProperty({ description: 'Calls the policy failed that nobody labelled yet' })
  unlabelledFails: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Labels per operator id',
  })
  labellers: Record<string, number>;

  @ApiProperty({ enum: ['verification_records'] })
  source: 'verification_records';

  @ApiProperty({ description: 'UTC, ISO 8601' })
  computedAt: string;
}

export class GateFailureDto {
  @ApiProperty({
    example: 'INSUFFICIENT_LABELLED_SAMPLES',
    description: 'A `PromotionRefusal` code',
  })
  code: string;

  @ApiProperty()
  detail: string;
}

export class GatePreviewDto {
  @ApiProperty({ description: 'Whether a promotion asked now would clear the gate' })
  promotable: boolean;

  @ApiProperty({
    type: [GateFailureDto],
    description: 'Every unmet bar; the approver rule is checked on approval',
  })
  failures: GateFailureDto[];
}

export class PromotionGateDto {
  @ApiProperty({ example: 0.02, description: 'The false-positive rate must be strictly below' })
  maxFalsePositiveRate: number;

  @ApiProperty({ example: 100 })
  minLabelledSamples: number;

  @ApiProperty({ example: 500 })
  minShadowCalls: number;
}

export class PolicyVersionDto {
  @ApiProperty({ example: 'get_weather.default' })
  policyId: string;

  @ApiProperty()
  version: number;

  @ApiProperty({ enum: ['DRAFT', 'SHADOW', 'ACTIVE', 'WITHDRAWN', 'ARCHIVED'] })
  lifecycle: string;

  @ApiProperty({
    description: 'Operator id, `system` (registered on publish) or `provider:{organizationId}`',
  })
  createdBy: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: [Object], description: 'The declared rules; empty: shape only' })
  rules: unknown[];

  @ApiProperty({ type: Number, nullable: true })
  passThreshold: number | null;

  @ApiProperty({ type: Object, nullable: true })
  emptyResult: unknown;

  @ApiProperty({ type: PolicyEvidenceDto, description: 'Measured now from the trial calls' })
  evidence: PolicyEvidenceDto;

  @ApiProperty({
    type: GatePreviewDto,
    nullable: true,
    description: 'SHADOW only: the gate on the evidence above',
  })
  gate: GatePreviewDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A promotion waiting for a second operator',
  })
  pendingApprovalId: string | null;

  @ApiProperty({ type: Date, nullable: true })
  promotedAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  promotedBy: string | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'The evidence stored when it was promoted',
  })
  promotionEvidence: Record<string, unknown> | null;

  @ApiProperty({ type: Date, nullable: true })
  withdrawnAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  withdrawnBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  withdrawnReason: string | null;
}

export class ServingPolicyDto {
  @ApiProperty()
  policyId: string;

  @ApiProperty()
  version: number;

  @ApiProperty({
    enum: ['SHADOW', 'ACTIVE', 'WITHDRAWN'],
    description: 'As resolved for traffic: a kill switch reads as WITHDRAWN',
  })
  lifecycle: string;
}

export class OperatorToolVerificationDto {
  @ApiProperty({ format: 'uuid' })
  toolId: string;

  @ApiProperty()
  toolName: string;

  @ApiProperty({ enum: ['STANDARD', 'PROVIDER'] })
  kind: string;

  @ApiProperty({ enum: ['ACTIVE', 'SHADOW', 'NONE'], description: 'What the catalogue shows' })
  checks: 'ACTIVE' | 'SHADOW' | 'NONE';

  @ApiProperty({
    description: 'Whether `POST …/verification` may register a version (STANDARD tools only)',
  })
  canRegister: boolean;

  @ApiProperty({ type: ServingPolicyDto, nullable: true })
  serving: ServingPolicyDto | null;

  @ApiProperty({ type: [PolicyVersionDto], description: 'Newest first' })
  versions: PolicyVersionDto[];

  @ApiProperty({ type: PromotionGateDto })
  gate: PromotionGateDto;
}

export class TrialRecordDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  intentId: string;

  @ApiProperty({ type: String, nullable: true })
  providerId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Object, nullable: true, description: 'The agent’s arguments' })
  request: unknown;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'The mapped response; null once retention dropped it',
  })
  response: unknown;

  @ApiProperty({ type: String, nullable: true, example: 'FAIL' })
  verdictStatus: string | null;

  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;

  @ApiProperty({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty({ type: [Object], nullable: true, description: '`StageResult[]`' })
  stages: unknown;

  @ApiProperty({ type: Object, nullable: true })
  decidedBy: unknown;

  @ApiProperty({ enum: TrialLabel, nullable: true })
  label: string | null;

  @ApiProperty({ type: String, nullable: true })
  labelledBy: string | null;

  @ApiProperty({ type: Date, nullable: true })
  labelledAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  labelNote: string | null;
}

export class TrialRecordPageDto {
  @ApiProperty({ type: [TrialRecordDto], description: 'Fixed pseudo-random order (md5 of id)' })
  records: TrialRecordDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
