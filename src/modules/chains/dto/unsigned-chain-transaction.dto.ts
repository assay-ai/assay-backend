import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';

import { ChainId } from '../ports/caip.types';
import {
  Eip155TypedDataRequest,
  Eip155UnsignedTransaction,
  Eip712Domain,
  Eip712Field,
  SolanaUnsignedTransaction,
  UnsignedChainTransaction,
} from '../ports/unsigned-chain-transaction';

/**
 * The Swagger face of `UnsignedChainTransaction`, and the one mapper
 * that turns the port's value into it.
 *
 * ## Why three classes and a `oneOf`
 *
 * `@nestjs/swagger` builds schemas from decorated **classes**, and a TypeScript
 * union is not one. Three classes plus `oneOf` is how the union survives into
 * the OpenAPI document and therefore into every generated client; declaring one
 * fat class with every field optional would emit a schema in which no field is
 * required and a client could construct a transaction that is neither.
 *
 * ## Why no `discriminator`
 *
 * OpenAPI's `discriminator` names exactly one `propertyName`. This union needs
 * **two** — `namespace` separates Solana from EVM, `kind` separates the EVM
 * transaction from the EVM signature request. Emitting `discriminator:
 * { propertyName: 'namespace' }` would be a claim the document cannot keep, and
 * a generated client that trusted it would pick between the two `eip155`
 * members arbitrarily. `oneOf` alone is honest; the client narrows on both
 * fields, exactly as this codebase does.
 *
 * ## The conformance assertions at the bottom of this file
 *
 * Three `const _…: true` lines assert that each DTO class is assignable to its
 * port member. They are compile-time and they are the guard: a DTO that drifts
 * from the port — a renamed field, a widened type, a dropped literal — stops
 * being assignable and `tsc` refuses the build. Without them the two shapes are
 * two hand-maintained copies of one contract, with nothing to keep them in
 * sync.
 */

export class Eip712FieldDto implements Eip712Field {
  @ApiProperty({ example: 'maxVoucherAmount' })
  name!: string;

  @ApiProperty({ description: 'A Solidity type name, as EIP-712 spells it', example: 'uint256' })
  type!: string;
}

export class Eip712DomainDto implements Eip712Domain {
  @ApiProperty({ example: 'X402Escrow' })
  name!: string;

  @ApiProperty({ example: '1' })
  version!: string;

  @ApiProperty({
    description:
      'The EIP-155 chain id as a **decimal string**. A `uint256` in the typed-data encoding, ' +
      'and never a JSON number — see `chains/ports/money.types.ts` for why nothing numeric is.',
    example: '46630',
  })
  chainId!: string;

  @ApiProperty({
    description:
      'The proxy address. It does not move across an upgrade, so a voucher signed ' +
      'before one still verifies after it.',
    example: '0x3333333333333333333333333333333333333333',
  })
  verifyingContract!: string;

  @ApiPropertyOptional({ description: 'Present only when the domain declares one' })
  salt?: string;
}

export class SolanaUnsignedTransactionDto {
  @ApiProperty({ enum: ['solana'], example: 'solana' })
  namespace!: 'solana';

