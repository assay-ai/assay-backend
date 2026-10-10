import { hashTypedData, TypedDataDomain } from 'viem';

/**
 * `SlashAttestation` — the verifier's judgement, in assay-evm's `src/Types.sol`
 * field order. Signed under the **X402Stake** domain (`evmDomain(chainId,
 * stakeProxy)`), never the escrow's: two verifying contracts is what keeps a
 * captured attestation from being replayed at the other door.
 */
export interface EvmSlashAttestation {
  readonly requestId: `0x${string}`;
  readonly provider: `0x${string}`;
  readonly beneficiary: `0x${string}`;
  /** `ResponseClass` as a raw `uint8`. Only `DataFail` (3) may slash. */
  readonly status: number;
  readonly penalty: bigint;
  readonly policy: `0x${string}`;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

/** `ResponseClass.DataFail` — `Types.sol`, pinned by `test/Types.t.sol` there. */
export const EVM_RESPONSE_CLASS_DATA_FAIL = 3;

/** Field order is the typehash — see the note in `voucher.ts`. */
export const SLASH_ATTESTATION_TYPES = {
  SlashAttestation: [
    { name: 'requestId', type: 'bytes32' },
    { name: 'provider', type: 'address' },
    { name: 'beneficiary', type: 'address' },
    { name: 'status', type: 'uint8' },
    { name: 'penalty', type: 'uint64' },
    { name: 'policy', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function slashAttestationTypedData(
  attestation: EvmSlashAttestation,
  domain: TypedDataDomain,
) {
  return {
    domain,
    types: SLASH_ATTESTATION_TYPES,
    primaryType: 'SlashAttestation' as const,
    message: attestation,
  };
}

/** The 32-byte digest the verifier key signs and `Sig.recover` recovers from. */
export function hashSlashAttestation(
  attestation: EvmSlashAttestation,
  domain: TypedDataDomain,
): `0x${string}` {
  return hashTypedData(slashAttestationTypedData(attestation, domain));
}
