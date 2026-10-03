import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { StageStatus, VerificationStage } from '../domain/stage';

export class GetReceiptParamsDto {
  @ApiProperty({ description: 'The payment intent id' })
  @IsUUID()
  intentId: string;
}

/**
 * `Money` on the wire: atomic units as a decimal string, plus the asset that
 * gives the number meaning. Never a bare amount — see `chains/ports/money.types.ts`.
 */
export class MoneyDto {
  @ApiProperty({ description: 'Atomic units as a decimal integer string', example: '1000000' })
  amount: string;

  @ApiProperty({ description: 'CAIP-19 asset id' })
  asset: string;

  @ApiProperty({ description: 'The scale `amount` is quoted in' })
  decimals: number;
}

/**
 * One pipeline stage's row on the receipt.
 *
 * Always one of these per {@link VerificationStage} — see
 * `ReceiptService.buildStages` for why a stage the pipeline never reached is
 * still a row here, never an omission.
 */
export class ReceiptStageDto {
  @ApiProperty({ enum: VerificationStage })
  stage: VerificationStage;

  @ApiProperty({ enum: StageStatus })
  status: StageStatus;

  @ApiProperty({ description: 'STAGE_STATUS_LABEL[status] — one wording, every surface' })
  label: string;

  @ApiPropertyOptional({ nullable: true, description: 'STAGE_STATUS_NOTE[status]' })
  note: string | null;

  @ApiProperty({ description: 'The only status that may ever be rendered as a tick' })
  passed: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Stable machine-readable reason' })
  code: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'One human sentence with the specifics' })
  detail: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "0..1, or null when this stage didn't score",
  })
  score: number | null;
}

export class ReceiptVerdictDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'One of VerdictStatus, or null if not yet judged',
  })
  status: string | null;

  @ApiPropertyOptional({ nullable: true })
  reasonCode: string | null;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiPropertyOptional({ nullable: true })
  score: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'VoteTally — the quorum arithmetic' })
  tally: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, description: 'DecidedBy — which clause decided' })
  decidedBy: Record<string, unknown> | null;
}

/** Both policy pairs, plus the lifecycle that says whether either had economic effect. */
export class ReceiptPolicyDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'The VerificationPolicy that produced the votes',
  })
  policyId: string | null;

  @ApiPropertyOptional({ nullable: true })
  policyVersion: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The DecisionPolicy that turned votes into a status',
  })
  decisionPolicyId: string | null;

  @ApiPropertyOptional({ nullable: true })
  decisionPolicyVersion: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'One of PolicyLifecycle' })
  lifecycle: string | null;
}

export class ReceiptSamplingDto {
  @ApiPropertyOptional({ nullable: true, description: '0..1 — the odds this call was judged' })
  rate: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Was the sampled stage actually drawn' })
  sampled: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The published sentence, verbatim — "1 in 125 calls at this price"',
  })
  display: string | null;
}

export class GetReceiptResponseDto {
  @ApiProperty({ description: 'The payment intent id' })
  intentId: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({ nullable: true })
  providerId: string | null;

  @ApiPropertyOptional({ nullable: true })
  classification: string | null;

  @ApiProperty({ description: 'One of PaymentIntentStatus' })
  status: string;

  @ApiProperty({ type: MoneyDto })
  listedPrice: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description: 'Zero for every non-SETTLED terminal status. Always present, even when equal',
  })
  chargedPrice: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'listedPrice − chargedPrice' })
  withheld: MoneyDto;

  @ApiProperty({ type: ReceiptVerdictDto })
  verdict: ReceiptVerdictDto;

  @ApiProperty({
    type: [ReceiptStageDto],
    description: 'All four stages, always, in pipeline order',
  })
  stages: ReceiptStageDto[];

  @ApiProperty({ type: ReceiptPolicyDto })
  policy: ReceiptPolicyDto;

  @ApiProperty({ type: ReceiptSamplingDto })
  sampling: ReceiptSamplingDto;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  expiresAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional({ nullable: true })
  holdReleasedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, description: 'When the verdict was evaluated' })
  evaluatedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, description: 'When the hold was actually resolved' })
  settledAt: Date | null;
}