  @ApiProperty({
    type: String,
    description: 'CAIP-2',
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  chainId!: ChainId;

  @ApiProperty({ enum: ['transaction'], example: 'transaction' })
  kind!: 'transaction';

  @ApiProperty({
    description:
      'Base64 of the Solana wire transaction, compiled and **unsigned** — every signature slot ' +
      'is empty. The backend never holds a buyer or provider key and never signs these.',
  })
  transactionBase64!: string;

  @ApiProperty({ description: "The signing account's own address" })
  feePayer!: string;

  @ApiProperty({ type: [String], description: 'Every address that must sign' })
  signers!: string[];

  @ApiProperty({ description: 'The blockhash the transaction is bound to' })
  blockhash!: string;

  @ApiProperty({
    description: 'Decimal string — `lastValidBlockHeight` is a `u64` and JSON has no such number',
    example: '312445678',
  })
  lastValidBlockHeight!: string;
}

export class Eip155UnsignedTransactionDto {
  @ApiProperty({ enum: ['eip155'], example: 'eip155' })
  namespace!: 'eip155';

  @ApiProperty({ type: String, description: 'CAIP-2', example: 'eip155:46630' })
  chainId!: ChainId;

  @ApiProperty({ enum: ['transaction'], example: 'transaction' })
  kind!: 'transaction';

  @ApiProperty({ example: '0x1111111111111111111111111111111111111111' })
  from!: string;

  @ApiProperty({ example: '0x2222222222222222222222222222222222222222' })
  to!: string;

  @ApiProperty({ description: '0x-hex calldata', example: '0xa9059cbb' })
  data!: string;

  @ApiProperty({ description: 'Decimal string, wei', example: '0' })
  value!: string;

  @ApiProperty({
    description:
      'The account nonce, as a decimal string. **Not a blockhash under another name** — it is ' +
      'the EVM replay counter and it does not expire.',
    example: '7',
  })
  nonce!: string;

  @ApiProperty({ description: 'Decimal string', example: '120000' })
  gasLimit!: string;

  @ApiProperty({ description: 'Decimal string, wei', example: '1500000000' })
  maxFeePerGas!: string;

  @ApiProperty({ description: 'Decimal string, wei', example: '1000000' })
  maxPriorityFeePerGas!: string;
}

export class Eip155TypedDataRequestDto {
  @ApiProperty({ enum: ['eip155'], example: 'eip155' })
  namespace!: 'eip155';

  @ApiProperty({ type: String, description: 'CAIP-2', example: 'eip155:46630' })
  chainId!: ChainId;

  @ApiProperty({
    enum: ['typed-data'],
    description:
      'EIP-712 — a **signature request**, not a send. The wallet signs and returns the ' +
      'signature; the platform relayer submits it.',
    example: 'typed-data',
  })
  kind!: 'typed-data';

  @ApiProperty({ type: Eip712DomainDto })
  domain!: Eip712DomainDto;

  @ApiProperty({
    type: 'object',
    description: 'The EIP-712 `types` map: struct name → its fields, in order.',
    additionalProperties: { type: 'array', items: { $ref: getSchemaPath(Eip712FieldDto) } },
    example: { SetLimits: [{ name: 'maxVoucherAmount', type: 'uint256' }] },
  })
  types!: Record<string, readonly Eip712FieldDto[]>;

  @ApiProperty({ example: 'SetLimits' })
  primaryType!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The struct values, keyed by field name. Every integer field is a **decimal string**, ' +
      'never a JSON number — `nonce`, `deadline` and every amount are `uint64` on chain, and ' +
      'both `eth_signTypedData_v4` and viem accept a decimal string wherever a `uintN` is ' +
      'declared. See `toUnsignedChainTransactionDto` for why the conversion happens there.',
  })
  message!: Record<string, unknown>;

  @ApiProperty({
    enum: [true],
    description:
      'Always `true`. The platform submits; the wallet only signs. Typed as the literal so it ' +
      'cannot quietly become false — a non-relayed typed-data request is not a thing that exists.',
  })
  relayed!: true;
}

/** The union, on the wire. `oneOf` of the three classes above. */
export type UnsignedChainTransactionDto =
  | SolanaUnsignedTransactionDto
  | Eip155UnsignedTransactionDto
  | Eip155TypedDataRequestDto;

/**
 * Every class the `oneOf` refers to, in `oneOf` order.
 *
 * Pass this to `@ApiExtraModels(...)` on any controller whose response carries
 * an `UnsignedChainTransactionDto`: `oneOf` emits `$ref`s, and a `$ref` to a
 * class Swagger never saw is a dangling pointer in the document.
 */
export const UNSIGNED_CHAIN_TRANSACTION_MODELS = [
  SolanaUnsignedTransactionDto,
  Eip155UnsignedTransactionDto,
  Eip155TypedDataRequestDto,
] as const;

/**
 * What `@ApiExtraModels(...)` must actually be given: the three `oneOf` members
 * **plus every class they `$ref` by hand**.
 *
 * A superset of {@link UNSIGNED_CHAIN_TRANSACTION_MODELS} and deliberately a
 * separate constant, because the two answer different questions and one of them
 * would be wrong as the other. The `oneOf` list is the union's members; this is
 * the set of classes the document must define. Mapping `oneOf` over this list
 * would tell every generated client that a bare EIP-712 *field* is a
 * transaction it may be handed.
 *
 * `Eip712FieldDto` is here and not in the `oneOf` list because
 * {@link Eip155TypedDataRequestDto.types} reaches it through a hand-written
 * `additionalProperties.items.$ref`. `@nestjs/swagger` registers a class it is
 * given as `@ApiProperty({ type: Dto })` — that is how `Eip712DomainDto` gets
 * into the document — but a `$ref` string is opaque to it, so a class reached
 * only that way is emitted nowhere and the pointer dangles. The export script
 * exits 0 either way; `test/unit/chains/unsigned-chain-transaction.dto.spec.ts`
 * is what notices.
 */
export const UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS = [
  ...UNSIGNED_CHAIN_TRANSACTION_MODELS,
  Eip712FieldDto,
] as const;

