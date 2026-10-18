import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CALL_DISPUTE_CONFIG, CallDisputeConfig } from '../constants/call-dispute.config';

/** Rows scrubbed per statement; the sweep repeats until none are left. */
const SCRUB_BATCH = 500;

/**
 * Deletes the call's request and response from a call dispute's evidence
 * snapshot `snapshotRetentionMs` after the dispute was decided or withdrawn
 * (G3.B1). The snapshot outlives the evidence bodies' own 72-hour retention on
 * purpose — a decision must not depend on data that is scrubbed — but not for
 * ever. The call's identifiers, the verdict and the pack digests stay, so the
 * decision can still be read and checked.
 *
 * Deliberately cross-organization: a platform job with no calling tenant.
 */
@Injectable()
export class CallDisputeRetentionService {
  private readonly logger = new Logger(CallDisputeRetentionService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(CALL_DISPUTE_CONFIG) private readonly config: CallDisputeConfig,
  ) {}

  /** Returns how many snapshots were scrubbed. */
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.snapshotRetentionMs);
    let total = 0;
    for (;;) {
      const rows = (await this.dataSource.query(
        `UPDATE "disputes" d
            SET "evidence_snapshot" = (d."evidence_snapshot" - 'request' - 'response')
                  || jsonb_build_object('bodiesDeletedAt', to_jsonb($2::timestamptz)),
                "evidence_scrubbed_at" = $2
          WHERE d."id" IN (
            SELECT "id" FROM "disputes"
             WHERE "intent_id" IS NOT NULL AND "evidence_scrubbed_at" IS NULL
               AND "state" IN ('UPHELD', 'REJECTED', 'WITHDRAWN')
               AND COALESCE("resolved_at", "updated_at") < $1
             LIMIT ${SCRUB_BATCH})
          RETURNING d."id"`,
        [cutoff, now],
      )) as unknown;
      const count = countOf(rows);
      total += count;
      if (count < SCRUB_BATCH) break;
    }
    if (total > 0) this.logger.log(`Scrubbed ${total} call dispute evidence snapshot(s)`);
    return total;
  }
}

function countOf(result: unknown): number {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return (result[0] as unknown[]).length;
  }
  return Array.isArray(result) ? result.length : 0;
}
