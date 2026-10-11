import { hashTypedData, TypedDataDomain } from 'viem';

/**
 * The two voucher-DELEGATION messages of `X402Escrow` (assay-evm
 * `src/Types.sol`, `AuthorizeDelegate` and `RevokeDelegate`).
 *
 * A payer whose own key cannot leave its wallet (a Privy embedded wallet) signs
 * an `AuthorizeDelegate` once, the platform relays it through
 * `authorizeDelegateBySig`, and from then on a DELEGATE key — held by the
 * payer's headless agent — may sign vouchers on the payer's escrow within the
 * caps and until `validUntil`. The delegate can sign vouchers and nothing else.
 *
 * `nonce` is the escrow's shared `authNonce`, exactly as for `SetLimits` and
 * `RequestWithdraw` (see `escrow-control.ts`): any payer decision consumes it,
 * so a relayed authorisation can never land after a later revocation.
 *
 * Field ORDER is the typehash. `eip712-delegation.spec.ts` renders these lists
 * back into the Solidity preimage strings and pins the digests against `cast`.
 */
export interface AuthorizeDelegateMessage {
  readonly payer: `0x${string}`;
  readonly delegate: `0x${string}`;
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly validUntil: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface RevokeDelegateMessage {
  readonly payer: `0x${string}`;
  readonly delegate: `0x${string}`;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export const AUTHORIZE_DELEGATE_TYPES = {
  AuthorizeDelegate: [
    { name: 'payer', type: 'address' },
    { name: 'delegate', type: 'address' },
    { name: 'maxVoucherAmount', type: 'uint64' },
    { name: 'maxPerWindow', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const REVOKE_DELEGATE_TYPES = {
  RevokeDelegate: [
    { name: 'payer', type: 'address' },
    { name: 'delegate', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export function authorizeDelegateTypedData(
  message: AuthorizeDelegateMessage,
  domain: TypedDataDomain,
) {
  return {
    domain,
    types: AUTHORIZE_DELEGATE_TYPES,
    primaryType: 'AuthorizeDelegate' as const,
    message,
  };
}

export function revokeDelegateTypedData(message: RevokeDelegateMessage, domain: TypedDataDomain) {
  return {
    domain,
    types: REVOKE_DELEGATE_TYPES,
    primaryType: 'RevokeDelegate' as const,
    message,
  };
}

export const hashAuthorizeDelegate = (
  m: AuthorizeDelegateMessage,
  d: TypedDataDomain,
): `0x${string}` => hashTypedData(authorizeDelegateTypedData(m, d));

export const hashRevokeDelegate = (m: RevokeDelegateMessage, d: TypedDataDomain): `0x${string}` =>
  hashTypedData(revokeDelegateTypedData(m, d));
