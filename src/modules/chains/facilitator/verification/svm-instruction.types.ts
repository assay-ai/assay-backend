import { Address, ReadonlyUint8Array } from '@solana/kit';

/**
 * One instruction after `decompileTransactionMessageFetchingLookupTables` has
 * run — every account is a real `Address`, never a lookup-table index.
 *
 * Rule 1 (fee payer isolation) is only sound against this shape. Scanning the
 * *compiled* instruction (raw `programAddressIndex` / `accountIndices` into
 * `staticAccounts`) would miss a fee payer smuggled in through an address
 * lookup table — exactly the bypass the threat model calls out by name. No
 * account *role* (signer/writable) is
 * carried here: isolation treats every slot the same regardless of role — the
 * scheme forbids the fee payer as authority, source *or* delegate, which is
 * every role a `TransferChecked` account can hold — and the transfer-layout
 * rule reads accounts by their fixed positional meaning, not by role.
 */
export interface ResolvedSvmInstruction {
  readonly programAddress: Address;
  readonly accounts: readonly Address[];
  readonly data: ReadonlyUint8Array;
}

/** A decoded SVM `exact` payload, ready for the six rules to run against. */
export interface DecodedSvmPayload {
  readonly feePayer: Address;
  readonly instructions: readonly ResolvedSvmInstruction[];
  /** Address → signature, exactly as carried on the wire (`null` = unsigned). */
  readonly signatures: ReadonlyMap<Address, ReadonlyUint8Array | null>;
  readonly messageBytes: ReadonlyUint8Array;
  /** The original base64 the client sent — the duplicate-settlement cache key. */
  readonly rawTransactionBase64: string;
}
