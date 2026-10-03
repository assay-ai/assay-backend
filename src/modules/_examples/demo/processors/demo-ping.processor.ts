import { Injectable } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueProcessorBase } from '@shared/queue';
import { DemoQueue } from '../constants/demo-queues.constant';
import { DemoPingJobData } from '../publishers/demo-ping.publisher';

/**
 * Processor for the `demo.ping` queue.
 *
 * Reference pattern future feature modules should mirror:
 *   1. `@Processor()` decorator with the queue name from the feature-owned
 *      enum, plus a `concurrency` setting where it matters.
 *   2. `extends QueueProcessorBase` for shared logging + onFailed handling.
 *   3. Typed `Job<TData>` argument matching the publisher's job-data interface.
 *
 * NOTE: Demo is stateless, so throwing here triggers BullMQ retry (attempts=3
 * set by the publisher). CAS state-machine processors should NEVER throw —
 * see ADR 0001 for the drop-the-wakeup pattern.
 */
@Processor(DemoQueue.PING, { concurrency: 2 })
@Injectable()
export class DemoPingProcessor extends QueueProcessorBase<DemoPingJobData> {
  async process(job: Job<DemoPingJobData>): Promise<void> {
    const { enqueuedAt, message } = job.data;
    const latencyMs = Date.now() - new Date(enqueuedAt).getTime();

    this.logger.log(
      `Ping received (jobId=${job.id}, attempt=${job.attemptsMade + 1}, latency=${latencyMs}ms): ${message}`,
    );
  }
}
