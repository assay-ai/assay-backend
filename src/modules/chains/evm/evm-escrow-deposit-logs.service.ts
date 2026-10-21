import { getAddress } from 'viem';

import {
  AccountId,
  AssetId,
  ChainId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
  parseAccountId,
} from '../ports/caip.types';
import {
  EscrowDepositLog,
  EscrowDepositLogsPort,
  EscrowDepositScan,
} from '../ports/escrow-deposit-logs.port';
import { ASSAY_ESCROW_DEPOSIT_EVENTS_ABI } from './abi/assay.abi';
import { EvmDeployment } from './evm.constants';

/** Default `RECONCILIATION_DEPOSIT_LOOKBACK_BLOCKS`: how far back the scan reads. */
export const DEFAULT_DEPOSIT_LOOKBACK_BLOCKS = 50_000n;
/** Blocks per `eth_getLogs` call; most providers refuse wider ranges. */
export const DEPOSIT_LOG_CHUNK = 2_000n;

/** The two reads this class needs from a viem public client. */
export interface EvmDepositLogsClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getContractEvents(args: {
    address: `0x${string}`;
    abi: typeof ASSAY_ESCROW_DEPOSIT_EVENTS_ABI;
    eventName: 'Deposited';
    args: { buyer: `0x${string}` };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    readonly {
      readonly args: { readonly amount?: bigint };
      readonly blockNumber: bigint | null;
      readonly transactionHash: `0x${string}` | null;
    }[]
  >;
}

/**
 * `Deposited(buyer = this escrow's owner)` over the last `lookbackBlocks`
 * blocks of the escrow contract, in {@link DEPOSIT_LOG_CHUNK}-block calls.
 * Read-only on chain (`eth_blockNumber`, `eth_getLogs`). A deposit older than
 * the window is not seen. The scan returns the range it read, so the reconciler
 * can say how much of an escrow's surplus no deposit in that range explains.
 */
export class EvmEscrowDepositLogs implements EscrowDepositLogsPort {
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmDepositLogsClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    private readonly lookbackBlocks: bigint = DEFAULT_DEPOSIT_LOOKBACK_BLOCKS,
  ) {}

  async depositsTo(asset: AssetId, buyer: AccountId): Promise<EscrowDepositScan | null> {
    if (namespaceOf(asset) !== ChainNamespace.EIP155) return null;
    const chainId = chainIdOf(asset);
    const client = this.clients.get(chainId);
    const deployment = this.deployments.get(chainId);
    if (!client || !deployment || typeof client.getContractEvents !== 'function') return null;

    const head = await client.getBlockNumber();
    const start = head >= this.lookbackBlocks ? head - this.lookbackBlocks + 1n : 0n;
    const owner = getAddress(parseAccountId(buyer).address);
    const found: EscrowDepositLog[] = [];
    for (let from = start; from <= head; from += DEPOSIT_LOG_CHUNK) {
      const to = from + DEPOSIT_LOG_CHUNK - 1n < head ? from + DEPOSIT_LOG_CHUNK - 1n : head;
      const logs = await client.getContractEvents({
        address: getAddress(deployment.escrow),
        abi: ASSAY_ESCROW_DEPOSIT_EVENTS_ABI,
        eventName: 'Deposited',
        args: { buyer: owner },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        if (!log.transactionHash || log.blockNumber === null || log.args.amount === undefined) {
          continue;
        }
        found.push({
          txHash: log.transactionHash.toLowerCase(),
          amount: BigInt(log.args.amount),
          blockNumber: BigInt(log.blockNumber),
        });
      }
    }
    return { logs: found, fromBlock: start, toBlock: head };
  }
}

/** `RECONCILIATION_DEPOSIT_LOOKBACK_BLOCKS`, a positive integer, else the default. */
export function parseDepositLookbackBlocks(raw: string | undefined): bigint {
  if (raw && /^[1-9]\d{0,9}$/.test(raw.trim())) return BigInt(raw.trim());
  return DEFAULT_DEPOSIT_LOOKBACK_BLOCKS;
}
