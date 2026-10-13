import { decodeFunctionResult } from 'viem';

import { X402_STAKE_ABI } from './abi/x402.abi';

/**
 * `X402Stake.slashRecordOf`, decoded (the upgraded, fifteen-word record of
 * assay-evm D-19). The backend assumes the upgraded Stake; there is no
 * fallback to the pre-upgrade shape.
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
  /** Seconds; `0n` until `disputeSlash`. */
  readonly disputedAt: bigint;
}

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
 */
export function decodeSlashRecord(data: `0x${string}`): EvmSlashRecord {
  return normaliseSlashRecord(
    decodeFunctionResult({
      abi: X402_STAKE_ABI,
      functionName: 'slashRecordOf',
      data,
    }) as RawSlashRecord,
  );
}

/** `slashRecordOf(requestId)` through `readContract`. Every error is rethrown as it came. */
export async function readSlashRecord(
  client: EvmSlashRecordClient,
  stake: `0x${string}`,
  requestId: `0x${string}`,
): Promise<EvmSlashRecord> {
  return normaliseSlashRecord(
    (await client.readContract({
      address: stake,
      abi: X402_STAKE_ABI,
      functionName: 'slashRecordOf',
      args: [requestId],
    })) as RawSlashRecord,
  );
}

type RawSlashRecord = Omit<EvmSlashRecord, 'status'> & {
  readonly status: number | bigint;
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
    disputedAt: BigInt(raw.disputedAt),
  };
}