/** The `oneOf` schema fragment, for `@ApiProperty`/`@ApiPropertyOptional`. */
export function unsignedChainTransactionSchema(): { oneOf: { $ref: string }[] } {
  return {
    oneOf: UNSIGNED_CHAIN_TRANSACTION_MODELS.map((model) => ({ $ref: getSchemaPath(model) })),
  };
}

/**
 * The port's readonly value, widened to the mutable shape Swagger's DTO classes
 * declare. **The only mapper** — `provider/` and `settlement/` both call this
 * one rather than each keeping a copy.
 *
 * Written as three explicit constructions rather than a spread, deliberately.
 * A spread of a union is a union of spreads and its assignability depends on
 * every member staying structurally compatible with its DTO; naming the fields
 * makes a new field on the port a compile error here, which is where it should
 * be noticed. `signers` is copied rather than passed through: a response object
 * handing out the port's own array lets a caller mutate the answer it was given.
 */
export function toUnsignedChainTransactionDto(
  transaction: UnsignedChainTransaction,
): UnsignedChainTransactionDto {
  if (transaction.namespace === 'solana') {
    return {
      namespace: 'solana',
      chainId: transaction.chainId,
      kind: 'transaction',
      transactionBase64: transaction.transactionBase64,
      feePayer: transaction.feePayer,
      signers: [...transaction.signers],
      blockhash: transaction.blockhash,
      lastValidBlockHeight: transaction.lastValidBlockHeight,
    };
  }

  if (transaction.kind === 'transaction') {
    return {
      namespace: 'eip155',
      chainId: transaction.chainId,
      kind: 'transaction',
      from: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      nonce: transaction.nonce,
      gasLimit: transaction.gasLimit,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    };
  }

  return {
    namespace: 'eip155',
    chainId: transaction.chainId,
    kind: 'typed-data',
    domain: { ...transaction.domain },
    types: transaction.types,
    primaryType: transaction.primaryType,
    message: wireSafeTypedDataMessage(transaction.message),
    relayed: true,
  };
}

/**
 * The EIP-712 struct values, as JSON can actually carry them.
 *
 * `Eip155TypedDataRequest.message` is `Record<string, unknown>` and the builder
 * fills it with **`bigint`s** — `amount`, `nonce`, `deadline` are all `uint64`
 * on `X402Escrow`, and they stay `bigint` in the port so that viem's own
 * `hashTypedData` can take the value unchanged (which is what
 * `evm-escrow-intent-builder.spec.ts` pins them against). `JSON.stringify`
 * throws `TypeError: Do not know how to serialize a BigInt` on exactly that,
 * so before this function existed **every EVM signature request was an HTTP
 * 500**: measured on `POST /escrow/withdrawals/request-intent` against a live
 * chain, and `POST /escrow/limits-intent` is the same shape. Nothing caught it
 * — `Record<string, unknown>` accepts a `bigint`, so the compile-time
 * conformance assertions below are satisfied, and no test serialised a
 * response.
 *
 * Converted here rather than in the builder for the reason this file's header
 * gives: this is the one mapper from the port's value to the wire, and the port
 * keeps the shape its other consumers want. It is the same convention
 * `Eip712Domain.chainId` already follows — a `uint256` in the encoding, a
 * decimal string on the wire — and `money.types.ts` states the general rule
 * that nothing numeric crosses this boundary as a JSON number.
 *
 * The conversion is **flat and total** rather than recursive: every struct in
 * `eip712/` is a flat list of `address` and `uintN` fields (EIP-712 nested
 * struct types would each need their own entry in `types`, and none has one).
 * A nested value would therefore be a new struct shape, and it should arrive
 * here as a compile error in `eip712/` rather than be silently walked.
 */
function wireSafeTypedDataMessage(message: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message).map(([field, value]) => [
      field,
      typeof value === 'bigint' ? value.toString() : value,
    ]),
  );
}

// ── Conformance: each DTO class IS its port member ──────────────────────────
// Compile-time, and the whole reason two shapes are allowed to exist. A renamed
// field, a widened type or a dropped literal makes one of these `false` and
// `tsc` refuses the build.
const _solanaDtoMatchesPort: SolanaUnsignedTransactionDto extends SolanaUnsignedTransaction
  ? true
  : false = true;
const _eip155DtoMatchesPort: Eip155UnsignedTransactionDto extends Eip155UnsignedTransaction
  ? true
  : false = true;
const _typedDataDtoMatchesPort: Eip155TypedDataRequestDto extends Eip155TypedDataRequest
  ? true
  : false = true;

void _solanaDtoMatchesPort;
void _eip155DtoMatchesPort;
void _typedDataDtoMatchesPort;
