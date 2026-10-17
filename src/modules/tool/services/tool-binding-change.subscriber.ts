import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';

import { QuoteIndexService } from './quote-index.service';

/**
 * Every write to `tool_bindings` — a save, a publish, a pause, a price change —
 * drops the quote index in every process, so a listing shows the change on its
 * next read rather than within the minute the age bound allows.
 *
 * A TypeORM subscriber rather than a call at each write site: the binding
 * editor, the publish gate, the pause button and the SLA breaker all write the
 * row, and a site that forgot the call would leave a stale price nobody
 * notices. Query-builder updates broadcast too; only raw SQL would not, and
 * nothing writes this table that way.
 */
@Injectable()
export class ToolBindingChangeSubscriber implements EntitySubscriberInterface<ToolBindingEntity> {
  constructor(
    private readonly index: QuoteIndexService,
    // Optional so a module graph with no database (the wiring specs) still
    // resolves; with no data source there are no writes to listen to.
    @Optional() @InjectDataSource('postgres') dataSource?: DataSource,
  ) {
    dataSource?.subscribers.push(this);
  }

  listenTo(): typeof ToolBindingEntity {
    return ToolBindingEntity;
  }

  afterInsert(): void {
    void this.index.bumpEpoch();
  }

  afterUpdate(): void {
    void this.index.bumpEpoch();
  }

  afterRemove(): void {
    void this.index.bumpEpoch();
  }
}
