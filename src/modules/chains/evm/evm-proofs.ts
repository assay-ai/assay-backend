import { hashTypedData, TypedDataDomain } from 'viem';

import { PayoutProofChallenge } from '../ports/payout-proof.types';
import { StakeAuthorityChallenge } from '../ports/stake-authority.types';

/**
 * Two proofs whose FIELDS are identical and whose meanings are not.
 *
 * A payout proof names where the signer's own earnings go. A stake-authority
 * proof attaches collateral that a router gate reads and a slash attestation
 * points at. Reusing one encoder would mean a signature collected for the
 * harmless claim satisfies the dangerous one, and the loss lands on whoever
 * actually owns the stake account.
 *
 * On EVM the separation is the EIP-712 **primary type**, which is inside the
 * hashed preimage — strictly stronger than Solana's distinct leading version
 * tags, because there is no length or prefix a caller could arrange to collide.
 * It is doubled by the domain: a payout proof is signed against the escrow
 * contract and a stake-authority proof against the stake contract, so the two
 * differ in `verifyingContract` as well as in `primaryType`. The adapter
 * conformance suite is the mechanical check.
 *
 * ## Neither type is on chain, deliberately
 *
 * `X402Escrow` and `X402Stake` verify vouchers and the two `*BySig` doors and
 * nothing else. These two structs are proofs of key control that authorise no
 * movement of value, so they have no on-chain verifier to agree with — which is
 * why they may be defined here rather than copied out of `Types.sol`. What they
 * MUST NOT do is collide with anything that does move value, and a distinct
 * `primaryType` is what makes that impossible rather than merely unlikely.
 */
export const PAYOUT_PROOF_TYPES = {
  PayoutProof: [
    { name: 'account', type: 'address' },
    { name: 'organizationId', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export const STAKE_AUTHORITY_TYPES = {
  StakeAuthorityProof: [
    { name: 'account', type: 'address' },
    { name: 'organizationId', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export interface ProofMessage {
  readonly account: `0x${string}`;
  readonly organizationId: string;
  readonly nonce: string;
  readonly expiresAt: bigint;
}

export function payoutProofTypedData(message: ProofMessage, domain: TypedDataDomain) {
  return { domain, types: PAYOUT_PROOF_TYPES, primaryType: 'PayoutProof' as const, message };
}

export function stakeAuthorityTypedData(message: ProofMessage, domain: TypedDataDomain) {
  return {
    domain,
    types: STAKE_AUTHORITY_TYPES,
    primaryType: 'StakeAuthorityProof' as const,
    message,
  };
}

export const hashPayoutProof = (m: ProofMessage, d: TypedDataDomain): `0x${string}` =>
  hashTypedData(payoutProofTypedData(m, d));

export const hashStakeAuthority = (m: ProofMessage, d: TypedDataDomain): `0x${string}` =>
  hashTypedData(stakeAuthorityTypedData(m, d));

/**
 * The port's challenge types carry a CAIP-10 and a `number`; the wire wants an
 * address and a `uint64`.
 *
 * `address` is passed in rather than parsed out of `challenge.account` so that
 * the caller — which already had to decide whether it serves that chain — is
 * the one that resolves it. A second parse here would be a second place the
 * CAIP-10 could be read differently.
 */
export function toProofMessage(
  challenge: PayoutProofChallenge | StakeAuthorityChallenge,
  address: `0x${string}`,
): ProofMessage {
  return {
    account: address,
    organizationId: challenge.organizationId,
    nonce: challenge.nonce,
    expiresAt: BigInt(challenge.expiresAt),
  };
}
