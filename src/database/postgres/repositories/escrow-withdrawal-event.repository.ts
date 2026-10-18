import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager } from 'typeorm';

import {
  EscrowWithdrawalEventEntity,
  EscrowWithdrawalEventKind,
} from '../entities/escrow-withdrawal-event.entity';
import { EvmChainStateEntity } from '../entities/evm-chain-state.entity';
import { AbstractRepository } from './abstract.repository';

/** One decoded withdrawal log, ready to store. */
export interface EscrowWithdrawalEventRow {
  readonly chainId: string;
  /** Lower-case `0x`. */
  readonly buyerAddress: string;
  readonly kind: EscrowWithdrawalEventKind;
  readonly amount: bigint;
  readonly requested: bigint | null;
  readonly availableAt: Date | null;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: string;
  readonly blockTime: Date;
}

/** A buyer escrow on one chain, as the history is read for it. */
export interface EscrowBuyerKey {
  readonly chainId: string;
  /** Lower-case `0x`. */
  readonly buyerAddress: string;
}

/**
 * `escrow_withdrawal_events` and `evm_chain_states.withdrawal_cursor_block`:
 * what `EvmEscrowWithdrawalIndexer` writes and the withdrawal history reads
 * (B7). Read-side bookkeeping only; see the entity.
 */
@Injectable()
export class EscrowWithdrawalEventRepository extends AbstractRepository<EscrowWithdrawalEventEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(EscrowWithdrawalEventEntity, dataSource);
  }

  /** The indexer's cursor on `chainId`, or `null` before its first read. */
  async findCursor(chainId: string): Promise<bigint | null> {
    const state = await this.manager.findOne(EvmChainStateEntity, {
      select: { id: true, withdrawalCursorBlock: true },
      where: { chainId },
    });
    return state?.withdrawalCursorBlock == null ? null : BigInt(state.withdrawalCursorBlock);
  }

  /**
   * The rows of one indexed range and the cursor past it, in one transaction.
   * A row already stored (a re-read range) is skipped; `onInserted` sees only
   * the rows this call stored, inside the same transaction, so whatever it
   * writes is written once.
   */
  async applyIndexedRange(
    chainId: string,
    cursorBlock: bigint,
    rows: readonly EscrowWithdrawalEventRow[],
    onInserted?: (
      manager: EntityManager,
      inserted: readonly EscrowWithdrawalEventRow[],
    ) => Promise<void>,
  ): Promise<readonly EscrowWithdrawalEventRow[]> {
    return this.manager.transaction(async (manager) => {
      const state = await lockState(manager, chainId);
      const inserted: EscrowWithdrawalEventRow[] = [];
      for (const row of rows) {
        const result = await manager
          .createQueryBuilder()
          .insert()
          .into(EscrowWithdrawalEventEntity)
          .values({
            chainId: row.chainId,
            buyerAddress: row.buyerAddress.toLowerCase(),
            kind: row.kind,
            amount: row.amount.toString(),
            requested: row.requested === null ? null : row.requested.toString(),
            availableAt: row.availableAt,
            blockNumber: row.blockNumber.toString(),
            logIndex: row.logIndex,
            transactionHash: row.transactionHash.toLowerCase(),
            blockTime: row.blockTime,
          })
          .orIgnore()
          .execute();
        if ((result.identifiers ?? []).some((id) => id && id.id)) inserted.push(row);
      }
      if (onInserted && inserted.length > 0) await onInserted(manager, inserted);
      await manager.update(
        EvmChainStateEntity,
        { id: state.id },
        { withdrawalCursorBlock: cursorBlock.toString() },
      );
      return inserted;
    });
  }

  /**
   * The organization and asset of the buyer escrow at `chainId:address`, or
   * `null` when no buyer of this platform has one there.
   */
  async escrowOwner(
    manager: EntityManager,
    chainId: string,
    buyerAddress: string,
  ): Promise<{ organizationId: string; accountId: string; assetId: string } | null> {
    const rows: { organization_id: string; account_id: string; asset_id: string }[] =
      await manager.query(
        `SELECT "organization_id", "account_id", "asset_id" FROM "buyer_escrows"
          WHERE lower("account_id") = lower($1) LIMIT 1`,
        [`${chainId}:${buyerAddress}`],
      );
    const row = rows[0];
    return row
      ? { organizationId: row.organization_id, accountId: row.account_id, assetId: row.asset_id }
      : null;
  }

  /** Every stored event of these buyers, oldest first (chain order). */
  async listForBuyers(buyers: readonly EscrowBuyerKey[]): Promise<EscrowWithdrawalEventEntity[]> {
    if (buyers.length === 0) return [];
    return this.byBuyers(buyers)
      .orderBy('event.blockNumber', 'ASC')
      .addOrderBy('event.logIndex', 'ASC')
      .getMany();
  }

  /**
   * What these buyers claimed out of their escrows in `[from, to)`, by block
   * time, per chain. Atomic units.
   */
  async sumWithdrawn(
    buyers: readonly EscrowBuyerKey[],
    from: Date | null,
    to: Date,
  ): Promise<Map<string, bigint>> {
    const sums = new Map<string, bigint>();
    if (buyers.length === 0) return sums;
    const qb = this.byBuyers(buyers)
      .select('event.chainId', 'chainId')
      .addSelect('event.buyerAddress', 'buyerAddress')
      .addSelect('COALESCE(SUM(event.amount), 0)', 'total')
      .andWhere('event.kind = :kind', { kind: EscrowWithdrawalEventKind.WITHDRAWN })
      .andWhere('event.blockTime < :to', { to })
      .groupBy('event.chainId')
      .addGroupBy('event.buyerAddress');
    if (from) qb.andWhere('event.blockTime >= :from', { from });
    const rows: { chainId: string; buyerAddress: string; total: string }[] = await qb.getRawMany();
    for (const row of rows) sums.set(`${row.chainId}:${row.buyerAddress}`, BigInt(row.total));
    return sums;
  }

  private byBuyers(buyers: readonly EscrowBuyerKey[]) {
    return this.createQueryBuilder('event').where(
      new Brackets((where) => {
        buyers.forEach((buyer, index) => {
          where.orWhere(
            `(event.chainId = :chain${index} AND event.buyerAddress = :address${index})`,
            {
              [`chain${index}`]: buyer.chainId,
              [`address${index}`]: buyer.buyerAddress.toLowerCase(),
            },
          );
        });
      }),
    );
  }
}

/** The chain's `evm_chain_states` row, created if absent, locked for this transaction. */
async function lockState(manager: EntityManager, chainId: string): Promise<EvmChainStateEntity> {
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
