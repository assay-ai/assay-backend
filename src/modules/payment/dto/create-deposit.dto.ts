import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { CAIP_MAX_LENGTHS, CHAIN_ID_RE, ChainId } from '@modules/chains/ports/caip.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

import { DepositIntentStatus } from '../ports/deposit.types';
import {
  DepositRequirements,
  Eip155DepositRequirements,
  SolanaDepositRequirements,
} from '../ports/deposit-requirements.port';

/**
 * `POST /api/v1/deposits` — the body, and the whole body.
 *
 * Two fields, and the second one is optional. Every identity input
 * `DepositService.createDeposit` takes — `organizationId`, `agentId`,
 * `agentAccount` — comes off `@CurrentSession()`, and a request that could name
 * any of them is a request one buyer could point at another buyer's ledger
 * account. The asset is not on here either: a deposit is the chain's declared
 * settlement asset and nothing else (`domain/deposit-asset.ts`), so a
 * caller-supplied asset could only ever be right or rejected.
 *
 * `chainId` is the exception, and it is a *selection* among the buyer's own
 * linked accounts rather than a claim about identity: it can only ever choose
 * between chains this session already has an account on, and anything else is
 * refused (`domain/deposit-chain.ts`).
 */
export class CreateDepositBodyDto {
  @ApiProperty({
    description:
      "Atomic units of the chain's registered USDC, as a decimal integer string. Never a " +
      'decimal number — see `chains/ports/money.types.ts` for why money is not a `number` ' +
      'anywhere in this system. Zero is refused: an intent for nothing is a 402 round trip ' +
      'that can only end in a rejected transfer.',
    example: '5000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^[1-9][0-9]*$/, { message: 'amount must be a positive integer in atomic units' })
  readonly amount!: string;

  @ApiPropertyOptional({
    description:
      'CAIP-2. Which chain this deposit is for. **Optional while ' +
      'the buyer has one linked account and required once they have two** — parity with what ' +
      'Solana does today, where the session names the chain; `payment/domain/deposit-chain.ts` ' +
      'holds the rule. Naming a chain the buyer has no ' +
      'linked account on is refused with `PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED` (409), because a ' +
      'deposit is irreversible and there would be nobody to withdraw it.',
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CAIP_MAX_LENGTHS.chainId)
  @Matches(CHAIN_ID_RE, { message: 'chainId must be a CAIP-2 chain id' })
  readonly chainId?: string;
}

/**
 * What the browser needs to build the legacy SPL transfer, flattened.
 *
 * ## Why the blockhash is here and not on `PaymentRequirements`
 *
 * `PaymentRequirements` (`chains/ports/x402.types.ts`) is the chain-neutral
 * x402 wire vocabulary, and `DepositService.settleDeposit` **rebuilds it a
 * second time** before calling `facilitator.verify`. A blockhash carried on
 * that structure would be re-fetched at settle time and would differ from the
 * one the buyer signed against — silently, and only for transactions slow
 * enough to matter. So it rides on this transport DTO, which exists for
 * exactly one response and is never rebuilt.
 *
 * `CreateStakeIntentResponseDto.transaction` (`provider/dto/`) solves the same
 * problem the same way, for the same reason.
 */
export class SolanaDepositRequirementsDto {
  @ApiProperty({
    enum: ['solana'],
    description:
      'The discriminant. A deposit is chain-shaped end to end — `payTo` is an SPL ' +
      'associated token account, `memo` is an SPL memo, `blockhash` is a transaction lifetime ' +
      '— and on EVM none of those exist. Present now, with one value, so that adding the ' +
      'second is an append rather than a second reshape of a public response body.',
    example: 'solana',
  })
  namespace!: 'solana';

  // `ChainId`, not `string`, with an explicit `type: String` for Swagger. The
  // conformance assertion at the foot of this file and `chainId!: string`
  // cannot both compile — `DepositRequirements.chainId` is the branded type,
  // and a bare `string` is not assignable to it. The same divergence from
  // `ChainDto.chainId: string` is already carried by
  // `chains/dto/unsigned-chain-transaction.dto.ts`, for the same reason.
  @ApiProperty({
    type: String,
    description: 'CAIP-2',
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  chainId!: ChainId;

  @ApiProperty({
    description:
      "This buyer's own escrow associated token account, chain-native — an SPL token " +
      'account address, not a CAIP-10. This is the transfer destination; the backend opened the ' +
      'escrow if it did not already exist and the client must not derive its own — it was the ' +
      "pooled treasury vault's ATA before per-buyer escrows and is never that again.",
  })
  readonly payTo!: string;

  @ApiProperty({
    description:
      'The bare mint address, chain-native. Again not CAIP-19: this goes into an ' +
      'SPL transfer instruction, which knows nothing about CAIP.',
  })
  readonly asset!: string;

  @ApiProperty({
    description: 'Atomic units, as advertised in the `402` requirements.',
    example: '5000000',
  })
  readonly amount!: string;

  @ApiProperty({
    description:
      "The mint's scale, so the browser can render what it is about to sign. Display only — " +
      'the transfer instruction carries `amount` in atomic units regardless.',
    example: 6,
  })
  readonly decimals!: number;

  @ApiProperty({
    description:
      'The facilitator, which pays the gas and signs last. **The client must leave this ' +
      "signature slot empty**: the buyer signs as the transfer's owner only, which is what " +
      'makes this deposit gasless for a wallet holding no SOL.',
  })
  readonly feePayer!: string;

  @ApiProperty({
    description:
      'The memo that binds this transfer to this deposit intent, and always equal to ' +
      "`depositId`. A payload without it — or with somebody else's — is refused before it " +
      'reaches the facilitator (`ChainAdapter.assertPayloadBoundToIntent`).',
  })
  readonly memo!: string;

  @ApiProperty({
    description:
      'The recent blockhash the transaction must be built against. Fetched once, here, for ' +
      'the buyer to sign over — see the class comment for why it does not travel on the x402 ' +
      'requirements.',
  })
  readonly blockhash!: string;

  @ApiProperty({
    description:
      'The last block height at which `blockhash` is still valid. A `u64`, therefore a decimal ' +
      '**string** — JSON has no such number. `BigInt(...)` it at the call site.',
    example: '312445678',
  })
  readonly lastValidBlockHeight!: string;
}

/**
 * What the browser needs to fund an `eip155` escrow — **a contract call**.
 *
 * ## Read the field list for what is NOT here
 *
 * There is no `payTo`, no `feePayer`, no `memo` and no `blockhash`, and each
 * absence is a fact about the chain rather than a field nobody got round to:
 *
 * - **No `payTo`.** A plain ERC-20 `transfer` into `X402Escrow` moves
 *   the tokens and credits **nobody**, with no contract-level remedy. The
 *   Solana member's `payTo` *is* a send-to address, so a field of that name
 *   here carrying the escrow contract would be the single most expensive thing
 *   this response could say. {@link contract} is named for what a client must
 *   do with it.
 * - **No `feePayer`.** EVM has no fee-payer separation — gas is paid by the
 *   sender. A buyer holding no native token is served by the separate gas-grant
 *   path (`EvmGasGrantService`), not by a co-signature.
 * - **No `memo`.** `depositFor(address,uint64)` has no free field, so there is
 *   nowhere to put a deposit id. The binding this response can offer is the
 *   buyer and the amount.
 * - **No `blockhash` / `lastValidBlockHeight`.** An EVM transaction's lifetime
 *   is its nonce and gas price, both the wallet's. Nothing is fetched here and
 *   nothing expires but the intent itself.
 */
export class EvmDepositRequirementsDto {
  @ApiProperty({
    enum: ['eip155'],
    description:
      'The discriminant. Narrow on this **before reading any other field** — the two ' +
      'members of this union do not share a shape, and the Solana member carries a transfer ' +
      'destination where this one carries a contract to call.',
    example: 'eip155',
  })
  namespace!: 'eip155';

  // `ChainId`, not `string`, for the reason the Solana class above states.
  @ApiProperty({ type: String, description: 'CAIP-2', example: 'eip155:46630' })
  chainId!: ChainId;

  @ApiProperty({
    description:
      'The escrow contract to **call**, chain-native and checksummed. This is NOT a transfer ' +
      'destination: sending tokens to it with a plain ERC-20 `transfer` moves them and credits ' +
      'nobody, and there is no way to recover them afterwards.',
    example: '0x2ed26485593B512d87616a2625d2C0f7721cfF10',
  })
  readonly contract!: string;

  @ApiProperty({
    enum: ['depositFor(address,uint64)'],
    description:
      'The function to call on `contract`, as its Solidity signature. The same string the ' +
      '`402` requirements advertise in `extra.method`, which comes from one constant ' +
      '(`chains/evm/evm.constants.ts` `EVM_DEPOSIT_METHOD`) so the advertisement and the ' +
      'instruction cannot name two different functions. Spelled out rather than imported here: ' +
      'nothing under `payment/` reaches into `chains/evm/`, and the conformance assertion at ' +
      'the foot of this file is what holds the two literals equal — a drifted string stops ' +
      'being assignable to the port and `tsc` refuses the build.',
    example: 'depositFor(address,uint64)',
  })
  readonly method!: 'depositFor(address,uint64)';

  @ApiProperty({
    description:
      'The address to `approve(spender, amount)` on `asset` before calling `method`. The escrow ' +
      'contract today, and carried separately from `contract` because "who I approve" and "who ' +
      'I call" are one address by construction rather than by definition — a Permit2 path ' +
      'changes the first and not the second.',
    example: '0x2ed26485593B512d87616a2625d2C0f7721cfF10',
  })
  readonly spender!: string;

  @ApiProperty({
    description:
      "`depositFor`'s first argument: the address this deposit credits. The buyer's own, off " +
      'the session — it is on the response so a client building the call never has to derive it.',
    example: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  })
  readonly buyer!: string;

  @ApiProperty({
    description:
      'The bare ERC-20 token address, chain-native — this is the contract `approve` is called ' +
      'on. Not CAIP-19: it goes into a contract call, which knows nothing about CAIP. On ' +
      '`eip155:46630` this is USDG, not USDC.',
    example: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  })
  readonly asset!: string;

  @ApiProperty({
    description:
      "Atomic units, as advertised in the `402` requirements. `depositFor`'s second argument, " +
      'and the amount to `approve`.',
    example: '5000000',
  })
  readonly amount!: string;

  @ApiProperty({
    description:
      "The token's scale, so the browser can render what it is about to sign. Display only.",
    example: 6,
  })
  readonly decimals!: number;

  @ApiProperty({
    enum: [true],
    description:
      'Always `true`, and on the wire rather than only in a doc. A client that renders a ' +
      '"send to" address from this member has already lost the buyer their deposit; this is ' +
      'the field that says so where a UI author is looking.',
    example: true,
  })
  readonly plainTransferCreditsNobody!: true;
}

/** The union, on the wire. `oneOf` of the two classes above. */
export type DepositRequirementsDto = SolanaDepositRequirementsDto | EvmDepositRequirementsDto;

/**
 * Every class the `oneOf` refers to, in `oneOf` order.
 *
 * Pass this to `@ApiExtraModels(...)` on any controller whose response carries
 * a {@link DepositRequirementsDto}: `oneOf` emits `$ref`s, and a `$ref` to a
 * class Swagger never saw is a dangling pointer in the emitted document. The
 * export script exits 0 either way — `test/unit/payment/create-deposit.dto.spec.ts`
 * is what notices.
 */
export const DEPOSIT_REQUIREMENTS_MODELS = [
  SolanaDepositRequirementsDto,
  EvmDepositRequirementsDto,
] as const;

/**
 * `POST /api/v1/deposits` — the intent, plus everything the
 * browser needs to build the transfer against it.
 *
 * Nothing here is signed and nothing has moved. The buyer's wallet signs the
 * transaction this describes and posts it back to
 * `POST /deposits/:depositId/settle`.
 */
export class CreateDepositResponseDto {
  @ApiProperty({
    description:
      'The deposit intent. Also the memo the transfer must carry — the two are the same ' +
      'string, and `requirements.memo` repeats it so a client building the instruction never ' +
      'has to know that.',
  })
  readonly depositId!: string;

  @ApiProperty({
    description:
      'ISO-8601. Short — bounded by the blockhash above, not by a business rule. After this, ' +
      '`/settle` refuses with `PAYMENT_DEPOSIT_EXPIRED` and the fix is a fresh `POST /deposits`, ' +
      'never a resubmission of the same payload.',
  })
  readonly expiresAt!: string;

  /**
   * `oneOf`, and the client MUST narrow on `namespace` before reading anything
   * else. The two members are not variations of one shape: `payTo` on the
   * Solana member is an address to send tokens to, and the EVM member has no
   * such field **on purpose** (a plain transfer into `X402Escrow`
   * credits nobody). A fat class with both halves optional would emit a schema
   * in which a client could construct a deposit that is neither, and would put
   * a send-to field and a call-this-contract field side by side.
   */
  @ApiProperty({
    oneOf: DEPOSIT_REQUIREMENTS_MODELS.map((model) => ({ $ref: getSchemaPath(model) })),
    // Unlike `UnsignedChainTransactionDto`, which deliberately emits no
    // `discriminator` because it needs two property names to separate three
    // members, this union has exactly one discriminant and two members. So the
    // document can state it, and a generated client can narrow without
    // guessing. The mapping is explicit: OpenAPI's implicit mapping resolves a
    // value to a schema of the SAME NAME, and neither `solana` nor `eip155` is
    // a schema name here.
    discriminator: {
      propertyName: 'namespace',
      mapping: {
        solana: getSchemaPath(SolanaDepositRequirementsDto),
        eip155: getSchemaPath(EvmDepositRequirementsDto),
      },
    },
  })
  readonly requirements!: DepositRequirementsDto;
}

/**
 * `POST /api/v1/deposits/:depositId/settle` — the x402 `PaymentPayload` the
 * buyer's wallet produced.
 *
 * This is the x402 v2 wire shape verbatim (`chains/ports/x402.types.ts`), not
 * a convenience wrapper: what arrives here is handed to the facilitator
 * essentially as it stands, and inventing a second spelling of it would mean
 * translating between two vocabularies at the one point where a mistranslation
 * costs money.
 *
 * `depositId` is a path parameter and is deliberately **not** a field of this
 * body. The binding that matters is the memo inside the signed transaction,
 * which the adapter checks against the intent — a body field naming the intent
 * would be a second, unsigned claim about which deposit this pays.
 */
export class SettleDepositBodyDto {
  @ApiProperty({ description: 'x402 protocol version. `2`.', example: 2 })
  @IsInt()
  readonly x402Version!: number;

  @ApiProperty({ description: 'The x402 scheme. `exact` on SVM.', example: 'exact' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  readonly scheme!: string;

  @ApiProperty({
    description:
      'CAIP-2. Must be the chain the intent was created on; the adapter refuses a payload ' +
      'naming any other network.',
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  readonly network!: string;

  @ApiProperty({
    description:
      'Chain-specific and **opaque**: on SVM, `{ "transaction": "<base64 legacy transaction, ' +
      'partially signed>" }`. Validated as an object and no further, on purpose — only the ' +
      'adapter for `network` may look inside a payload (`chains/ports/x402.types.ts`), and a ' +
      'DTO that named `transaction` here would put the SVM wire format in the payment module.',
    type: 'object',
    additionalProperties: true,
    example: { transaction: '<base64>' },
  })
  @IsObject()
  readonly payload!: Record<string, unknown>;
}

/**
 * `POST /deposits/:depositId/broadcast` — the buyer's own wallet sent the
 * deposit, and this is its hash.
 *
 * For injected wallets (MetaMask, Rabby, …), which implement
 * `eth_sendTransaction` and not the `eth_signTransaction` that `settle` needs.
 * The hash is a pointer and nothing more: the chain is read, and only a
 * transfer crediting the intent's own buyer, for at least the requested amount,
 * credits anything.
 */
export class BroadcastDepositBodyDto {
  @ApiProperty({
    description:
      'The transaction the buyer broadcast, in the chain’s own form (on `eip155`, the `0x` ' +
      'hash of the `depositFor` transaction). Chains whose deposits need the platform as fee ' +
      'payer (Solana) refuse this route with `PAYMENT_DEPOSIT_BROADCAST_UNSUPPORTED`.',
    example: '0x839ce5d1ebdda9f060bbaba95934279073067a7babbcf2bc6e7e4981e07e368d',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  readonly transactionHash!: string;
}

/**
 * What `POST /deposits/:depositId/settle` returns: the four fields that
 * changed.
 *
 * This module's own type, and **not** `ledger/dto/list-deposits.dto.ts`'s
 * `DepositDto`, even though the two overlap. That one is the `GET /deposits`
 * list row, owned by a different Nest module for a different reason (see the
 * controller class docs); sharing a response type between them would couple two
 * surfaces whose only real relationship is a shared URL prefix.
 */
export class SettledDepositDto {
  @ApiProperty({ description: 'The deposit intent id — the same one the path named.' })
  readonly id!: string;

  @ApiProperty({
    enum: DepositIntentStatus,
    description:
      '`SETTLED` on success. A second call for an already-`SETTLED` intent returns this same ' +
      'body without touching the facilitator or the ledger again.',
  })
  readonly status!: DepositIntentStatus;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'What the chain was **observed** to move — never the requested amount. The SVM `exact` ' +
      'scheme tolerates overpayment and the difference belongs to the buyer, so this may ' +
      'exceed what was asked for. `null` until settlement is observed.',
  })
  readonly settledAmount!: MoneyDto | null;

  @ApiProperty({
    nullable: true,
    description: 'The settlement transaction signature, once known.',
  })
  readonly chainTxRef!: string | null;
}

// Compile-time: each DTO IS its port member, so the controller can return the
// builder's answer directly and no hand-written mapper can drift from it. Two
// assertions rather than one against the union: `X extends DepositRequirements`
// is satisfied by a class that matches EITHER member, so a single assertion
// would pass while the EVM DTO quietly described a Solana response.
const _solanaDepositRequirementsDtoMatchesPort: SolanaDepositRequirementsDto extends SolanaDepositRequirements
  ? true
  : false = true;
void _solanaDepositRequirementsDtoMatchesPort;

const _evmDepositRequirementsDtoMatchesPort: EvmDepositRequirementsDto extends Eip155DepositRequirements
  ? true
  : false = true;
void _evmDepositRequirementsDtoMatchesPort;

// And the union on the wire is the union in the port — neither wider nor
// narrower. `DepositRequirementsDto extends DepositRequirements` alone would
// permit the DTO union to be missing a member entirely.
const _depositRequirementsUnionMatchesPort: DepositRequirements extends DepositRequirementsDto
  ? DepositRequirementsDto extends DepositRequirements
    ? true
    : false
  : false = true;
void _depositRequirementsUnionMatchesPort;
