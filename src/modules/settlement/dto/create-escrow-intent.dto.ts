import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import {
  UnsignedChainTransactionDto,
  unsignedChainTransactionSchema,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';

import { EscrowIntentKind } from '../ports/escrow-intent-builder.port';
import { GasGrantRefusal } from '../ports/withdraw-gas-grant.port';
import { GetEscrowResponseDto } from './get-escrow.dto';

/**
 * `POST /escrow/limits-intent` — the buyer's brake.
 *
 * Both limits move together, because `set_escrow_limits` takes both and a
 * partial update would need a read-modify-write the buyer did not sign.
 * **`0` means refuse every redeem, not "unlimited"** — a buyer who wants no
 * ceiling sends `u64::MAX` as a decimal string.
 */
export class SetEscrowLimitsBodyDto {
  @ApiProperty({
    description: 'Atomic units, decimal integer string. `0` refuses every redeem.',
    example: '100000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^\d+$/, { message: 'maxVoucherAmount must be a non-negative decimal integer string' })
  maxVoucherAmount: string;

  @ApiProperty({
    description: 'Atomic units, decimal integer string. `0` refuses every redeem.',
    example: '1000000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^\d+$/, { message: 'maxPerWindow must be a non-negative decimal integer string' })
  maxPerWindow: string;
}

/**
 * `POST /escrow/withdrawals/request-intent` — step 1 of 2.
 *
 * `amount: "0"` cancels a standing request and is the only way
 * back to serving traffic without actually withdrawing — `VoucherService`
 * refuses new vouchers while a request stands.
 */
export class RequestWithdrawBodyDto {
  @ApiProperty({
    description: 'Atomic units, decimal integer string. `"0"` cancels a standing request.',
    example: '5000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^\d+$/, { message: 'amount must be a non-negative decimal integer string' })
  amount: string;
}

/**
 * `POST /escrow/withdrawals/intent` — step 2 of 2. Pays
 * `min(requested, escrow_ata.amount)`; the buyer never chooses an amount.
 */
export class WithdrawBodyDto {
  @ApiProperty({
    required: false,
    description:
      "The token account the buyer wants paid, chain-native. Absent means the buyer's own ATA " +
      'for the escrow mint, which is what a console sends by default.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  destination?: string;
}

/**
 * The gas grant that this `withdraw` triggered (EVM only).
 *
 * ## What a console is told, and what it is not
 *
 * `status` and `reason` are the whole vocabulary, and there is deliberately
 * **no wei figure and no cap on this wire**. A buyer cannot act on either: the
 * grant is exactly one `withdraw`'s worth of gas, they did not choose it and
 * they cannot change it. What publishing them would do is let anyone with a
 * session and a matured withdrawal measure the platform's faucet — pair
 * `ABOVE_PER_GRANT_CAP` with the wei that was refused and the per-grant cap is
 * bracketed in two calls; pair `DAILY_CAP_REACHED` with a running total and so
 * is the daily one. `transactionHash` is here instead, which is strictly more
 * useful to the buyer (it is the transfer, on an explorer, with the amount on
 * it) and tells a prober nothing they could not already see on chain.
 *
 * The refusal REASON is published, and that is a considered trade rather than
 * an oversight. Two of the seven are the buyer's own situation
 * (`BUYER_HAS_GAS`, `ALREADY_GRANTED`) and they need to be told which; the
 * operational ones (`RELAYER_FLOAT_LOW`, `DAILY_CAP_REACHED`) tell an attacker
 * only that a faucet they cannot drain is currently dry, and withholding them
 * would leave a stranded buyer with "no" and nothing else at the moment they
 * are trying to get their money out.
 */
export class WithdrawGasGrantDto {
  @ApiProperty({
    enum: ['GRANTED', 'REFUSED', 'UNAVAILABLE'],
    description:
      '`GRANTED` — the relayer sent this address the gas for one `withdraw`; wait for it to ' +
      'land, then sign. `REFUSED` — a control fired; `reason` says which, and the system is ' +
      'working. `UNAVAILABLE` — the grant could not be consulted at all. The withdrawal ' +
      'transaction is valid in every one of the three: this field never gates it.',
  })
  status: 'GRANTED' | 'REFUSED' | 'UNAVAILABLE';

  @ApiProperty({
    enum: GasGrantRefusal,
    nullable: true,
    description: 'Which control refused. Non-null exactly when `status` is `REFUSED`.',
  })
  reason: GasGrantRefusal | null;

  @ApiProperty({
    nullable: true,
    description:
      'The transfer that funded this address. Non-null exactly when `status` is `GRANTED`. ' +
      'The withdrawal cannot be sent until it confirms.',
  })
  transactionHash: string | null;
}

/**
 * `POST /escrow/{limits,withdrawals/request,withdrawals,close}-intent` — one
 * shape for all four, because every one of them carries the same two things:
 * the unsigned bytes, and the escrow state as it was when they were built (so
 * the console can re-render without a second `GET /escrow`).
 */
export class CreateEscrowIntentResponseDto {
  @ApiProperty({ enum: EscrowIntentKind })
  kind: EscrowIntentKind;

  @ApiProperty({ description: "The buyer's CAIP-10 account this transaction is built for." })
  account: string;

  @ApiProperty({
    ...unsignedChainTransactionSchema(),
    description:
      'One of the three members of `UnsignedChainTransaction`. On Solana this is the ' +
      'compiled unsigned wire transaction; on EVM two of these four doors are relayed EIP-712 ' +
      'signature requests, which is why this is a union and not a transaction.',
  })
  transaction: UnsignedChainTransactionDto;

  @ApiProperty({
    type: GetEscrowResponseDto,
    description: 'The state as it was when the bytes were built.',
  })
  escrow: GetEscrowResponseDto;

  @ApiProperty({
    type: WithdrawGasGrantDto,
    nullable: true,
    description:
      'The withdrawal gas grant this request triggered. `null` on every kind but `WITHDRAW`, and ' +
      '`null` on a chain that has no gas grant — Solana, where the buyer already holds the SOL ' +
      'that signs their own withdrawal. Never a reason the withdrawal itself failed: a refusal ' +
      'here arrives alongside perfectly valid unsigned bytes.',
  })
  gasGrant: WithdrawGasGrantDto | null;
}
