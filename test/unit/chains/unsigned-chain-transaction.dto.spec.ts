import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import {
  UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS,
  UNSIGNED_CHAIN_TRANSACTION_MODELS,
  toUnsignedChainTransactionDto,
  unsignedChainTransactionSchema,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';
import {
  Eip155TypedDataRequest,
  Eip155UnsignedTransaction,
  SolanaUnsignedTransaction,
} from '@modules/chains/ports/unsigned-chain-transaction';

const EIP155: ChainId = 'eip155:46630' as ChainId;

const SOLANA_TX: SolanaUnsignedTransaction = {
  namespace: 'solana',
  chainId: CHAIN_IDS.SOLANA_DEVNET,
  kind: 'transaction',
  transactionBase64: 'ZmFrZQ==',
  feePayer: 'BuyerAccount111111111111111111111111111111',
  signers: ['BuyerAccount111111111111111111111111111111'],
  blockhash: 'FakeBlockhash1111111111111111111111111111',
  lastValidBlockHeight: '312445678',
};

const EVM_TX: Eip155UnsignedTransaction = {
  namespace: 'eip155',
  chainId: EIP155,
  kind: 'transaction',
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  data: '0xa9059cbb',
  value: '0',
  nonce: '7',
  gasLimit: '120000',
  maxFeePerGas: '1500000000',
  maxPriorityFeePerGas: '1000000',
};

const TYPED_DATA: Eip155TypedDataRequest = {
  namespace: 'eip155',
  chainId: EIP155,
  kind: 'typed-data',
  domain: {
    name: 'AssayEscrow',
    version: '1',
    chainId: '46630',
    verifyingContract: '0x3333333333333333333333333333333333333333',
  },
  types: { SetLimits: [{ name: 'maxVoucherAmount', type: 'uint256' }] },
  primaryType: 'SetLimits',
  message: { maxVoucherAmount: '100000000' },
  relayed: true,
};

describe('unsignedChainTransactionSchema', () => {
  it('emits a three-way oneOf naming the three DTO classes', () => {
    // Literal refs, not `getSchemaPath(...)` recomputed here: an expectation
    // derived from the same expression the code uses is indistinguishable from
    // a hardcoded literal that happens to match.
    expect(unsignedChainTransactionSchema()).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/SolanaUnsignedTransactionDto' },
        { $ref: '#/components/schemas/Eip155UnsignedTransactionDto' },
        { $ref: '#/components/schemas/Eip155TypedDataRequestDto' },
      ],
    });
  });

  it('carries no `discriminator`, because OpenAPI names only one property', () => {
    // `namespace` alone does not separate the two eip155 members, and OpenAPI's
    // `discriminator` takes exactly one `propertyName`. Emitting one anyway
    // would make a generated client pick between the EVM transaction and the
    // typed-data request by coin flip.
    expect(unsignedChainTransactionSchema()).not.toHaveProperty('discriminator');
  });

  it('registers exactly the three models', () => {
    expect(UNSIGNED_CHAIN_TRANSACTION_MODELS.map((m) => m.name)).toEqual([
      'SolanaUnsignedTransactionDto',
      'Eip155UnsignedTransactionDto',
      'Eip155TypedDataRequestDto',
    ]);
  });
});

