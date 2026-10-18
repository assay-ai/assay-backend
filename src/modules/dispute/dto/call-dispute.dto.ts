import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { ListQueryDto } from '@shared/api';
import { TransformToArray } from '@shared/decorators';

import {
  CallDisputeDecision,
  CallDisputeReason,
  RefundSource,
  RefundState,
} from '../domain/call-dispute';
import { DisputeState } from './dispute.dto';

/** What a buyer may name when filing: the call, or its verdict. */
export enum CallDisputeSubjectType {
  PAYMENT_INTENT = 'PAYMENT_INTENT',
  VERDICT = 'VERDICT',
}

/** The states a call dispute takes: filed, then decided or withdrawn. */
export const CALL_DISPUTE_STATES = [
  DisputeState.OPEN,
  DisputeState.UPHELD,
  DisputeState.REJECTED,
  DisputeState.WITHDRAWN,
] as const;

export class CallDisputeIdParamsDto {
  @ApiProperty({ description: 'The dispute id' })
  @IsUUID()
  id: string;
}

/** `POST /call-disputes`. */
export class CreateCallDisputeBodyDto {
  @ApiProperty({ enum: CallDisputeSubjectType, description: 'Dispute the call, or its verdict' })
  @IsEnum(CallDisputeSubjectType)
  subjectType: CallDisputeSubjectType;

  @ApiProperty({ description: 'The payment intent id, or the verdict id', format: 'uuid' })
  @IsUUID()
  subjectId: string;

  @ApiProperty({ enum: CallDisputeReason })
  @IsEnum(CallDisputeReason)
  reason: CallDisputeReason;

  @ApiPropertyOptional({ description: 'What was wrong, in the buyer’s words', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** `POST /providers/me/call-disputes/:id/respond`. */
export class RespondCallDisputeBodyDto {
  @ApiProperty({ description: 'The provider’s one reply, before the decision', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  response: string;
}

/** `POST /operator/call-disputes/:id/decide`. */
export class DecideCallDisputeBodyDto {
  @ApiProperty({ enum: CallDisputeDecision })
  @IsEnum(CallDisputeDecision)
  decision: CallDisputeDecision;

  @ApiProperty({
    description: 'Why — shown to the buyer and the provider verbatim',
    minLength: 10,
    maxLength: 2048,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  note: string;

  @ApiPropertyOptional({ description: 'An external ticket, if any', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/** `GET /call-disputes` and `GET /providers/me/call-disputes`. */
export class ListCallDisputesQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: CALL_DISPUTE_STATES, isArray: true })
  @IsOptional()
  @IsIn(CALL_DISPUTE_STATES, { each: true })
  @TransformToArray()
  state?: DisputeState[];

  @ApiPropertyOptional({ enum: CallDisputeReason })
  @IsOptional()
  @IsEnum(CallDisputeReason)
  reason?: CallDisputeReason;

  @ApiPropertyOptional({ description: 'Only disputes over this payment intent' })
  @IsOptional()
  @IsUUID()
  intentId?: string;
}

/** `GET /operator/call-disputes`. */
export class ListOperatorCallDisputesQueryDto extends ListCallDisputesQueryDto {
  @ApiPropertyOptional({ description: 'Only this buyer organization' })
  @IsOptional()
  @IsUUID()
  buyerOrganizationId?: string;

  @ApiPropertyOptional({ description: 'Only disputes against this provider' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({ enum: RefundState })
  @IsOptional()
  @IsEnum(RefundState)
  refundState?: RefundState;

  @ApiPropertyOptional({
    description: 'Only buyers whose recent disputes are mostly rejected',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  flaggedOnly?: boolean;
}

/** One dispute over a call, as the buyer and the provider see it. */
export class CallDisputeDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: CALL_DISPUTE_STATES })
  state: DisputeState;

  @ApiProperty({ enum: CallDisputeReason })
  reason: CallDisputeReason;

  @ApiProperty({ example: 'Wrong data' })
  reasonLabel: string;

  @ApiPropertyOptional({ nullable: true })
  note: string | null;

  @ApiProperty({ format: 'uuid' })
  intentId: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  verdictId: string | null;

  @ApiPropertyOptional({ nullable: true })
  toolId: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  bindingId: string | null;

  @ApiProperty({ format: 'uuid', description: 'The provider that served the call' })
  providerId: string;

  @ApiPropertyOptional({ type: MoneyDto, nullable: true, description: 'What the call cost' })
  amount: MoneyDto | null;

  @ApiPropertyOptional({ nullable: true })
  providerResponse: string | null;

  @ApiPropertyOptional({ nullable: true })
  providerRespondedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  resolvedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, description: 'The operator’s reasoning, verbatim' })
  resolutionNote: string | null;

  @ApiPropertyOptional({ enum: RefundSource, nullable: true })
  refundSource: RefundSource | null;

  @ApiPropertyOptional({
    enum: RefundState,
    nullable: true,
    description:
      'REFUNDED: the buyer is not charged. NOT_CHARGED: it never was. NOT_REFUNDABLE: filed ' +
      'after the dispute window and the provider was paid — a quality signal only. PENDING: ' +
      'decided, the ledger step still landing.',
  })
  refundState: RefundState | null;

  @ApiPropertyOptional({ type: MoneyDto, nullable: true, description: 'What the decision owes' })
  refundAmount: MoneyDto | null;

  @ApiPropertyOptional({ type: MoneyDto, nullable: true, description: 'What was given back' })
  restoredAmount: MoneyDto | null;

  @ApiProperty({ description: 'The provider may still reply once' })
  canRespond: boolean;

  @ApiProperty({
    description:
      'Filed inside the dispute window: the payment is held, and an upheld decision refunds ' +
      'it in full. False: a quality signal, refunded only if the payment was not collected',
  })
  refundGuaranteed: boolean;

  @ApiProperty({ description: 'The sentence to show the buyer about refundGuaranteed' })
  refundNotice: string;

  @ApiProperty({
    format: 'date-time',
    description: 'The provider’s one reply is accepted until then: filing + 24 h',
  })
  replyDueAt: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'An operator is paged if it is still undecided then: filing + 48 h',
  })
  pageAt: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'The decision SLA: filing + 72 h, when it is auto-upheld or paged again',
  })
  decisionDueAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    description:
      'When the SLA auto-upholds it (filing + 72 h) if the provider stays silent. Null when it ' +
      'cannot be: decided or withdrawn, the provider replied, the refund is not guaranteed, or ' +
      'the amount needs two operators. The provider’s daily auto-uphold cap may still defer it',
  })
  autoUpholdAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    description:
      'While the payment is held in escrow: when the hold times out (collectableAt + 7 d) and ' +
      'anyone may collect it to the provider, so a refund must land before it. Null when ' +
      'nothing is held on chain',
  })
  holdEndsAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    description:
      'When the call’s filing window closed or closes (settlement + the configured window, ' +
      '7 days by default). Null when the call’s settlement time is unknown',
  })
  filingClosesAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class CallDisputeDetailDto extends CallDisputeDto {
  @ApiProperty({
    type: Object,
    description:
      'What the decision rests on, captured at filing: the call, its verdict, its input and ' +
      'output (when retention still kept them) and the evidence pack’s digests',
  })
  evidence: Record<string, unknown>;
}

