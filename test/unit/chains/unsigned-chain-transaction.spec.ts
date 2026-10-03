import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import {
  Eip155TypedDataRequest,
  Eip155UnsignedTransaction,
  SolanaUnsignedTransaction,
  UnsignedChainTransaction,
  isSolanaTransaction,
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
    name: 'X402Escrow',
    version: '1',
    chainId: '46630',
    verifyingContract: '0x3333333333333333333333333333333333333333',
  },
  types: { SetLimits: [{ name: 'maxVoucherAmount', type: 'uint256' }] },
  primaryType: 'SetLimits',
  message: { maxVoucherAmount: '100000000' },
  relayed: true,
};

describe('UnsignedChainTransaction', () => {
  it('has three members and `kind` separates the two eip155 ones', () => {
    // `namespace` alone does not discriminate — that is the whole reason `kind`
    // exists as a second discriminant. Asserting only that the solana
    // member is found would pass on a two-member union.
    const all: readonly UnsignedChainTransaction[] = [SOLANA_TX, EVM_TX, TYPED_DATA];
    expect(all.map((t) => `${t.namespace}/${t.kind}`)).toEqual([
      'solana/transaction',
      'eip155/transaction',
      'eip155/typed-data',
    ]);
  });

  it('narrows to the solana member, and refuses both eip155 members', () => {
    // The loser is asserted, not just the winner. A predicate that returned
    // `true` unconditionally would pass the first line alone.
    expect(isSolanaTransaction(SOLANA_TX)).toBe(true);
    expect(isSolanaTransaction(EVM_TX)).toBe(false);
    expect(isSolanaTransaction(TYPED_DATA)).toBe(false);
  });

  it('a typed-data request is a SIGNATURE request and says so', () => {
    // A union with only a transaction member would force the frontend to
    // fabricate a transaction it must not send. `relayed` is typed as the
    // literal `true` so it cannot quietly become optional.
    expect(TYPED_DATA.relayed).toBe(true);
    expect(TYPED_DATA.kind).toBe('typed-data');
  });

  // ── The no-flat-shape guards ───────────────────────────────────────────
  //
  // These are COMPILE-TIME assertions and they are real tests: ts-jest
  // type-checks this file, and `@ts-expect-error` on a line that does NOT
  // error is itself TS2578. So each one fails the suite in both directions.

  it('`blockhash` is not a field of the eip155 transaction member', () => {
    // @ts-expect-error — blockhash is SVM replay protection; the EVM member has
    // `nonce` and a fee, and one flat shape carrying both is forbidden.
    const bad: Eip155UnsignedTransaction = { ...EVM_TX, blockhash: 'nope' };
    expect(bad.namespace).toBe('eip155');
  });

  it('`nonce` is not a field of the solana member', () => {
    // @ts-expect-error — "blockhash and nonce are not the same thing wearing
    // different names".
    const bad: SolanaUnsignedTransaction = { ...SOLANA_TX, nonce: '7' };
    expect(bad.namespace).toBe('solana');
  });

  it('the solana and eip155 members share exactly the three discriminant keys', () => {
    // The structural half. The two `@ts-expect-error`s above name two fields;
    // this one refuses ANY fourth shared key, including one nobody has thought
    // of yet — which is what stops the union collapsing back into a flat shape
    // one field at a time.
    type Shared = Extract<keyof SolanaUnsignedTransaction, keyof Eip155UnsignedTransaction>;
    type Unexpected = Exclude<Shared, 'namespace' | 'chainId' | 'kind'>;
    const noUnexpectedSharedKey: [Unexpected] extends [never] ? true : false = true;
    expect(noUnexpectedSharedKey).toBe(true);
  });
});
