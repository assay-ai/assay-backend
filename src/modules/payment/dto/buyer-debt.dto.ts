import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsString, MaxLength } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * One open buyer debt: a served paid call whose voucher lapsed for a reason
 * that is not the provider's. The buyer's hold is still open, the provider is
 * not paid yet, and the payer's paid calls are refused until it is settled.
 */
export class BuyerDebtDto {
  @ApiProperty({ description: 'The payment intent of the served call — the debt id.' })
  intentId: string;

  @ApiProperty({ description: 'The payer account (CAIP-10) whose escrow owes it.' })
  payer: string;

  @ApiProperty({ type: MoneyDto, description: 'What is owed: the call’s price, exactly.' })
  amount: MoneyDto;

  @ApiPropertyOptional({ nullable: true, type: String })
  providerId: string | null;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Why the voucher lapsed — the chain refusal (`VoucherExpired`, `DelegateIsRevoked`, …).',
  })
  cause: string | null;

  @ApiProperty({ description: 'When the call became debt (ISO 8601).' })
  lapsedAt: string;

  @ApiProperty({
    description:
      'When the debt is written off if still unsettled (ISO 8601): the hold is released and ' +
      'the provider is not paid.',
  })
  writeOffAt: string;

  @ApiProperty({ description: 'When the call was made (ISO 8601).' })
  createdAt: string;
}

export class GetBuyerDebtsResponseDto {
  @ApiProperty({ description: 'The session’s payer account.' })
  account: string;

  @ApiProperty({ type: [BuyerDebtDto], description: 'Open debts, oldest first.' })
  debts: BuyerDebtDto[];
}

/**
 * The replacement voucher to sign for one debt — every field already chosen,
 * a fresh `seq` included, so the signer signs it as is and echoes it back.
 */
export class DebtVoucherIntentResponseDto {
  @ApiProperty({ type: BuyerDebtDto })
  debt: BuyerDebtDto;

  @ApiProperty({
    type: Object,
    description:
      'The unsigned voucher (`payer`, `payTo`, `provider`, `amount`, `resource`, `requestHash`, ' +
      '`seq`, `issuedAt`, `expiresAt`) — the same shape an agent signs for ' +
      '`x402/paymentRequired`. Sign it unchanged before `expiresAt`.',
  })
  voucher: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [String],
    description:
      'eip155 only: who may sign — `payer` (the wallet) or `delegate` (a delegate key bound ' +
      'to the calling agent credential, within its on-chain caps).',
  })
  signers?: string[];

  @ApiPropertyOptional({ nullable: true, type: String })
  delegate?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Object,
    description:
      'eip155 only: the voucher as an EIP-712 `signTypedData` request for the payer’s ' +
      'wallet (integers as decimal strings). `null` on chains without one.',
  })
  typedData: Record<string, unknown> | null;
}

/** Body of `POST /escrow/debts/:intentId/voucher`. */
export class SettleDebtBodyDto {
  @ApiProperty({
    type: Object,
    description: 'The voucher `POST /escrow/debts/:intentId/voucher-intent` answered, unchanged.',
  })
  @IsObject()
  voucher: Record<string, unknown>;

  @ApiProperty({ description: 'The payer’s (or a bound delegate’s) signature over it.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  signature: string;
}

export class SettleDebtResponseDto {
  @ApiProperty()
  intentId: string;

  @ApiProperty({
    description:
      '`REPLACED`: the replacement voucher was accepted; the redemption job collects it from ' +
      'the escrow within about a minute and credits the provider. Paid calls are allowed again ' +
      'once no other debt is open.',
  })
  status: 'REPLACED';

  @ApiProperty({ description: 'The replacement voucher’s seq.' })
  seq: string;

  @ApiProperty({ description: 'Open debts left for this payer.' })
  remainingDebts: number;
}
