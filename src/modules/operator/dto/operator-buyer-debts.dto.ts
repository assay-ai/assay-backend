import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PageInfoDto } from '@shared/api/dto/cursor-page.dto';
import { ListQueryDto } from '@shared/api/dto/list-query.dto';

/** At most this many intents per bulk void request (`M-1`). */
export const DEBT_VOID_MAX_IDS = 500;

/**
 * `GET /operator/buyer-debts`. Open buyer debts across every organization.
 *
 * `from` / `to` bound the LAPSE time (`lapsedAt`, when the call became debt).
 * `sort` is `lapsedAt` (default) or `createdAt`.
 */
export class ListOperatorBuyerDebtsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'CAIP-2 chain id', example: 'eip155:42161' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  chainId?: string;

  @ApiPropertyOptional({ description: 'CAIP-19 asset id' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  assetId?: string;

  @ApiPropertyOptional({ description: 'The paying account (CAIP-10), case-insensitive' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  payerAccount?: string;

  @ApiPropertyOptional({ description: 'The buyer organization' })
  @IsOptional()
  @IsUUID()
  buyerOrganizationId?: string;

  @ApiPropertyOptional({ description: 'The provider that served the call' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    description:
      'The refusal the voucher lapsed on, exactly, e.g. `VoucherExpired`, `EscrowInsufficient`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  lastError?: string;

  @ApiPropertyOptional({
    description: 'Only rows labelled `suggestedPlatformCause` (applied to the page and the totals)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  suggestedOnly?: boolean;
}

/** One open buyer debt, as the operator's bulk-void page lists it. */
export class OperatorBuyerDebtRowDto {
  @ApiProperty({ description: 'The payment intent id: what a bulk void names' })
  intentId: string;

  @ApiProperty({ description: 'The buyer organization the debt belongs to' })
  buyerOrganizationId: string;

  @ApiProperty({ description: 'The paying account (CAIP-10)' })
  payerAccount: string;

  @ApiPropertyOptional({ nullable: true })
  providerId: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'The provider’s payee account (CAIP-10)' })
  providerAccount: string | null;

  @ApiProperty({ description: 'CAIP-2' })
  chainId: string;

  @ApiProperty({ description: 'CAIP-19' })
  assetId: string;

  @ApiProperty()
  decimals: number;

  @ApiProperty({ description: 'What the buyer owes, atomic units as a decimal string' })
  amount: string;

  @ApiPropertyOptional({ nullable: true, description: 'The voucher seq, a decimal string' })
  voucherSeq: string | null;

  @ApiProperty({ description: 'When the call was made' })
  createdAt: Date;

  @ApiProperty({ description: 'When the call became buyer debt' })
  lapsedAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The refusal the voucher lapsed on (`redemption_last_error`), `uncollected:` stripped',
  })
  lastError: string | null;

  @ApiProperty({
    description:
      'Written off already (30 days unsettled): the hold is released but the payer is still refused',
  })
  writtenOff: boolean;

  @ApiProperty({
    description:
      'INFORMATIONAL ONLY. True when the recorded cause suggests the platform failed to redeem ' +
      '(`VoucherExpired` with no other cause, `UNKNOWN_REVERT:*`, `FeeSpikeDeferred`). Never ' +
      'acted on by the server: a person decides.',
  })
  suggestedPlatformCause: boolean;
}

/** Count and amount of one asset's debts in the filtered list. */
export class OperatorBuyerDebtTotalDto {
  @ApiProperty({ description: 'CAIP-19' })
  assetId: string;

  @ApiProperty()
  decimals: number;

  @ApiProperty()
  count: number;

  @ApiProperty({ description: 'Atomic units as a decimal string' })
  amount: string;
}

export class OperatorBuyerDebtTotalsDto {
  @ApiProperty({ description: 'Every debt the filters match, across all pages' })
  count: number;

  @ApiProperty({
    type: [OperatorBuyerDebtTotalDto],
    description: 'Per asset; amounts of different assets are never added',
  })
  byAsset: OperatorBuyerDebtTotalDto[];
}

/** A cursor page of debts, with the totals of everything the filters match. */
export class OperatorBuyerDebtPageDto {
  @ApiProperty({ type: [OperatorBuyerDebtRowDto] })
  items: OperatorBuyerDebtRowDto[];

  @ApiProperty({ type: PageInfoDto })
  pageInfo: PageInfoDto;

  @ApiProperty({ type: OperatorBuyerDebtTotalsDto })
  totals: OperatorBuyerDebtTotalsDto;
}

/** `POST /operator/buyer-debts/void`. Always queued for a second operator (`M-1`). */
export class RequestBuyerDebtVoidBodyDto {
  @ApiProperty({
    type: [String],
    description: `Intent ids, all open buyer debts of ONE asset; 1 to ${DEBT_VOID_MAX_IDS}`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DEBT_VOID_MAX_IDS)
  @IsUUID('all', { each: true })
  intentIds: string[];

  @ApiProperty({
    description: 'Why the platform, not the buyer, caused these debts. Kept in the audit log',
    minLength: 10,
    maxLength: 2048,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  reason: string;

  @ApiPropertyOptional({ description: 'An external ticket or incident, if any', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

export const DEBT_VOID_SKIP_REASONS = [
  'NOT_A_DEBT',
  'SEQ_USED_ON_CHAIN',
  'CHAIN_UNREADABLE',
  'CHANGED_UNDERNEATH',
] as const;
export type DebtVoidSkipReason = (typeof DEBT_VOID_SKIP_REASONS)[number];

export class BuyerDebtVoidItemDto {
  @ApiProperty()
  intentId: string;

  @ApiProperty({ enum: ['VOIDED', 'SKIPPED'] })
  result: 'VOIDED' | 'SKIPPED';

  @ApiPropertyOptional({
    enum: DEBT_VOID_SKIP_REASONS,
    nullable: true,
    description:
      '`NOT_A_DEBT`: settled, replaced or voided since. `SEQ_USED_ON_CHAIN`: `held(payer, seq)` ' +
      'is not NONE. `CHAIN_UNREADABLE`: the chain record could not be read. ' +
      '`CHANGED_UNDERNEATH`: the row changed between the check and the void',
  })
  skipReason: DebtVoidSkipReason | null;
}

/** What an approved bulk void did, per id (the `result` of the approve route). */
export class BuyerDebtVoidResultDto {
  @ApiProperty({ description: 'The approval this ran under' })
  approvalId: string;

  @ApiProperty({ description: 'CAIP-19, the one asset the request pinned' })
  assetId: string;

  @ApiProperty()
  decimals: number;

  @ApiProperty({ description: 'Ids requested (and pinned in the approval)' })
  requestedCount: number;

  @ApiProperty({ description: 'Total requested, atomic units' })
  requestedAmount: string;

  @ApiProperty()
  voidedCount: number;

  @ApiProperty({ description: 'Total voided, atomic units' })
  voidedAmount: string;

  @ApiProperty({ type: [BuyerDebtVoidItemDto] })
  items: BuyerDebtVoidItemDto[];
}
