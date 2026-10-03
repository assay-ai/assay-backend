import { Inject, Injectable, Logger } from '@nestjs/common';

import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';

import {
  EVIDENCE_RETENTION_CONFIG,
  EvidenceRetentionConfig,
} from '../config/evidence-retention.config';

export interface EvidenceSweepResult {
  readonly bodiesDeleted: number;
  readonly recordsScrubbed: number;
}

/**
 * Keeps the 72-hour promise.
 *
 * ## It cuts in two places, and the second is the one that matters
 *
 * `evidence_bodies` holds the sealed copy, and its rows carry their own
 * deadline. `verification_records.request` / `.response` hold the **originals**,
 * written at `enqueue`, and nothing has ever removed them. Sweeping only the
 * copy would leave the platform holding every request body it ever received,
 * while a test asserting "the body is gone after 72 hours" passed — the
 * emptiest kind of green.
 *
 * ## Why deleting a body does not damage the evidence
 *
 * The pack's hash covers the *digests* of the bodies, never the bytes. So a
 * pack whose body row is gone still recomputes to the same `content_hash`, and
 * a provider holding their own access log can still prove their copy is the one
 * that was judged. That is the entire reason the bodies live in a second table.
 *
 * ## Failure is per half, and never fatal
 *
 * Each half is caught separately: an error deleting bodies must not stop the
 * record scrub, because they are two different promises to two different
 * readers. The sweep runs again in an hour, so the honest response to a failure
 * is a log line and a smaller batch, not a retry storm.
 */
@Injectable()
export class EvidenceRetentionService {
  private readonly logger = new Logger(EvidenceRetentionService.name);

  constructor(
    private readonly bodies: EvidenceBodyRepository,
    private readonly records: VerificationRecordRepository,
    @Inject(EVIDENCE_RETENTION_CONFIG) private readonly config: EvidenceRetentionConfig,
  ) {}

  async sweep(now: Date = new Date()): Promise<EvidenceSweepResult> {
    const cutoff = new Date(now.getTime() - this.config.bodyRetentionHours * 3_600_000);

    const bodiesDeleted = await this.deleteExpiredBodies(now);
    const recordsScrubbed = await this.scrubRecords(cutoff);

    if (bodiesDeleted > 0 || recordsScrubbed > 0) {
      this.logger.log(
        `Evidence retention sweep: ${bodiesDeleted} body row(s) deleted, ` +
          `${recordsScrubbed} verification record(s) scrubbed ` +
          `(older than ${cutoff.toISOString()})`,
      );
    }

    return { bodiesDeleted, recordsScrubbed };
  }

  private async deleteExpiredBodies(now: Date): Promise<number> {
    try {
      return await this.bodies.deleteExpired(now, this.config.sweepBatchSize);
    } catch (error) {
      this.logger.error(
        `Evidence retention could not delete expired bodies: ${describe(error)}. ` +
          `Bodies past their deadline are still stored; the next sweep retries.`,
      );
      return 0;
    }
  }

  private async scrubRecords(cutoff: Date): Promise<number> {
    try {
      return await this.records.scrubBodiesOlderThan(cutoff, this.config.sweepBatchSize);
    } catch (error) {
      this.logger.error(
        `Evidence retention could not scrub verification records: ${describe(error)}. ` +
          `Raw bodies older than the retention window are still stored.`,
      );
      return 0;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
