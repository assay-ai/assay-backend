import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { RequestContext } from '@shared/observability';

import { VerificationQueue } from '../constants/verification-queues.constant';

/**
 * The wakeup `VerificationJudgeProcessor` consumes.
 *
 * Ids only — `organizationId` and `intentId` are what the worker needs to
 * re-read `verification_records` by its unique `(intent_id)` index;
 * `recordId` rides along purely so a log line or a Bull Board entry can name
 * the row without a lookup. Nothing here is the evidence: the response body,
 * the tool's schema and every verdict field live on the row, written before
 * this is ever published, exactly as `docs/adr/0001-bullmq-as-wakeup-mechanism.md`
 * requires.
 */
export interface VerificationJudgeJobData {
  readonly organizationId: string;
  readonly intentId: string;
  readonly recordId: string;

  /**
   * The HTTP request this job was enqueued from. Stamped by
   * `publishJudge` from the ambient `RequestContext`, not passed by callers —
   * a parameter would be one every future call site could forget, and the
   * symptom of forgetting is a log line that no longer names the tool call
   * that caused it. Optional because a job enqueued before this shipped has
   * none; `QueueProcessorBase` supplies a fresh id in that case.
   */
  readonly requestId?: string;
}

@Injectable()
export class VerificationJudgePublisher {
  private readonly logger = new Logger(VerificationJudgePublisher.name);

  constructor(
    @InjectQueue(VerificationQueue.JUDGE)
    private readonly queue: Queue<VerificationJudgeJobData>,
  ) {}

  /**
   * Enqueues the judge-and-settle wakeup for one intent.
   *
   * `jobId` is the intent id, not the record id: two enqueue calls for the
   * same intent — the original `tools/call` write and any future manual
   * retry — must collapse into one BullMQ job, and the intent is the stable
   * key across both. `attempts: 3` with backoff overrides the project's
   * `attempts: 1` default deliberately: `judgeAndSettle` is idempotent in
   * both of its phases (`markJudgedIfPending` / `markSettledIfJudged` are
   * compare-and-swaps, and the ledger's hold resolution is idempotent), so a
   * transient failure — a dropped DB connection, a Redis blip — is safe to
   * retry through BullMQ itself rather than waiting on an external sweep that
   * does not exist yet for this table. See `docs/adr/0001-bullmq-as-wakeup-mechanism.md`
   * §"Convention: attempts per queue type", "stateless idempotent" row.
   */
  async publishJudge(data: VerificationJudgeJobData): Promise<void> {
    const jobId = `verification-judge-${data.intentId}`;

    await this.queue.add(
      VerificationQueue.JUDGE,
      { ...data, requestId: data.requestId ?? RequestContext.getRequestId() ?? undefined },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    this.logger.log(
      `Enqueued ${VerificationQueue.JUDGE} (jobId=${jobId}) for intent ${data.intentId}`,
    );
  }
}
