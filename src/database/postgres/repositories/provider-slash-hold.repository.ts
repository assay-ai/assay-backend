import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { ProviderSlashHoldEntity } from '../entities/provider-slash-hold.entity';
import { AbstractRepository } from './abstract.repository';

/** One standing hold, as routing, the provider banner and the operator read it. */
export interface ProviderSlashHoldRow {
  readonly providerId: string;
  readonly chainId: string;
  readonly reasons: readonly string[];
  readonly heldSince: Date;
  readonly checkedAt: Date | null;
}

/**
 * `provider_slash_holds` — written by `EvmSlashHoldMonitor` in the scheduler,
 * read on every routing decision (one batched statement over the candidates)
 * and every payment intent. Platform data keyed by the provider organization.
 */
@Injectable()
export class ProviderSlashHoldRepository extends AbstractRepository<ProviderSlashHoldEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ProviderSlashHoldEntity, dataSource);
  }

  /** The standing holds of these providers, any chain. */
  async findHeld(providerIds: readonly string[]): Promise<ProviderSlashHoldRow[]> {
    if (providerIds.length === 0) return [];
    const rows = await this.find({
      where: { providerId: In([...new Set(providerIds)]), held: true },
      order: { chainId: 'ASC' },
    });
    return rows.map(toRow);
  }

  /** Every standing hold, for the operator health view. */
  async findAllHeld(): Promise<ProviderSlashHoldRow[]> {
    return (await this.find({ where: { held: true }, order: { heldSince: 'ASC' } })).map(toRow);
  }

  async isHeld(providerId: string, chainId: string): Promise<boolean> {
    return (await this.count({ where: { providerId, chainId, held: true } })) > 0;
  }

  async findState(providerId: string, chainId: string): Promise<ProviderSlashHoldEntity | null> {
    return this.findOne({ where: { providerId, chainId } });
  }

  /** Write one check's outcome, creating the row on the first. */
  async saveState(
    providerId: string,
    chainId: string,
    state: {
      readonly held: boolean;
      readonly reasons: readonly string[];
      readonly clearChecks: number;
      readonly heldSince: Date | null;
      readonly releasedAt?: Date | null;
      readonly checkedAt: Date;
    },
  ): Promise<void> {
    await this.manager
      .createQueryBuilder()
      .insert()
      .into(ProviderSlashHoldEntity)
      .values({
        providerId,
        chainId,
        held: state.held,
        reasons: [...state.reasons],
        clearChecks: state.clearChecks,
        heldSince: state.heldSince,
        checkedAt: state.checkedAt,
        ...(state.releasedAt !== undefined ? { releasedAt: state.releasedAt } : {}),
      })
      .orUpdate(
        [
          'held',
          'reasons',
          'clear_checks',
          'held_since',
          'checked_at',
          ...(state.releasedAt !== undefined ? ['released_at'] : []),
        ],
        ['provider_id', 'chain_id'],
      )
      .execute();
  }
}

function toRow(row: ProviderSlashHoldEntity): ProviderSlashHoldRow {
  return {
    providerId: row.providerId,
    chainId: row.chainId,
    reasons: row.reasons ?? [],
    heldSince: row.heldSince as Date,
    checkedAt: row.checkedAt,
  };
}
