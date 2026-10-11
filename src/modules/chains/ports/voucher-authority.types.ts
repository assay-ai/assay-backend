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
 *             `validUntil` — and whose own caps the caller must still apply;
 *   ERC1271   when the payer has code, its `isValidSignature(digest, sig)`
 *             answering `0x1626ba7e`.
 */
export enum VoucherAuthorityKind {
  PAYER = 'PAYER',
  DELEGATE = 'DELEGATE',
  ERC1271 = 'ERC1271',
}

/** Why nothing authorised the voucher. The most specific true reason. */
export enum VoucherAuthorityRefusal {
  /** Nobody the payer authorised signed it (the contract's `SignerIsNotPayer`). */
  NOT_PAYER = 'NOT_PAYER',
  /** A delegate the payer revoked signed it (`DelegateIsRevoked`). */
  DELEGATE_REVOKED = 'DELEGATE_REVOKED',
  /** A delegate past its `validUntil` signed it (`DelegateIsExpired`). */
  DELEGATE_EXPIRED = 'DELEGATE_EXPIRED',
  /**
   * The payer has code (a contract wallet or an EIP-7702 account) and only its
   * EIP-1271 wallet could have authorised this voucher, but the caller asked
   * for that path to be left out (`allowErc1271: false`). The chain would ask
   * the wallet; a SERVING decision cannot rely on its answer — see
   * `VoucherService`.
   */
  ERC1271_NOT_ACCEPTED = 'ERC1271_NOT_ACCEPTED',
}

/** How the caller wants the rule applied. */
export interface VoucherAuthorityOptions {
  /**
   * Whether path (c), the payer's EIP-1271 wallet, may authorise the voucher.
   * Default `true` (it is the chain's rule). Serving a call refuses it.
   */
  readonly allowErc1271?: boolean;
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
  | { readonly kind: VoucherAuthorityKind.PAYER | VoucherAuthorityKind.ERC1271 }
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
