import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DemoQueue } from '../constants/demo-queues.constant';

export interface DemoPingJobData {
  /** Set by the publisher; included in processor logs for traceability. */
  enqueuedAt: string;
  message: string;
}

/**
 * Publisher for the `demo.ping` queue.
 *
 * Reference pattern future feature modules should mirror:
 *   1. `@InjectQueue(...)` with the queue name from a feature-owned enum.
 *   2. Typed job-data interface co-located with the publisher (consumed by
 *      the matching processor).
 *   3. Explicit `jobId` for idempotency — re-enqueueing the same id is a
 *      no-op, which matters when both an API call and a cron sweeper may
 *      enqueue the same logical work.
 *
 * Demo is stateless, so the `jobId` here is just a timestamp. CAS state-machine
 * jobs should use the row id (e.g. `entityId`) so that the API enqueue path
 * and the cron release path cannot create duplicates.
 */
@Injectable()
export class DemoPingPublisher {
  private readonly logger = new Logger(DemoPingPublisher.name);

  constructor(
    @InjectQueue(DemoQueue.PING)
    private readonly queue: Queue<DemoPingJobData>,
  ) {}

  async enqueue(message: string): Promise<string> {
    const enqueuedAt = new Date().toISOString();
    // BullMQ disallows `:` in custom job ids (it is the Redis key separator),
    // so we use `-` to keep the id Redis-safe.
    const jobId = `demo-ping-${enqueuedAt}`;

    await this.queue.add(
      DemoQueue.PING,
      { enqueuedAt, message },
      {
        jobId,
        // Demo is stateless: override the global `attempts: 1` to demonstrate
        // the retry-engine pattern for stateless idempotent jobs.
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
      },
    );

    this.logger.log(`Enqueued ${DemoQueue.PING} (jobId=${jobId})`);
    return jobId;
  }
}
