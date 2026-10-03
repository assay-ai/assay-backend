import { Inject, Injectable, Logger } from '@nestjs/common';

import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';

import { FREE_QUOTA_CONFIG, FreeQuotaConfig } from '../config/free-quota.config';

/**
 * Keeps the 30-day promise on `tool_call_records`.
 *
 * Modelled directly on `EvidenceRetentionService` — same one-table sweep
 * shape, same "batched, never throws, logs only when it actually did
 * something" contract. There is only one table to cut here (unlike evidence's
 * two, body + record), because a free call's row has no separate "original"
 * anywhere else to scrub: it was never written to `payment_intents` in the
 * first place (relay mode — no intent, no hold, no ledger write), so
 * `tool_call_records` is the entire financial-adjacent footprint of a free
 * call and deleting the row is the whole job.
 *
 * These rows are meant to be *"retained 30 days, then aggregated"*. No
 * aggregation step exists, so this sweep only deletes. Aggregating before
 * deleting is not a decision this class makes on its own: it would need a
 * destination table nobody has designed yet.
 */
@Injectable()
export class ToolCallRecordRetentionService {
  private readonly logger = new Logger(ToolCallRecordRetentionService.name);

  constructor(
    private readonly records: ToolCallRecordRepository,
    @Inject(FREE_QUOTA_CONFIG) private readonly config: FreeQuotaConfig,
  ) {}

  async sweep(now: Date = new Date()): Promise<number> {
    try {
      const deleted = await this.records.deleteExpired(now, this.config.retentionSweepBatchSize);
      if (deleted > 0) {
        this.logger.log(`Free-tier retention sweep: ${deleted} tool_call_records row(s) deleted`);
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        `Free-tier retention sweep could not delete expired records: ${describe(error)}. ` +
          `Rows past their deadline are still stored; the next sweep retries.`,
      );
      return 0;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
