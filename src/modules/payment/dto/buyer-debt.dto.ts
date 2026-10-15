import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * One buyer debt that refuses the payer's paid calls: a served paid call whose
 * voucher lapsed for a reason that is not the provider's. The provider is not
 * paid yet; the payer's paid calls are refused until it is collected.
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

  @ApiProperty({
    enum: ['OPEN', 'REPLACING', 'WRITTEN_OFF'],
    description:
      '`OPEN`: sign the replacement. `REPLACING`: signed, being collected from the escrow — ' +
      'nothing to do; paid calls resume once it lands. `WRITTEN_OFF`: not settled within 30 ' +
      'days — the hold was released and the provider was not paid, but paid calls stay ' +
      'refused until it is signed (it can still be settled).',
  })
  state: 'OPEN' | 'REPLACING' | 'WRITTEN_OFF';

  @ApiProperty({
    description:
      'When the call FIRST became debt (ISO 8601). A replacement that fails does not reset it.',
  })
  lapsedAt: string;

  @ApiProperty({
    description:
      'When the debt is (or was) written off if still unsettled (ISO 8601): the hold is ' +
      'released and the provider is not paid. Paid calls stay refused after it.',
  })
  writeOffAt: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '`REPLACING` only: when the replacement voucher was accepted (ISO 8601).',
  })
  replacedAt: string | null;

  @ApiProperty({ description: 'When the call was made (ISO 8601).' })
  createdAt: string;
}

export class GetBuyerDebtsResponseDto {
  @ApiProperty({ description: 'The session’s payer account.' })
  account: string;

  @ApiProperty({
    type: [BuyerDebtDto],
    description: 'Debts that refuse paid calls (every state), oldest lapse first.',
  })
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

/** Body of `POST /escrow/debts/:intentId/voucher-intent` — usually empty. */
export class DebtVoucherIntentBodyDto {
  @ApiPropertyOptional({
    description:
      'Only for an old debt whose tool no longer exists: the `resource` the call’s voucher ' +
      'signed (`/mcp/tools/<name>`). Checked against the hash the call signed.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  resource?: string;
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
      '`REPLACING`: the replacement voucher was accepted; the redemption job collects it from ' +
      'the escrow within about a minute and credits the provider. Paid calls are allowed again ' +
      'once it is collected and no other debt is left. If the collection fails the debt is ' +
      '`OPEN` again, with its first lapse (and write-off date) unchanged.',
  })
  status: 'REPLACING';

  @ApiProperty({ description: 'The replacement voucher’s seq.' })
  seq: string;

  @ApiProperty({ description: 'Debts of this payer still to sign (OPEN or WRITTEN_OFF).' })
  remainingDebts: number;
}
