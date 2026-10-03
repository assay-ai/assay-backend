import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * What is being challenged. Matches `chk_disputes_subject_type` exactly.
 *
 * `SLA_WINDOW` resolves against `sla_windows` (the SLA window table) —
 * see `DisputeService.assertSubjectExists` for the lookup and why it is
 * always the provider's own window, never a payer's.
 */
export enum DisputeSubjectType {
  SLA_WINDOW = 'SLA_WINDOW',
  VERDICT = 'VERDICT',
  PAYMENT_INTENT = 'PAYMENT_INTENT',
}

/** Matches `chk_disputes_state` exactly. Adjudication is what moves a dispute past `OPEN`/`UNDER_REVIEW`. */
export enum DisputeState {
  OPEN = 'OPEN',
  UNDER_REVIEW = 'UNDER_REVIEW',
  UPHELD = 'UPHELD',
  PARTIALLY_UPHELD = 'PARTIALLY_UPHELD',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
}

/** States this module never produces, and therefore never has to transition out of either. */
export const TERMINAL_DISPUTE_STATES: readonly DisputeState[] = [
  DisputeState.UPHELD,
  DisputeState.PARTIALLY_UPHELD,
  DisputeState.REJECTED,
  DisputeState.WITHDRAWN,
];

export class DisputeIdParamsDto {
  @ApiProperty({ description: 'The dispute id' })
  @IsUUID()
  id: string;
}

/**
 * One dispute, in full. The shape every read and every mutation on this
 * controller returns, so a client never has to reconcile two representations
 * of the same row.
 *
 * `resolvedAt` / `resolvedBy` / `resolutionNote` / `restoredAmount` are always
 * null for now — no code path here sets them. They are on the DTO
 * because the column exists and a client polling a dispute needs to notice,
 * without a schema change, the day adjudication starts writing them.
 */
export class DisputeDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: DisputeSubjectType })
  subjectType: DisputeSubjectType;

  @ApiProperty({ description: 'The id of the thing being disputed, within its own id space' })
  subjectId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Set when the disputing party is a provider',
  })
  providerId: string | null;

  @ApiProperty({ enum: DisputeState })
  state: DisputeState;

  @ApiProperty({ description: 'What kind of claim this is — open-ended, not a closed enum' })
  claimType: string;

  @ApiProperty()
  reason: string;

  @ApiProperty({
    type: [Object],
    description: 'Free-form supporting material, as submitted. Never rewritten',
  })
  evidence: unknown[];

  @ApiProperty({ description: 'Who filed it' })
  openedBy: string;

  @ApiPropertyOptional({ nullable: true, description: 'When the respondent confirmed receipt' })
  acknowledgedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Derived from acknowledgedAt, never from createdAt. Null until acknowledged',
  })
  deadlineAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  resolvedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  resolvedBy: string | null;

  @ApiPropertyOptional({ nullable: true })
  resolutionNote: string | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'What was given back, on a dispute upheld in whole or in part. Null otherwise',
  })
  restoredAmount: MoneyDto | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
