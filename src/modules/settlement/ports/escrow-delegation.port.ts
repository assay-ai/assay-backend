import { AccountId } from '@modules/chains/ports/caip.types';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';

/**
 * Agent payment delegation, as settlement sees it: a payer authorises a
 * DELEGATE key — held by its headless agent — to sign rail-B vouchers on the
 * payer's escrow within caps and until `validUntil`, and revokes it. Both are
 * EIP-712 messages the payer signs once and the platform's relayer submits
 * (`authorizeDelegateBySig` / `revokeDelegateBySig`), exactly like the escrow
 * limits.
 *
 * EVM only: the Solana escrow has no delegation, and the multiplexer refuses a
 * Solana account `CHAIN_UNSUPPORTED`.
 */
export enum EscrowDelegationKind {
  AUTHORIZE_DELEGATE = 'AUTHORIZE_DELEGATE',
  REVOKE_DELEGATE = 'REVOKE_DELEGATE',
}

export interface DelegationTerms {
  /** CAIP-10, on the payer's chain. */
  readonly delegate: AccountId;
  /** Atomic units. At most the escrow's own `maxVoucherAmount`. */
  readonly maxVoucherAmount: bigint;
  /** Atomic units. At most the escrow's own `maxPerWindow`. */
  readonly maxPerWindow: bigint;
  /** Unix seconds. */
  readonly validUntil: bigint;
}

export enum EscrowDelegationStatus {
  ACTIVE = 'ACTIVE',
  /** Past `validUntil` and not yet revoked; it still holds a place on chain. */
  EXPIRED = 'EXPIRED',
}

/** One standing delegation, read from the chain. */
export interface EscrowDelegation {
  readonly delegate: AccountId;
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  /** The delegate's own window counter, decayed to the read's instant. */
  readonly spentInWindow: bigint;
  /** Unix seconds. */
  readonly validUntil: bigint;
  readonly status: EscrowDelegationStatus;
}

export interface EscrowDelegationPort {
  /** The `AuthorizeDelegate` typed data the payer signs, at the escrow's `authNonce`. */
  authorizeIntent(account: AccountId, terms: DelegationTerms): Promise<UnsignedChainTransaction>;
  /** The `RevokeDelegate` typed data the payer signs, at the escrow's `authNonce`. */
  revokeIntent(account: AccountId, delegate: AccountId): Promise<UnsignedChainTransaction>;
  /** The payer's standing delegations, from the chain (`delegatesOf` + `delegationOf`). */
  list(account: AccountId): Promise<readonly EscrowDelegation[]>;
}

export const ESCROW_DELEGATION = 'ESCROW_DELEGATION';
