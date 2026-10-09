import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

import { EscrowIntentKind } from '../ports/escrow-intent-builder.port';
import { GetEscrowResponseDto } from './get-escrow.dto';

/**
 * A `uint64` on the wire: a decimal integer string, never a JSON number.
 *
 * The same rule the whole public seam already follows — `JSON.stringify` throws
 * on a `bigint` and a `number` silently loses precision above 2^53, and every
 * one of these values is inside a struct the contract hashes. A field that
 * arrived rounded would produce a digest the signature does not cover, and the
 * symptom would be `SignerIsNotBuyer` on a signature that was perfectly good.
 *
 * 20 digits is `uint64`'s decimal width; the range check is
 * `EvmRelayedEscrowIntentSubmitter.uint64`, because a string's shape bounds its
 * length and not its value.
 */
const UINT64_STRING = /^\d+$/;
const UINT64_MAX_DIGITS = 20;

/**
 * `r || s || v` — 65 bytes, 130 hex digits, `0x`-prefixed.
 *
 * Matched here so a truncated or double-prefixed signature is a 400 naming the
 * field rather than a decode failure inside an ABI encoder. It is a **shape**
 * check and nothing more: whether these bytes recover to the buyer is the
 * contract's question, asked with `ecrecover`, and this backend deliberately
 * never forms a second opinion about it.
 */
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** EIP-55 tolerated in either case — see `WithdrawalService.assertIsOwnAccount`. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The half of a relayed request that is identical for both doors.
 *
 * Not a base class the two extend: `@nestjs/swagger`'s CLI plugin and
 * `class-validator`'s metadata both walk the prototype chain correctly, but an
 * inherited `@ApiProperty` renders in the emitted OpenAPI only when the parent
 * is also registered — and an unregistered `$ref` ships a dangling pointer that
 * every generated client fails on, with no unit test seeing it. Spelled out
 * twice below instead. The cost is duplication in a file; the alternative is a
 * broken generated client.
 */

/**
 * Body of `POST /escrow/limits` — the signed `SetLimits` the platform relays.
 *
 * **Every field is echoed back from the `typed-data` member `POST
 * /escrow/limits-intent` answered with**, unchanged, plus the signature the
 * wallet produced over it. A client re-deriving any of them is a client that
 * can sign one thing and post another; echoing means a mismatch is a signature
 * the contract refuses rather than one this backend quietly repairs.
 *
 * `buyer` is here so that a request naming somebody else can be refused **by
 * name** — it is never the address the call is encoded for. That comes from the
 * session, always. See `WithdrawalService.submitRelayedIntent`.
 */
export class SubmitSetLimitsBodyDto {
  @ApiProperty({
    description:
      "The `buyer` inside the signed message. Must be this session's own account — a request " +
      'naming anybody else is refused 403 `SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER`, because the ' +
      "platform pays the gas and will not pay it for somebody else's signature.",
    example: '0x1b89caB90cbc71bBFad47E45707D17787cf91dD1',
  })
  @IsString()
  @Matches(ADDRESS, { message: 'buyer must be a 20-byte 0x address' })
  buyer: string;

