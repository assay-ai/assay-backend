import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';

import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderSlashHoldEntity } from '@database/postgres/entities/provider-slash-hold.entity';
import { ProviderStakeGraceEntity } from '@database/postgres/entities/provider-stake-grace.entity';
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { StakeSnapshotEntity } from '@database/postgres/entities/stake-snapshot.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';

import { QuoteIndexService } from './quote-index.service';

/**
 * The writes a listed price depends on. Any of them drops the quote index in
 * every process, so a listing shows the change on its next read rather than
 * within the minute the age bound allows:
 *
 * - `tool_bindings` — a save, a publish, a pause, a price change;
 * - `providers` — a suspension, an unbonding, a tier change;
 * - `provider_chain_enrolments` — a payout or stake enrolment opened or closed;
 * - `provider_slash_holds`, `provider_stake_grace` — what the stake gate reads;
 * - `stake_snapshots` — written by every stake-monitor pass, which is the
 *   moment a stake read off the chain may have moved.
 *
 * A TypeORM subscriber rather than a call at each write site: a site that
 * forgot the call would leave a stale price nobody notices. Query-builder
 * writes broadcast too; only raw SQL would not, and the stake read itself is
 * a chain read, which only the age bound covers between monitor passes.
 */
export const QUOTE_INDEX_SOURCES: ReadonlySet<unknown> = new Set<unknown>([
  ToolBindingEntity,
  ProviderEntity,
  ProviderChainEnrolmentEntity,
  ProviderSlashHoldEntity,
  ProviderStakeGraceEntity,
  StakeSnapshotEntity,
]);

@Injectable()
export class QuoteIndexInvalidationSubscriber implements EntitySubscriberInterface {
  constructor(
    private readonly index: QuoteIndexService,
    // Optional so a module graph with no database (the wiring specs) still
    // resolves; with no data source there are no writes to listen to.
    @Optional() @InjectDataSource('postgres') dataSource?: DataSource,
  ) {
    dataSource?.subscribers.push(this);
  }

  afterInsert(event: InsertEvent<unknown>): void {
    this.onWrite(event.metadata?.target);
  }

  afterUpdate(event: UpdateEvent<unknown>): void {
    this.onWrite(event.metadata?.target);
  }

  afterRemove(event: RemoveEvent<unknown>): void {
    this.onWrite(event.metadata?.target);
  }

  private onWrite(target: unknown): void {
    if (QUOTE_INDEX_SOURCES.has(target)) void this.index.bumpEpoch();
  }
}