describe('toUnsignedChainTransactionDto', () => {
  it('maps the solana member field for field', () => {
    expect(toUnsignedChainTransactionDto(SOLANA_TX)).toEqual({
      namespace: 'solana',
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      kind: 'transaction',
      transactionBase64: 'ZmFrZQ==',
      feePayer: 'BuyerAccount111111111111111111111111111111',
      signers: ['BuyerAccount111111111111111111111111111111'],
      blockhash: 'FakeBlockhash1111111111111111111111111111',
      lastValidBlockHeight: '312445678',
    });
  });

  it('copies the port’s `chainId` rather than naming a chain of its own', () => {
    // The degenerate mapper this kills: `chainId: CHAIN_IDS.SOLANA_DEVNET`
    // hardcoded in the solana branch. Every other fixture in this repository is
    // devnet, so that version passes the whole suite — including the two intent
    // surfaces — and only a member on a DIFFERENT solana chain can tell the
    // two apart. The literal is written out, not recomputed from CHAIN_IDS.
    const onMainnet: SolanaUnsignedTransaction = {
      ...SOLANA_TX,
      chainId: CHAIN_IDS.SOLANA_MAINNET,
    };

    const dto = toUnsignedChainTransactionDto(onMainnet);

    expect(dto.chainId).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    // And the loser: the devnet fixture it was copied from is untouched, so
    // this is not one object read twice.
    expect(toUnsignedChainTransactionDto(SOLANA_TX).chainId).toBe(
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    );
  });

  it('copies `signers` rather than handing out the port’s own array', () => {
    const dto = toUnsignedChainTransactionDto(SOLANA_TX);
    if (dto.namespace !== 'solana' || dto.kind !== 'transaction') throw new Error('wrong member');
    dto.signers.push('Intruder1111111111111111111111111111111111');
    // The port's value is unchanged: a response object handing out the port's
    // own array lets a caller mutate the answer it was given.
    expect(SOLANA_TX.signers).toEqual(['BuyerAccount111111111111111111111111111111']);
  });

  it('maps the eip155 transaction member and adds no solana field', () => {
    const dto = toUnsignedChainTransactionDto(EVM_TX);
    expect(dto).toEqual(EVM_TX);
    // The loser, asserted: the solana branch must not have run. `blockhash`
    // and `lastValidBlockHeight` are absent, not undefined.
    expect(Object.keys(dto)).not.toContain('blockhash');
    expect(Object.keys(dto)).not.toContain('lastValidBlockHeight');
    expect(Object.keys(dto)).not.toContain('signers');
  });

  it('maps the typed-data member and adds no transaction field', () => {
    const dto = toUnsignedChainTransactionDto(TYPED_DATA);
    expect(dto).toEqual(TYPED_DATA);
    expect(Object.keys(dto)).not.toContain('transactionBase64');
    expect(Object.keys(dto)).not.toContain('nonce');
    expect(Object.keys(dto)).not.toContain('gasLimit');
  });

  it('renders a typed-data message the way the BUILDER fills it — bigints', () => {
    // `TYPED_DATA` above carries a decimal STRING, which is what the wire is
    // supposed to look like — and it is why this file passed while every EVM
    // signature request 500ed. `EvmEscrowIntentBuilder` puts `bigint`s in
    // `message` (`amount`, `nonce`, `deadline` are `uint64` on chain, and the
    // port keeps them that way so viem's `hashTypedData` takes the value
    // unchanged), and `JSON.stringify` throws on a `bigint`.
    //
    // So the input here is the builder's shape, and the assertion is the one
    // that actually failed in production: the response serialises.
    const fromBuilder: Eip155TypedDataRequest = {
      ...TYPED_DATA,
      types: {
        RequestWithdraw: [
          { name: 'buyer', type: 'address' },
          { name: 'amount', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
          { name: 'deadline', type: 'uint64' },
        ],
      },
      primaryType: 'RequestWithdraw',
      message: {
        buyer: '0x1111111111111111111111111111111111111111',
        amount: 100_000_000n,
        nonce: 4n,
        deadline: 1_789_055_000n,
      },
    };

    const dto = toUnsignedChainTransactionDto(fromBuilder);

    expect(() => JSON.stringify(dto)).not.toThrow();
    expect(dto).toMatchObject({
      message: {
        // The address is untouched; the three uint64s are decimal strings.
        buyer: '0x1111111111111111111111111111111111111111',
        amount: '100000000',
        nonce: '4',
        deadline: '1789055000',
      },
    });
    // Non-vacuity: the input really did carry bigints, so the assertion above
    // is about the mapper and not about a fixture that was already strings.
    expect(typeof fromBuilder.message.nonce).toBe('bigint');
    expect(() => JSON.stringify(fromBuilder)).toThrow(TypeError);
  });
});

/**
 * Every `$ref` these classes emit must name a class Swagger was told about.
 *
 * `oneOf` is not the only place a `$ref` appears. `Eip155TypedDataRequestDto.types`
 * is a free-form map whose values are arrays of `Eip712FieldDto`, and the only
 * way to say that in OpenAPI is a hand-written
 * `additionalProperties.items.$ref` — which `@nestjs/swagger` does **not**
 * treat as a registration the way it treats `@ApiProperty({ type: SomeDto })`.
 * A class reached only that way is never emitted under `components.schemas`,
 * and the document ships with a pointer to nothing: every generated client
 * fails to compile, and the OpenAPI export itself stays exit-0 and silent.
 *
 * This is not hypothetical — it is exactly what the first export of this branch
 * produced. The guard is here rather than in the export script because the
 * export needs a booted application and this needs nothing.
 */
describe('the ApiExtraModels list covers every $ref these DTOs emit', () => {
  /** Every `#/components/schemas/X` name reachable from a class's own `@ApiProperty`s. */
  function refsEmittedBy(model: new () => object): string[] {
    const proto = model.prototype as object;
    const properties: string[] =
      (Reflect.getMetadata('swagger/apiModelPropertiesArray', proto) as string[]) ?? [];

    return properties.flatMap((property) => {
      const options: unknown = Reflect.getMetadata(
        'swagger/apiModelProperties',
        proto,
        property.replace(/^:/, ''),
      );
      // `JSON.stringify` drops the constructor functions that
      // `@ApiProperty({ type: SomeDto })` stores, which is what we want: those
      // ARE auto-registered. What survives is the hand-written `$ref` strings,
      // which are not.
      return [...JSON.stringify(options ?? {}).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)]
        .map((match) => match[1])
        .filter((name) => name !== model.name);
    });
  }

  const emitted = [
    ...new Set(UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS.flatMap(refsEmittedBy)),
  ].sort();

  /**
   * The non-vacuity anchor, and it must stay a literal.
   *
   * A scan that finds nothing reports no dangling reference either, so the
   * assertion below would pass against a metadata key that has been renamed,
   * against `Reflect` returning `undefined`, and against a `types` property
   * that has quietly stopped emitting a `$ref` at all. Naming the one hand-written
   * reference this file contains is what makes the next assertion mean something.
   */
  it('finds the one hand-written $ref these DTOs contain', () => {
    expect(emitted).toEqual(['Eip712FieldDto']);
  });

  it('registers every class those $refs name', () => {
    const registered = UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS.map((model) => model.name);
    expect(emitted.filter((name) => !registered.includes(name))).toEqual([]);
  });

  /**
   * The `oneOf` list stays three long. The extra-models list is a superset and
   * must never be the thing `unsignedChainTransactionSchema` maps over — a
   * fourth `oneOf` member would tell every client that a bare EIP-712 *field*
   * is a transaction it may be handed.
   */
  it('keeps the oneOf list separate from the registration list', () => {
    expect(UNSIGNED_CHAIN_TRANSACTION_MODELS.map((model) => model.name)).toEqual([
      'SolanaUnsignedTransactionDto',
      'Eip155UnsignedTransactionDto',
      'Eip155TypedDataRequestDto',
    ]);
    expect(UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS.map((model) => model.name)).toEqual([
      'SolanaUnsignedTransactionDto',
      'Eip155UnsignedTransactionDto',
      'Eip155TypedDataRequestDto',
      'Eip712FieldDto',
    ]);
  });
});