  @ApiProperty({
    description: 'Atomic units, decimal integer string, as signed. `0` refuses every redeem.',
    example: '2500000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'maxVoucherAmount must be a decimal integer string' })
  maxVoucherAmount: string;

  @ApiProperty({
    description: 'Atomic units, decimal integer string, as signed.',
    example: '9000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'maxPerWindow must be a decimal integer string' })
  maxPerWindow: string;

  @ApiProperty({
    description:
      '`Escrow.authNonce` as it stood when the request was issued. **One counter serves both ' +
      'relayed doors** — a `setLimits` that lands first invalidates a `requestWithdraw` signed ' +
      'against the same value, and the chain says so with `BadNonce`.',
    example: '0',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'nonce must be a decimal integer string' })
  nonce: string;

  @ApiProperty({
    description:
      "Unix seconds, as signed. Issued on the CHAIN's clock, which is the only one " +
      '`_consumeAuth` compares it against.',
    example: '1789139970',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'deadline must be a decimal integer string' })
  deadline: string;

  @ApiProperty({
    description: "The wallet's EIP-712 signature over the message above: `r || s || v`, 65 bytes.",
    example: '0x' + '00'.repeat(65),
  })
  @IsString()
  @Matches(SIGNATURE, { message: 'signature must be 65 bytes of hex (r || s || v)' })
  signature: string;
}

/**
 * Body of `POST /escrow/withdrawals/request` — the signed `RequestWithdraw` the
 * platform relays. Same rules as {@link SubmitSetLimitsBodyDto}.
 *
 * `amount: "0"` retracts a standing request, which is the chain's own semantics
 * and is passed through rather than special-cased.
 */
export class SubmitRequestWithdrawBodyDto {
  @ApiProperty({
    description: "The `buyer` inside the signed message. Must be this session's own account.",
    example: '0x1b89caB90cbc71bBFad47E45707D17787cf91dD1',
  })
  @IsString()
  @Matches(ADDRESS, { message: 'buyer must be a 20-byte 0x address' })
  buyer: string;

  @ApiProperty({
    description:
      'Atomic units, decimal integer string, as signed. `"0"` cancels a standing request.',
    example: '400000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'amount must be a decimal integer string' })
  amount: string;

  @ApiProperty({
    description: '`Escrow.authNonce` as it stood when the request was issued.',
    example: '1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'nonce must be a decimal integer string' })
  nonce: string;

  @ApiProperty({
    description: "Unix seconds, as signed, on the chain's clock.",
    example: '1789139974',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(UINT64_MAX_DIGITS)
  @Matches(UINT64_STRING, { message: 'deadline must be a decimal integer string' })
  deadline: string;

  @ApiProperty({
    description: "The wallet's EIP-712 signature over the message above: `r || s || v`, 65 bytes.",
    example: '0x' + '00'.repeat(65),
  })
  @IsString()
  @Matches(SIGNATURE, { message: 'signature must be 65 bytes of hex (r || s || v)' })
  signature: string;
}

/**
 * What both submit routes answer with.
 *
 * **No `transaction` member, and that is the point of a separate DTO.** The
 * four `*-intent` routes answer `CreateEscrowIntentResponseDto`, whose
 * `transaction` is bytes somebody still has to sign. These routes answer about
 * a transaction that has already landed, and reusing that shape would have
 * meant a `transaction` field that is either null or a lie.
 *
 * `escrow` is read **off the chain after the transaction was mined**, not
 * predicted from what was submitted — so a console re-renders from the
 * contract's own answer, and `authNonce` having advanced is something it
 * observes rather than something this backend asserts.
 */
export class RelayedEscrowIntentResponseDto {
  @ApiProperty({
    enum: [EscrowIntentKind.SET_LIMITS, EscrowIntentKind.REQUEST_WITHDRAW],
    description:
      'Which door was relayed. `WITHDRAW` can never appear here: `withdraw()` is ' +
      '`msg.sender`-only, there is no `withdrawBySig` in the contract or its bytecode, and the ' +
      'port excludes the kind at the type level.',
  })
  kind: EscrowIntentKind.SET_LIMITS | EscrowIntentKind.REQUEST_WITHDRAW;

  @ApiProperty({ description: "The buyer's CAIP-10 account this call was relayed for." })
  account: string;

  @ApiProperty({
    description:
      "The relayer's transaction, which SUCCEEDED — a revert is an error response naming the " +
      "contract's own refusal, never a 200 with a failed hash in it.",
  })
  transactionHash: string;

  @ApiProperty({ description: 'Decimal string. The block that included it.' })
  blockNumber: string;

  @ApiProperty({
    description:
      'Decimal string. What the platform paid for, in gas — published because the buyer paid ' +
      'none of it and is entitled to see what was spent on their behalf.',
  })
  gasUsed: string;

  @ApiProperty({
    type: GetEscrowResponseDto,
    description: 'The escrow as the chain reports it AFTER this transaction landed.',
  })
  escrow: GetEscrowResponseDto;
}
