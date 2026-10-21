import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { TransformToArray } from '@decorators/transform-to-array.decorator';
import { ListQueryDto } from '@shared/api';

import { PaymentIntentStatus } from '../ports/payment.types';

/**
 * `GET /api/v1/tool-calls` — the call list every buyer screen opens
 * with. `payment_intents` LEFT JOIN `verification_records`.
 *
 * `status` and `verdict` are arrays — repeated values within one filter are
 * OR'd, per `backend/docs/api-list-contract.md`. `toolId` / `providerId` stay
 * scalar: a screen filtering "this tool" or "this provider" names exactly one.
 */
export class ListToolCallsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: PaymentIntentStatus, isArray: true })
  @IsOptional()
  @IsEnum(PaymentIntentStatus, { each: true })
  @TransformToArray()
  status?: PaymentIntentStatus[];

  @ApiPropertyOptional({ description: 'Tool id, exact match' })
  @IsOptional()
  @IsUUID()
  toolId?: string;

  @ApiPropertyOptional({ description: 'Provider id, exact match' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    enum: VerdictStatus,
    isArray: true,
    description: 'Only calls whose verification record carries one of these verdicts',
  })
  @IsOptional()
  @IsEnum(VerdictStatus, { each: true })
  @TransformToArray()
  verdict?: VerdictStatus[];

  @ApiPropertyOptional({
    description:
      'Only calls a report filed now would refund in full if upheld: the same read-only ' +
      'predicate as the receipt’s `refundableIfReportedNow` (and the filing’s ' +
      '`refundGuaranteed`), never the clock alone. Each row then carries ' +
      '`refundableIfReportedUntil`',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  refundable?: boolean;

  @ApiPropertyOptional({
    enum: ['free'],
    description:
      '`free`: also list the served free calls (`tool_call_records`), merged by time under one ' +
      'cursor. Every item then carries `kind` (`paid` | `free`); a free row has no intent, no ' +
      'payment status and no money fields. `status[]` or `refundable=true` leave free rows out. ' +
      'Sort `createdAt` only. Without it the response is unchanged',
  })
  @IsOptional()
  @IsIn(['free'])
  include?: 'free';

  @ApiPropertyOptional({
    enum: ['paid', 'free'],
    description: 'Only with `include=free`: only the paid rows, or only the free calls',
  })
  @IsOptional()
  @IsIn(['paid', 'free'])
  kind?: 'paid' | 'free';
}

/** One row of the call list, and the shape `GET /tool-calls/:intentId` returns for one. */
export class ToolCallDto {
  @ApiProperty({ description: 'The payment intent id' })
  intentId: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({ nullable: true, description: 'Null until the router has picked one' })
  providerId: string | null;

  @ApiProperty({ description: 'One of PaymentIntentStatus' })
  status: PaymentIntentStatus;

  @ApiProperty({ type: MoneyDto, description: 'What the call is listed at' })
  price: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      'What the agent actually paid — zero until SETTLED, and zero for a SETTLED call the ' +
      'provider forfeited or whose debt was written off. Always present, even when equal',
  })
  charged: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      'What the refund guarantee kept back, the receipt’s `withheld` and a part of ' +
      '`GET /withheld`: the listed price for a call that reserved money and was not charged ' +
      '(REFUNDED / VOIDED / EXPIRED with a hold, a forfeited or voided-debt call), zero ' +
      'otherwise — zero for an EXPIRED call that never reserved anything (it never ran)',
  })
  withheld: MoneyDto;

  @ApiProperty({
    description:
      'SETTLED, but the provider caused the payment to fail and forfeited it: the buyer is not ' +
      'charged (`charged` is zero) and nobody was paid',
  })
  forfeited: boolean;

  @ApiPropertyOptional({
    nullable: true,
    enum: ['OUTSTANDING', 'WRITTEN_OFF', 'VOIDED'],
    description:
      'Buyer debt: `OUTSTANDING` — the payment could not be collected, the price stays held and ' +
      'the payer must sign a replacement voucher (GET /escrow/debts) before paid calls work ' +
      'again (also while a signed replacement is being collected); `WRITTEN_OFF` — never ' +
      'settled, the hold was released and the provider not paid, and paid calls stay refused ' +
      'until it is signed; `VOIDED` — the call failed verification after it had become debt: ' +
      'not charged, nobody paid. Null otherwise',
  })
  debt: 'OUTSTANDING' | 'WRITTEN_OFF' | 'VOIDED' | null;

  @ApiProperty({
    description:
      'SETTLED, and refunded because the buyer reported a bad result and the report was ' +
      'upheld: not charged (`charged` is zero, `debt` is `VOIDED`)',
  })
  refundedByReport: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'When the payment may be collected from the escrow (the dispute hold). Until then the ' +
      'price stays held and is not the provider’s. Null when the call has no hold',
  })
  collectableAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Dispute before this and an upheld dispute refunds the call in full; after it a dispute ' +
      'is a quality signal. Null when the call has no hold',
  })
  disputeWindowEndsAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: VerdictStatus,
    description: 'Null until verification has judged this call',
  })
  verdict: VerdictStatus | null;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Only with `refundable=true`: the instant the full-refund answer lapses (the ' +
      'receipt’s `refundableIfReportedUntil`). Null when no end is known yet: a voucher not ' +
      'redeemed, whose hour starts at redemption',
  })
  refundableIfReportedUntil?: Date | null;
}

/**
 * A served free call in `GET /tool-calls?include=free` (BUG-AGT-01): no payment
 * intent, no payment status and no money fields, because nothing was charged.
 */
export class FreeToolCallDto {
  @ApiProperty({ enum: ['free'] })
  kind: 'free';

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Always null: a free call has no intent',
  })
  intentId: null;

  @ApiProperty({ description: 'The call id the provider received as `X-Assay-Call-Id`' })
  callId: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  toolId: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  toolName: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  providerId: string | null;

  @ApiProperty({ enum: ['FREE', 'FREEMIUM'] })
  pricingMode: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Only when the call was sampled for verification; null means not checked',
  })
  verdict: string | null;

  @ApiProperty()
  createdAt: Date;
}

/** A paid row of `GET /tool-calls?include=free`: the usual row plus `kind`. */
export type PaidToolCallRowDto = ToolCallDto & { kind: 'paid' };

/** One item of `GET /tool-calls`: the usual row, or with `include=free` either kind. */
export type ToolCallListItemDto = ToolCallDto | PaidToolCallRowDto | FreeToolCallDto;
