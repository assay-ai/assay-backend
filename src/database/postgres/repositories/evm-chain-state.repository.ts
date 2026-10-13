import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { EvmBlockedAddressEntity } from '../entities/evm-blocked-address.entity';
import { EvmChainStateEntity } from '../entities/evm-chain-state.entity';
import { AbstractRepository } from './abstract.repository';

/** One `BlockedSet` (or a reconcile correction), in chain order. */
export interface BlockedSetRow {
  readonly address: string;
  readonly blocked: boolean;
  readonly setBy: string | null;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly transactionHash: string | null;
}

/** What one indexer tick read, written in one transaction with its cursor. */
export interface IndexedRange {
  readonly chainId: string;
  readonly cursorBlock: bigint;
  readonly headBlock: bigint;
  readonly caughtUp: boolean;
  readonly now: Date;
  /** The last `PauseToggled` in the range, if any. */
  readonly paused?: boolean;
  /** The last `ArbiterSet` in the range, lower-case, `null` for none. */
  readonly arbiter?: string | null;
  readonly blocked: readonly BlockedSetRow[];
}

export interface ChainTermsRow {
  readonly paused: boolean;
  readonly arbiter: string | null;
  readonly slashDelaySeconds: number;
}

/**
 * `evm_chain_states` and `evm_blocked_addresses` — the chain-state cache
 * `EvmChainStateIndexer` writes and every process's `EvmChainStateService`
 * reads. Platform data: no tenant scope.
 */
@Injectable()
export class EvmChainStateRepository extends AbstractRepository<EvmChainStateEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(EvmChainStateEntity, dataSource);
  }

  async findAllStates(): Promise<EvmChainStateEntity[]> {
    return this.find({ order: { chainId: 'ASC' } });
  }

  async findState(chainId: string): Promise<EvmChainStateEntity | null> {
    return this.findOne({ where: { chainId } });
  }

  /** Every address currently blocked, on every chain — the whole hot-path set. */
  async findBlocked(): Promise<{ chainId: string; address: string }[]> {
    return this.manager.find(EvmBlockedAddressEntity, {
      select: { chainId: true, address: true },
      where: { blocked: true },
    });
  }

  /** Every address the chain ever named on `chainId` — what a reconcile re-checks. */
  async findKnownAddresses(chainId: string): Promise<EvmBlockedAddressEntity[]> {
    return this.manager.find(EvmBlockedAddressEntity, { where: { chainId } });
  }

  /**
   * One tick's events and its cursor, atomically: a crash leaves the cursor
   * behind its events, never ahead of them, so the next tick re-reads them.
   */
  async applyIndexedRange(range: IndexedRange): Promise<void> {
    await this.manager.transaction(async (manager) => {
      const state = await this.lockState(manager, range.chainId);
      for (const row of range.blocked) await this.upsertBlocked(manager, range.chainId, row);
      await manager.update(
        EvmChainStateEntity,
        { id: state.id },
        {
          cursorBlock: range.cursorBlock.toString(),
          headBlock: range.headBlock.toString(),
          indexedAt: range.now,
          ...(range.caughtUp ? { caughtUpAt: range.now } : {}),
          ...(range.paused !== undefined ? { paused: range.paused } : {}),
          ...(range.arbiter !== undefined ? { arbiter: range.arbiter } : {}),
          lastError: null,
        },
      );
    });
  }

  /** The periodic full read: the Config's terms, and every corrected address. */
  async applyReconcile(
    chainId: string,
    terms: ChainTermsRow,
    corrections: readonly BlockedSetRow[],
    now: Date,
  ): Promise<void> {
    await this.manager.transaction(async (manager) => {
      const state = await this.lockState(manager, chainId);
      for (const row of corrections) await this.upsertBlocked(manager, chainId, row, true);
      await manager.update(
        EvmChainStateEntity,
        { id: state.id },
        {
          paused: terms.paused,
          arbiter: terms.arbiter,
          slashDelaySeconds: terms.slashDelaySeconds,
          reconciledAt: now,
        },
      );
      await manager
        .createQueryBuilder()
        .update(EvmBlockedAddressEntity)
        .set({ reconciledAt: now })
        .where('chain_id = :chainId', { chainId })
        .execute();
    });
  }

  async recordError(chainId: string, message: string): Promise<void> {
    await this.manager.transaction(async (manager) => {
      const state = await this.lockState(manager, chainId);
      await manager.update(
        EvmChainStateEntity,
        { id: state.id },
        { lastError: message.slice(0, 256) },
      );
    });
  }

  private async lockState(manager: EntityManager, chainId: string): Promise<EvmChainStateEntity> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(EvmChainStateEntity)
      .values({ chainId })
      .orIgnore()
      .execute();
    return manager
      .createQueryBuilder(EvmChainStateEntity, 'state')
      .setLock('pessimistic_write')
      .where('state.chain_id = :chainId', { chainId })
      .getOneOrFail();
  }

  /**
   * Newest wins: an event older than the row's own block never overwrites it
   * (a re-read range), and a reconcile correction — the chain read NOW —
   * always does.
   */
  private async upsertBlocked(
    manager: EntityManager,
    chainId: string,
    row: BlockedSetRow,
    fromReconcile = false,
  ): Promise<void> {
    const address = row.address.toLowerCase();
    const existing = await manager.findOne(EvmBlockedAddressEntity, {
      where: { chainId, address },
    });
    if (!existing) {
      await manager.insert(EvmBlockedAddressEntity, {
        chainId,
        address,
        blocked: row.blocked,
        setBy: row.setBy?.toLowerCase() ?? null,
        blockNumber: row.blockNumber?.toString() ?? null,
        logIndex: row.logIndex,
        transactionHash: row.transactionHash,
      });
      return;
    }
    if (!fromReconcile && existing.blockNumber !== null && row.blockNumber !== null) {
      const stored = BigInt(existing.blockNumber);
      if (
        row.blockNumber < stored ||
        (row.blockNumber === stored && (row.logIndex ?? 0) <= (existing.logIndex ?? 0))
      ) {
        return;
      }
    }
    await manager.update(
      EvmBlockedAddressEntity,
      { id: existing.id },
      {
        blocked: row.blocked,
        ...(fromReconcile
          ? {}
          : {
              setBy: row.setBy?.toLowerCase() ?? null,
              blockNumber: row.blockNumber?.toString() ?? null,
              logIndex: row.logIndex,
              transactionHash: row.transactionHash,
            }),
      },
    );
  }
}
