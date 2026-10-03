import { hashTypedData, TypedDataDomain } from 'viem';

/** The eight signed fields, in the order assay-evm's `src/Types.sol` declares them. */
export interface EvmVoucher {
  readonly payer: `0x${string}`;
  readonly provider: `0x${string}`;
  readonly amount: bigint;
  readonly resourceHash: `0x${string}`;
  readonly requestHash: `0x${string}`;
  readonly seq: bigint;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

/**
 * Eight fields instead of the Solana layout's eleven, binding strictly more.
 *
 * `payTo` is deliberately absent. On EVM there is one escrow contract serving
 * every buyer, so "which escrow" is fully determined by `verifyingContract`
 * plus `payer`, and a `payTo` field would be a second source for one identity —
 * two answers that can disagree. The port's `Voucher.payTo` is still populated
 * and asserted equal to the escrow's CAIP-10 at the adapter boundary; it is
 * simply not part of the signed struct.
 *
 * **THE ORDER OF THESE ENTRIES IS THE TYPEHASH.** Reordering them is a silent
 * signature-format change — two `uint64` fields swap without changing any
 * width, any encoding length or any struct-hash shape — so `eip712.spec.ts`
 * renders this array back into the Solidity preimage string and compares both
 * the string and the keccak of it against `cast`'s answer.
 */
export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'payer', type: 'address' },
    { name: 'provider', type: 'address' },
    { name: 'amount', type: 'uint64' },
    { name: 'resourceHash', type: 'bytes32' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'seq', type: 'uint64' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function voucherTypedData(voucher: EvmVoucher, domain: TypedDataDomain) {
  return { domain, types: VOUCHER_TYPES, primaryType: 'Voucher' as const, message: voucher };
}

/** The 32-byte digest `ecrecover` is asked about. */
export function hashVoucher(voucher: EvmVoucher, domain: TypedDataDomain): `0x${string}` {
  return hashTypedData(voucherTypedData(voucher, domain));
}
