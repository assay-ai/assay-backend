import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource } from 'typeorm';

import {
  EscrowWithdrawalEventEntity,
  EscrowWithdrawalEventKind,
} from '../entities/escrow-withdrawal-event.entity';
import { EvmChainStateEntity } from '../entities/evm-chain-state.entity';
import { AbstractRepository } from './abstract.repository';
import { lockEvmChainState } from './evm-chain-state.repository';

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
   * The rows of one indexed range and the cursor past it, in one transaction,
   * and the last error cleared. A row already stored (a re-read range) is
   * skipped; the rows this call stored are returned, so whatever the caller
   * does with them afterwards (the claim's audit row) is done once.
   */
  async applyIndexedRange(
    chainId: string,
    cursorBlock: bigint,
    rows: readonly EscrowWithdrawalEventRow[],
  ): Promise<readonly EscrowWithdrawalEventRow[]> {
    return this.manager.transaction(async (manager) => {
      const state = await lockEvmChainState(manager, chainId);
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
      await manager.update(
        EvmChainStateEntity,
        { id: state.id },
        { withdrawalCursorBlock: cursorBlock.toString(), withdrawalLastError: null },
      );
      return inserted;
    });
  }

  /** The index's last read failure on `chainId` (no node prose: an RPC URL can carry a key). */
  async recordError(chainId: string, message: string): Promise<void> {
    await this.manager.transaction(async (manager) => {
      const state = await lockEvmChainState(manager, chainId);
      await manager.update(
        EvmChainStateEntity,
        { id: state.id },
        { withdrawalLastError: message.slice(0, 256) },
      );
    });
  }

  /**
   * The organization and asset of the buyer escrow at `chainId:address`, or
   * `null` when no buyer of this platform has one there. An exact match on
   * `uq_buyer_escrows_account`, for each spelling of the account id the
   * caller passes (the checksummed form ids are written in, and lower case).
   */
  async escrowOwner(
    accountForms: readonly [string, string],
  ): Promise<{ organizationId: string; accountId: string; assetId: string } | null> {
    const forms = [...accountForms];
    const rows: { organization_id: string; account_id: string; asset_id: string }[] =
      await this.manager.query(
        `SELECT "organization_id", "account_id", "asset_id" FROM "buyer_escrows"
          WHERE "account_id" IN ($1, $2) LIMIT 1`,
        forms,
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