export class BuyerDisputeHistoryDto {
  @ApiProperty()
  filedLastDay: number;

  @ApiProperty()
  upheldLast30Days: number;

  @ApiProperty()
  rejectedLast30Days: number;

  @ApiProperty({ description: 'Mostly rejected recently: the tighter filing limit applies' })
  flagged: boolean;

  @ApiProperty({ description: 'Disputes this buyer may file per rolling 24 hours' })
  dailyLimit: number;
}

export class OperatorCallDisputeRowDto extends CallDisputeDto {
  @ApiProperty({ format: 'uuid' })
  buyerOrganizationId: string;

  @ApiProperty({ type: BuyerDisputeHistoryDto })
  buyerHistory: BuyerDisputeHistoryDto;

  @ApiProperty({ description: 'Upholding needs a second operator (amount at or above threshold)' })
  needsSecondOperator: boolean;
}

export class OperatorCallDisputeIntentDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  rail: string;

  @ApiProperty()
  callClass: string;

  @ApiProperty({ type: MoneyDto })
  price: MoneyDto;

  @ApiProperty({ description: 'Where the money is: NORMAL, DEBT_OUTSTANDING, WRITTEN_OFF, …' })
  collectionState: string;

  @ApiProperty({ description: 'What an upheld decision would do now', example: 'VOID_DEBT' })
  refundPlan: string;
}

export class OperatorCallDisputeDecisionLogDto {
  @ApiProperty()
  code: string;

  @ApiProperty()
  action: string;

  @ApiProperty()
  actorOperatorId: string;

  @ApiPropertyOptional({ nullable: true })
  approverOperatorId: string | null;

  @ApiProperty()
  createdAt: Date;
}

export class OperatorCallDisputeDetailDto extends OperatorCallDisputeRowDto {
  @ApiProperty({ type: Object })
  evidence: Record<string, unknown>;

  @ApiPropertyOptional({ type: OperatorCallDisputeIntentDto, nullable: true })
  intent: OperatorCallDisputeIntentDto | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  resolvedBy: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', description: 'The second operator' })
  secondedBy: string | null;

  @ApiProperty({ type: [OperatorCallDisputeDecisionLogDto] })
  history: OperatorCallDisputeDecisionLogDto[];
}
