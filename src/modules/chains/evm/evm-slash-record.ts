import { decodeFunctionResult } from 'viem';

import { X402_STAKE_ABI, X402_STAKE_LEGACY_SLASH_RECORD_ABI } from './abi/x402.abi';

/**
 * `X402Stake.slashRecordOf`, decoded, for a Stake on either side of the
 * dispute upgrade (assay-evm D-19).
 *
 * The upgrade appended `disputedAt` to `SlashRecord`, so the return grew from
 * fourteen ABI words to fifteen. The record is a static tuple, so the two
 * shapes differ only in length, and the new shape cannot decode the old bytes
 * (viem refuses with `PositionOutOfBounds`). Every reader goes through here so
 * a backend deployed before the upgrade lands keeps reading the old Stake, and
 * picks up `disputedAt` the moment it does — with no flag to flip.
 *
 * `disputedAt` reads `0n` on a pre-upgrade record, which is also what the
 * upgraded contract reports for a record nobody disputed.
 */
export interface EvmSlashRecord {
  readonly provider: `0x${string}`;
  /** `enum SlashStatus` — map it with `slashStatusFromEvm`, never cast it. */
  readonly status: number;
  readonly penalty: bigint;
  readonly beneficiary: `0x${string}`;
  readonly proposedAt: bigint;
  readonly verifier: `0x${string}`;
  readonly executableAt: bigint;
  readonly reserved: bigint;
  readonly capAllowance: bigint;
  readonly applied: bigint;
  readonly executedAt: bigint;
  readonly policy: `0x${string}`;
  /** Seconds; `0n` until `disputeSlash`, and on every pre-upgrade record. */
  readonly disputedAt: bigint;
}

/** 15 words: the upgraded record. 14 words: the record before it. */
const CURRENT_RECORD_BYTES = 15 * 32;

/** The structural read this module needs; every EVM client in this directory has it. */
export interface EvmSlashRecordClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/**
 * The record behind raw `slashRecordOf` return data — the `returnData` of an
 * `aggregate3` result, where there is no `readContract` to retry.
 *
 * Shaped by LENGTH, which is the one thing that differs: hex length
 * `2 + 2 × bytes`. Anything shorter than the current record is decoded as
 * the old one, and a payload too short for either throws.
 */
export function decodeSlashRecord(data: `0x${string}`): EvmSlashRecord {
  const bytes = (data.length - 2) / 2;
  const abi = bytes >= CURRENT_RECORD_BYTES ? X402_STAKE_ABI : X402_STAKE_LEGACY_SLASH_RECORD_ABI;
  return normaliseSlashRecord(
    decodeFunctionResult({ abi, functionName: 'slashRecordOf', data }) as RawSlashRecord,
  );
}

/**
 * `slashRecordOf(requestId)` through `readContract`, current shape first.
 *
 * A decode failure — and only a decode failure — is answered by asking again
 * with the pre-upgrade shape. A revert or a transport error is rethrown as
 * it came: a node that cannot answer must not be mistaken for an old Stake.
 */
export async function readSlashRecord(
  client: EvmSlashRecordClient,
  stake: `0x${string}`,
  requestId: `0x${string}`,
): Promise<EvmSlashRecord> {
  try {
    return normaliseSlashRecord(
      (await client.readContract({
        address: stake,
        abi: X402_STAKE_ABI,
        functionName: 'slashRecordOf',
        args: [requestId],
      })) as RawSlashRecord,
    );
  } catch (error) {
    if (!isDecodeFailure(error)) throw error;
    return normaliseSlashRecord(
      (await client.readContract({
        address: stake,
        abi: X402_STAKE_LEGACY_SLASH_RECORD_ABI,
        functionName: 'slashRecordOf',
        args: [requestId],
      })) as RawSlashRecord,
    );
  }
}

type RawSlashRecord = Omit<EvmSlashRecord, 'disputedAt' | 'status'> & {
  readonly status: number | bigint;
  readonly disputedAt?: bigint;
};

function normaliseSlashRecord(raw: RawSlashRecord): EvmSlashRecord {
  return {
    provider: raw.provider,
    status: Number(raw.status),
    penalty: BigInt(raw.penalty),
    beneficiary: raw.beneficiary,
    proposedAt: BigInt(raw.proposedAt),
    verifier: raw.verifier,
    executableAt: BigInt(raw.executableAt),
    reserved: BigInt(raw.reserved),
    capAllowance: BigInt(raw.capAllowance ?? 0n),
    applied: BigInt(raw.applied),
    executedAt: BigInt(raw.executedAt),
    policy: raw.policy,
    disputedAt: BigInt(raw.disputedAt ?? 0n),
  };
}

/** viem's names for "these bytes do not fit that shape", walked through the cause chain. */
function isDecodeFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (
      typeof name === 'string' &&
      /PositionOutOfBoundsError|AbiDecodingDataSizeTooSmallError|SliceOffsetOutOfBoundsError/.test(
        name,
      )
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
