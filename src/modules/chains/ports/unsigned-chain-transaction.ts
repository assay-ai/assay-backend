import { ChainId } from './caip.types';

/**
 * The one shape a wallet is handed anywhere on this platform's public HTTP
 * surface, and the one place it is declared.
 *
 * ## Why a union and not a flat object
 *
 * Before this type there were three DTOs — `UnsignedStakeTransactionDto`,
 * `UnsignedEscrowTransactionDto` and `DepositRequirementsDto` (now
 * `SolanaDepositRequirementsDto`) — each carrying
 * `transactionBase64`, `feePayer`, `signers`, `blockhash` and
 * `lastValidBlockHeight` as though those were properties of "a transaction".
 * They are properties of a *Solana* transaction. The spec's warning is exact:
 * **`blockhash` and `nonce` are not the same thing wearing different names.**
 * A blockhash is SVM's replay protection and its transaction lifetime in one
 * field; the EVM equivalent is an account nonce plus a gas ceiling plus a fee
 * bid, fetched differently and consumed differently. A flat shape carrying
 * both would be a shape where half the fields are null on every response, and
 * the first client to read the wrong half sends a transaction that cannot land.
 *
 * ## Why THREE members, not two
 *
 * The third is the one a survey of the code misses, and it is not optional.
 * On EVM several buyer-facing "transactions" are not transactions at
 * all: `setLimitsBySig` and `requestWithdrawBySig` are EIP-712 **signature
 * requests** that the platform's relayer submits. A union with only a
 * transaction member would force a frontend to fabricate a transaction it must
 * not send — which is precisely how a chain abstraction rots.
 *
 * ## Why `kind` is a separate discriminant from `namespace`
 *
 * So that a future Solana off-chain signature request slots in as a fourth
 * member without reshaping the union, and so that narrowing on `namespace`
 * alone is never sufficient — because it is not: two of the three members are
 * `eip155`.
 */

/** EIP-712 `domain`, as it travels on the wire. */
export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  /**
   * The EIP-155 chain id — a **decimal string**, not a number.
   *
   * It is a `uint256` in the typed-data encoding, and money is never a
   * `number` here for the same reason nothing else is: `JSON.stringify` throws
   * on a `bigint`, and a `number` silently loses precision above 2^53.
   */
  readonly chainId: string;
  /** The proxy address — it does not move across an upgrade, and vouchers signed before one still verify after it. */
  readonly verifyingContract: string;
  /** Optional per EIP-712; present only when a domain actually declares one. */
  readonly salt?: string;
}

/** One field of one EIP-712 struct: `{ name, type }`, as the standard spells it. */
export interface Eip712Field {
  readonly name: string;
  readonly type: string;
}

export type UnsignedChainTransaction =
  | {
      readonly namespace: 'solana';
      readonly chainId: ChainId;
      readonly kind: 'transaction';
      /** Base64 of the compiled wire transaction, **unsigned** — every signature slot empty. */
      readonly transactionBase64: string;
      readonly feePayer: string;
      /** Every address that must sign. */
      readonly signers: readonly string[];
      readonly blockhash: string;
      /** Decimal string, `u64`. */
      readonly lastValidBlockHeight: string;
    }
  | {
      readonly namespace: 'eip155';
      readonly chainId: ChainId;
      readonly kind: 'transaction';
      readonly from: string;
      readonly to: string;
      /** 0x-hex calldata. */
      readonly data: string;
      /** Decimal string, wei. */
      readonly value: string;
      /** Decimal string. The account nonce — NOT a blockhash under another name. */
      readonly nonce: string;
      readonly gasLimit: string;
      readonly maxFeePerGas: string;
      readonly maxPriorityFeePerGas: string;
    }
  | {
      readonly namespace: 'eip155';
      readonly chainId: ChainId;
      /** EIP-712 — a SIGNATURE request, not a send. */
      readonly kind: 'typed-data';
      readonly domain: Eip712Domain;
      readonly types: Record<string, readonly Eip712Field[]>;
      readonly primaryType: string;
      readonly message: Record<string, unknown>;
      /**
       * The platform submits; the wallet only signs.
       *
       * Typed as the literal `true` rather than `boolean` so that it cannot
       * quietly become false — a `relayed: false` typed-data member would be a
       * signature the wallet is expected to broadcast itself, which is not a
       * thing that exists.
       */
      readonly relayed: true;
    };

export type SolanaUnsignedTransaction = Extract<UnsignedChainTransaction, { namespace: 'solana' }>;

export type Eip155UnsignedTransaction = Extract<
  UnsignedChainTransaction,
  { namespace: 'eip155'; kind: 'transaction' }
>;

export type Eip155TypedDataRequest = Extract<UnsignedChainTransaction, { kind: 'typed-data' }>;

/**
 * Narrow to the Solana member.
 *
 * Reads `namespace` alone, which is sufficient **in this direction only**:
 * `solana` has one member today. Narrowing to EVM requires `kind` as well, and
 * a caller that reaches for a mirror-image `isEip155Transaction` should write
 * `t.namespace === 'eip155' && t.kind === 'transaction'` and see the second
 * condition it is agreeing to.
 */
export function isSolanaTransaction(
  transaction: UnsignedChainTransaction,
): transaction is SolanaUnsignedTransaction {
  return transaction.namespace === 'solana';
}
