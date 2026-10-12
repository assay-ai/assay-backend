import { AccountId } from './caip.types';

/**
 * Who authorised a rail-B voucher, as the CHAIN's own rule decides it — the
 * off-chain mirror of `X402Escrow._voucherAuthority` (assay-evm), which x402
 * facilitators apply the same way: verify off chain exactly what the contract
 * will verify on chain.
 *
 * The rule, in order:
 *
 *   PAYER     an ECDSA signature by the voucher's `payer` itself;
 *   DELEGATE  an ECDSA signature by a key the payer authorised ON CHAIN
 *             (`authorizeDelegate[BySig]`), not revoked, not past
 *             `validUntil` — and whose own caps the caller must still apply.
 *
 * Nothing else. The contract has no EIP-1271 branch (assay-evm D-18): a
 * contract-wallet payer authorises a delegate and lets the delegate sign.
 */
export enum VoucherAuthorityKind {
  PAYER = 'PAYER',
  DELEGATE = 'DELEGATE',
}

/** Why nothing authorised the voucher. The most specific true reason. */
export enum VoucherAuthorityRefusal {
  /** Nobody the payer authorised signed it (the contract's `SignerIsNotPayer`). */
  NOT_PAYER = 'NOT_PAYER',
  /** A delegate the payer revoked signed it (`DelegateIsRevoked`). */
  DELEGATE_REVOKED = 'DELEGATE_REVOKED',
  /** A delegate past its `validUntil` signed it (`DelegateIsExpired`). */
  DELEGATE_EXPIRED = 'DELEGATE_EXPIRED',
}

/**
 * A delegate's on-chain grant, read for this decision. `carriedInWindow` is the
 * delegate's own rolling-window counter ALREADY DECAYED to the decision's
 * instant by the contract's `Window.decay` — what is left for the caller to add
 * is what has not reached the chain yet.
 */
export interface VoucherDelegationTerms {
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly carriedInWindow: bigint;
  /** Unix seconds. */
  readonly validUntil: number;
  /**
   * How long after a voucher's `expiresAt` the chain still redeems it — and
   * checks `validUntil` at THAT block. A delegation that lapses inside this
   * grace is refused at redemption, after the call was served.
   */
  readonly redeemGraceSeconds: number;
}

export type VoucherAuthority =
  | { readonly kind: VoucherAuthorityKind.PAYER }
  | {
      readonly kind: VoucherAuthorityKind.DELEGATE;
      readonly delegate: AccountId;
      readonly terms: VoucherDelegationTerms;
    };

export type VoucherAuthorityAnswer =
  | VoucherAuthority
  | {
      readonly kind: 'REFUSED';
      readonly reason: VoucherAuthorityRefusal;
      /** The recovered ECDSA signer, when there was one. */
      readonly signer: AccountId | null;
    };
