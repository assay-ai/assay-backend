import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from 'typeorm';

import { EscrowWithdrawalEventKind } from '@database/postgres/entities/escrow-withdrawal-event.entity';
import {
  EscrowWithdrawalEventRepository,
  EscrowWithdrawalEventRow,
} from '@database/postgres/repositories/escrow-withdrawal-event.repository';
import { AuditLogWriter } from '@shared/audit';
import { MoneyUtil } from '@shared/utils/money.util';

import { ENABLED_CHAINS } from '../enabled-chains';
import { getAssetMetadata } from '../ports/asset-registry';
import { AssetId, ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import { X402_ESCROW_WITHDRAWAL_EVENTS_ABI } from './abi/x402.abi';
import {
  DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS,
  EVM_CHAIN_STATE_INDEXER_CONFIG,
  EvmChainStateIndexerConfig,
} from './chain-state/evm-chain-state.indexer';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from './evm.constants';

/** Every minute: a claim shows in the buyer's history within a few minutes. */
export const EVM_ESCROW_WITHDRAWAL_INDEX_CRON = '30 * * * * *';
/** Most blocks one tick reads per chain; a backlog is caught up over later ticks. */
export const EVM_ESCROW_WITHDRAWAL_MAX_BLOCKS = 10_000n;
/** Blocks per `eth_getLogs` call; most providers refuse wider ranges. */
export const EVM_ESCROW_WITHDRAWAL_CHUNK = 2_000n;
/**
 * Where a chain with no cursor, no `EVM_CHAIN_STATE_FROM_BLOCK` and no recorded
 * `disputeUpgradeBlock` starts: this many blocks behind the safe head.
 */
export const EVM_ESCROW_WITHDRAWAL_INITIAL_LOOKBACK = 10_000n;

/** One decoded log of {@link X402_ESCROW_WITHDRAWAL_EVENTS_ABI}. */
export interface EscrowWithdrawalLog {
  readonly eventName: 'WithdrawRequested' | 'EscrowWithdrawn';
  readonly args: {
    readonly buyer?: `0x${string}`;
    readonly amount?: bigint;
    readonly availableAt?: bigint;
    readonly requested?: bigint;
  };
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly transactionHash: `0x${string}` | null;
}

/** The three reads this class needs from a viem public client. */
export interface EvmEscrowWithdrawalClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getContractEvents(args: {
    address: `0x${string}`;
    abi: typeof X402_ESCROW_WITHDRAWAL_EVENTS_ABI;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly EscrowWithdrawalLog[]>;
  getBlock(args: { blockNumber: bigint }): Promise<{ readonly timestamp: bigint }>;
}

/**
 * Indexes the escrow's `WithdrawRequested` and `EscrowWithdrawn` into
 * `escrow_withdrawal_events` (B7): the buyer's withdrawal history and the
 * withdrawals line of a statement.
 *
 * **Read-side bookkeeping, and nothing else.** No ledger entry is written: a
 * `WITHDRAWAL` entry lowers the ledger's `available`, which the reconciler
 * compares against the chain and which the spend path reads while the escrow
 * spend gate is off. The chain is the record of the balance; this table only
 * remembers when the buyer took money out. An audit row is written for each
 * claim of a buyer this platform knows, in the transaction that stores it, so
 * a re-read range logs nothing twice. Requests and cancels sent through the
 * console are logged by `EscrowController` when they land.
 *
 * Read-only on chain (`eth_blockNumber`, `eth_getLogs`, `eth_getBlockByNumber`).
 * Events are read only up to `head − EVM_CHAIN_STATE_CONFIRMATIONS`, the
 * chain-state indexer's depth; the cursor is
 * `evm_chain_states.withdrawal_cursor_block`, written with the rows. A chain
 * with no cursor starts at `EVM_CHAIN_STATE_FROM_BLOCK`, else the deployment's
 * `disputeUpgradeBlock`, else {@link EVM_ESCROW_WITHDRAWAL_INITIAL_LOOKBACK}
 * blocks back: withdrawals before that are not in the history.
 */
@Injectable()
export class EvmEscrowWithdrawalIndexer {
  private readonly logger = new Logger(EvmEscrowWithdrawalIndexer.name);

  constructor(
    @Inject(EVM_RPC_CLIENTS)
    private readonly clients: ReadonlyMap<ChainId, EvmEscrowWithdrawalClient>,
    @Inject(EVM_DEPLOYMENTS) private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly events: EscrowWithdrawalEventRepository,
    @Optional() private readonly audit: AuditLogWriter | null = null,
    @Optional()
    @Inject(EVM_CHAIN_STATE_INDEXER_CONFIG)
    private readonly indexer: Pick<
      EvmChainStateIndexerConfig,
      'fromBlock' | 'confirmations'
    > | null = null,
  ) {}

  @Cron(EVM_ESCROW_WITHDRAWAL_INDEX_CRON)
  async handleTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(`escrow withdrawal index threw: ${describe(error)}`);
    }
  }

  /** One pass over every enabled eip155 chain with a deployment. */
  async tick(): Promise<void> {
    for (const chainId of this.enabled) {
      if (namespaceOf(chainId) !== ChainNamespace.EIP155) continue;
      const deployment = this.deployments.get(chainId);
      const client = this.clients.get(chainId);
      if (!deployment || !client) continue;
      try {
        await this.indexChain(chainId, deployment, client);
      } catch (error) {
        // The node's message stays in this log line: an RPC URL can carry a key.
        this.logger.error(`escrow withdrawal index on ${chainId} failed: ${describe(error)}`);
      }
    }
  }

  private async indexChain(
    chainId: ChainId,
    deployment: EvmDeployment,
    client: EvmEscrowWithdrawalClient,
  ): Promise<void> {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const confirmations = BigInt(
      this.indexer?.confirmations ?? DEFAULT_EVM_CHAIN_STATE_CONFIRMATIONS,
    );
    const safeHead = head > confirmations ? head - confirmations : 0n;
    const cursor = await this.events.findCursor(chainId);
    const known = this.indexer?.fromBlock.get(chainId) ?? deployment.disputeUpgradeBlock;
    const start =
      cursor !== null
        ? cursor + 1n
        : (known ??
          (safeHead > EVM_ESCROW_WITHDRAWAL_INITIAL_LOOKBACK
            ? safeHead - EVM_ESCROW_WITHDRAWAL_INITIAL_LOOKBACK
            : 0n));
    if (start > safeHead) return;
    const end =
      safeHead - start + 1n > EVM_ESCROW_WITHDRAWAL_MAX_BLOCKS
        ? start + EVM_ESCROW_WITHDRAWAL_MAX_BLOCKS - 1n
        : safeHead;

    const logs: EscrowWithdrawalLog[] = [];
    for (let from = start; from <= end; from += EVM_ESCROW_WITHDRAWAL_CHUNK) {
      const to =
        from + EVM_ESCROW_WITHDRAWAL_CHUNK - 1n < end
          ? from + EVM_ESCROW_WITHDRAWAL_CHUNK - 1n
          : end;
      logs.push(
        ...(await client.getContractEvents({
          address: deployment.escrow,
          abi: X402_ESCROW_WITHDRAWAL_EVENTS_ABI,
          fromBlock: from,
          toBlock: to,
        })),
      );
    }

    const rows = await this.toRows(chainId, client, logs);
    // A failure throws before the cursor moves, so the range is read again.
    await this.events.applyIndexedRange(chainId, end, rows, (manager, inserted) =>
      this.auditClaims(manager, chainId, inserted),
    );
  }

  private async toRows(
    chainId: ChainId,
    client: EvmEscrowWithdrawalClient,
    logs: readonly EscrowWithdrawalLog[],
  ): Promise<EscrowWithdrawalEventRow[]> {
    const times = new Map<bigint, Date>();
    const rows: EscrowWithdrawalEventRow[] = [];
    for (const log of logs) {
      const buyer = log.args.buyer;
      if (
        !buyer ||
        log.blockNumber === null ||
        log.logIndex === null ||
        log.transactionHash === null
      ) {
        continue;
      }
      let blockTime = times.get(log.blockNumber);
      if (!blockTime) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        blockTime = new Date(Number(block.timestamp) * 1000);
        times.set(log.blockNumber, blockTime);
      }
      const base = {
        chainId,
        buyerAddress: buyer.toLowerCase(),
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        transactionHash: log.transactionHash,
        blockTime,
      };
      if (log.eventName === 'WithdrawRequested') {
        const amount = log.args.amount ?? 0n;
        rows.push({
          ...base,
          kind:
            amount === 0n
              ? EscrowWithdrawalEventKind.CANCELLED
              : EscrowWithdrawalEventKind.REQUESTED,
          amount,
          requested: null,
          availableAt:
            amount === 0n || !log.args.availableAt
              ? null
              : new Date(Number(log.args.availableAt) * 1000),
        });
      } else if (log.eventName === 'EscrowWithdrawn') {
        rows.push({
          ...base,
          kind: EscrowWithdrawalEventKind.WITHDRAWN,
          amount: log.args.amount ?? 0n,
          requested: log.args.requested ?? null,
          availableAt: null,
        });
      }
    }
    rows.sort(
      (left, right) =>
        Number(left.blockNumber - right.blockNumber) || left.logIndex - right.logIndex,
    );
    return rows;
  }

  /** `withdrawal.claimed` for each newly stored claim of a buyer this platform knows. */
  private async auditClaims(
    manager: EntityManager,
    chainId: ChainId,
    inserted: readonly EscrowWithdrawalEventRow[],
  ): Promise<void> {
    if (!this.audit) return;
    for (const row of inserted) {
      if (row.kind !== EscrowWithdrawalEventKind.WITHDRAWN) continue;
      const owner = await this.events.escrowOwner(manager, chainId, row.buyerAddress);
      if (!owner) continue;
      await this.audit.record(manager, {
        organizationId: owner.organizationId,
        actor: { type: 'system', id: 'escrow-withdrawal-index' },
        action: 'withdrawal.claimed',
        resourceType: 'escrow',
        resourceId: owner.accountId,
        before: null,
        after: {
          amount: decimal(row.amount, owner.assetId),
          amountAtomic: row.amount.toString(),
          requested: row.requested === null ? null : decimal(row.requested, owner.assetId),
          asset: owner.assetId,
          transactionHash: row.transactionHash,
        },
      });
    }
  }
}

/** A decimal amount for the activity log's sentence, or the atomic one for an unknown asset. */
function decimal(atomic: bigint, assetId: string): string {
  try {
    const { decimals } = getAssetMetadata(assetId as AssetId);
    return MoneyUtil.format(MoneyUtil.of(atomic, assetId as AssetId, decimals));
  } catch {
    return atomic.toString();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
