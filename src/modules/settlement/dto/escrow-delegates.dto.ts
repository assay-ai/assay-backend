import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import {
  UnsignedChainTransactionDto,
  unsignedChainTransactionSchema,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

import { EscrowDelegationKind, EscrowDelegationStatus } from '../ports/escrow-delegation.port';
import { UnsettledVouchersDto } from './get-escrow.dto';

/**
 * Agent payment delegation — the relayed `AuthorizeDelegate` / `RevokeDelegate`
 * doors, modelled exactly on the escrow-limits pair: an `…intent` route builds
 * the EIP-712 request the payer's wallet signs, and the bare route relays what
 * was signed through the platform's relayer, so a payer without gas (a Privy
 * embedded wallet) pays none.
 *
 * Deliberately no base class: `@nestjs/swagger` renders an inherited DTO as a
 * `$ref` to a schema nobody else names, and the escrow DTOs avoid it for that
 * reason too.
 */

const UINT64_STRING = /^\d+$/;
const UINT64_MAX_DIGITS = 20;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `POST /escrow/delegates/intent` */
export class CreateDelegateIntentBodyDto {
  @ApiProperty({
    description:
      "The delegate key's 0x address — the key the agent holds and proved possession of. Never " +
      'the payer itself.',
    example: '0x5555555555555555555555555555555555555555',
  })
  @IsString()
  @Matches(ADDRESS, { message: 'delegate must be a 20-byte 0x address' })
  delegate: string;

  @ApiProperty({
    description:
      "Atomic units. The delegate's per-voucher cap: above zero, at most the per-window cap " +
      "and at most the escrow's own `maxVoucherAmount`.",
    example: '1000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'maxVoucherAmount must be a decimal integer string' })
  maxVoucherAmount: string;

  @ApiProperty({
    description:
      "Atomic units. The delegate's own rolling-window cap, at most the escrow's own " +
      '`maxPerWindow`. The escrow ceilings keep applying too.',
    example: '10000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'maxPerWindow must be a decimal integer string' })
  maxPerWindow: string;

  @ApiProperty({
    description:
      "Unix seconds. The delegate's authority lapses after this instant; at most 365 days out.",
    example: '1792000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'validUntil must be a decimal integer string' })
  validUntil: string;

  @ApiPropertyOptional({
    description:
      'BUG-D1-07. True accepts that this change lowers a cap below what payments still being ' +
      'settled need, so the chain will refuse them and their providers go unpaid by the chain. ' +
      'Without it such a change is refused `SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK`.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeUnsettled?: boolean;
}

/** `POST /escrow/delegates` — the issued `AuthorizeDelegate` message, echoed back, plus the signature. */
export class SubmitAuthorizeDelegateBodyDto {
  @ApiProperty({
    description: "The `payer` inside the signed message. Must be this session's own account.",
  })
  @IsString()
  @Matches(ADDRESS, { message: 'payer must be a 20-byte 0x address' })
  payer: string;

  @ApiProperty()
  @IsString()
  @Matches(ADDRESS, { message: 'delegate must be a 20-byte 0x address' })
  delegate: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'maxVoucherAmount must be a decimal integer string' })
  maxVoucherAmount: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'maxPerWindow must be a decimal integer string' })
  maxPerWindow: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'validUntil must be a decimal integer string' })
  validUntil: string;

  @ApiProperty({
    description:
      '`Escrow.authNonce` when the request was issued — shared with SetLimits and ' +
      'RequestWithdraw, so any later decision by the payer makes this signature dead.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'nonce must be a decimal integer string' })
  nonce: string;

  @ApiProperty({ description: "Unix seconds, on the chain's clock, as signed." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'deadline must be a decimal integer string' })
  deadline: string;

  @ApiProperty({ description: "The payer wallet's EIP-712 signature: `r || s || v`, 65 bytes." })
  @IsString()
  @Matches(SIGNATURE, { message: 'signature must be 65 bytes of hex (r || s || v)' })
  signature: string;

  @ApiPropertyOptional({
    description:
      'BUG-D1-07. True accepts that this change lowers a cap below what payments still being ' +
      'settled need, so the chain will refuse them and their providers go unpaid by the chain. ' +
      'Without it such a change is refused `SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK`.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeUnsettled?: boolean;
}

/** `POST /escrow/delegates/revoke-intent` */
export class CreateRevokeDelegateIntentBodyDto {
  @ApiProperty({ example: '0x5555555555555555555555555555555555555555' })
  @IsString()
  @Matches(ADDRESS, { message: 'delegate must be a 20-byte 0x address' })
  delegate: string;
}

/** `POST /escrow/delegates/revoke` — the issued `RevokeDelegate` message, echoed back, plus the signature. */
export class SubmitRevokeDelegateBodyDto {
  @ApiProperty({
    description: "The `payer` inside the signed message. Must be this session's own account.",
  })
  @IsString()
  @Matches(ADDRESS, { message: 'payer must be a 20-byte 0x address' })
  payer: string;

  @ApiProperty()
  @IsString()
  @Matches(ADDRESS, { message: 'delegate must be a 20-byte 0x address' })
  delegate: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'nonce must be a decimal integer string' })
  nonce: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'deadline must be a decimal integer string' })
  deadline: string;

  @ApiProperty()
  @IsString()
  @Matches(SIGNATURE, { message: 'signature must be 65 bytes of hex (r || s || v)' })
  signature: string;
}

export class EscrowDelegateDto {
  @ApiProperty({ description: "The delegate's CAIP-10 account." })
  delegate: string;

  @ApiProperty({ type: MoneyDto })
  maxVoucherAmount: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  maxPerWindow: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: "The delegate's own window, decayed to now." })
  spentInWindow: MoneyDto;

  @ApiProperty({ description: 'ISO-8601. The authority lapses after this instant.' })
  validUntil: string;

  @ApiProperty({ enum: EscrowDelegationStatus })
  status: EscrowDelegationStatus;

  @ApiProperty({
    type: UnsettledVouchersDto,
    description:
      'Payments this key signed that the chain has not redeemed yet (BUG-D1-07). Lowering a ' +
      'cap below what they need, or revoking, leaves them unredeemable.',
  })
  unsettled: UnsettledVouchersDto;
}

/** `GET /escrow/delegates` — read from the chain, never from this backend's memory. */
export class ListEscrowDelegatesResponseDto {
  @ApiProperty({ description: "The payer's CAIP-10 account." })
  account: string;

  @ApiProperty({ type: [EscrowDelegateDto] })
  delegates: EscrowDelegateDto[];
}

export class DelegateIntentResponseDto {
  @ApiProperty({ enum: EscrowDelegationKind })
  kind: EscrowDelegationKind;

  @ApiProperty({ description: "The payer's CAIP-10 account this request is built for." })
  account: string;

  @ApiProperty({
    ...unsignedChainTransactionSchema(),
    description: 'The relayed EIP-712 request the payer signs (`relayed: true`).',
  })
  transaction: UnsignedChainTransactionDto;
}

export class RelayedDelegateResponseDto {
  @ApiProperty({ enum: EscrowDelegationKind })
  kind: EscrowDelegationKind;

  @ApiProperty()
  account: string;

  @ApiProperty({ description: "The relayer's transaction, which succeeded." })
  transactionHash: string;

  @ApiProperty()
  blockNumber: string;

  @ApiProperty({ description: 'What the platform paid for, in gas.' })
  gasUsed: string;

  @ApiProperty({
    type: [EscrowDelegateDto],
    nullable: true,
    description:
      "The payer's delegates as the chain reports them AFTER this transaction, or null when " +
      'that read failed — the transaction itself landed; read `GET /escrow/delegates` again.',
  })
  delegates: EscrowDelegateDto[] | null;
}
