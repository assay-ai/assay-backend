import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { RequestContext } from '@shared/observability';

/**
 * Base class for all BullMQ processors.
 *
 * Provides:
 *   - A scoped NestJS Logger named after the concrete subclass.
 *   - A standard `onFailed` hook that logs only on the final attempt to avoid
 *     log spam when stateless jobs retry (CAS jobs run with `attempts: 1`, so
 *     for them this fires every time).
 *
 * Subclasses MUST implement `process(job)`. For CAS state-machine jobs the
 * processor must NEVER throw — losing the CAS claim or hitting a domain
 * failure should set the row state in the DB and return success, so BullMQ
 * does not retry the wakeup signal. See ADR 0001 for the full pattern.
 *
 * ## Why the constructor rewrites `this.process`
 *
 * The requirement this closes: one trace per tool call, spanning the async
 * boundary. Verification runs after the agent is unblocked, so a trace that
 * ends at the response misses the half of the system where money moves. The HTTP
 * interceptor enters a `RequestContext` per request, but a job runs on a
 * different process entirely — nothing carries the context across the queue
 * unless the payload does and the consumer re-enters it.
 *
 * That re-entry is done **here**, by wrapping the subclass's own `process`
 * once at construction, rather than by asking each processor to remember. The
 * distinction matters: a convention that every processor must open a context
 * is a convention that the sixth processor written next year will not follow,
 * and the failure is silent — the job still runs, its log lines just stop
 * naming the call that caused them. Wrapping the base makes correlation a
 * property of being a processor rather than of the author having read this
 * file.
 *
 * A job whose payload carries no `requestId` — anything enqueued before this
 * shipped, or by a scheduler tick with no request behind it — gets a fresh
 * one. Its lines are then correlated to each other, which is all there is to
 * correlate; a null would lose even that.
 */
export abstract class QueueProcessorBase<TData = unknown, TResult = void> extends WorkerHost {
  protected readonly logger = new Logger(this.constructor.name);

  constructor() {
    super();

    const inner = this.process.bind(this);
    this.process = (job: Job<TData>): Promise<TResult> =>
      RequestContext.run(
        {
          requestId: correlationIdOf(job) ?? randomUUID(),
          organizationId: organizationIdOf(job),
        },
        () => inner(job),
      );
  }

  abstract process(job: Job<TData>): Promise<TResult>;

  @OnWorkerEvent('failed')
  onFailed(job: Job<TData> | undefined, error: Error): void {
    if (!job) {
      this.logger.error(`Job failed (no job context): ${error.message}`, error.stack);
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade >= maxAttempts - 1;

    if (isLastAttempt) {
      this.logger.error(
        `Job ${job.name} (id=${job.id}) failed permanently after ${job.attemptsMade + 1} attempt(s): ${error.message}`,
        error.stack,
      );
    } else {
      this.logger.warn(
        `Job ${job.name} (id=${job.id}) failed on attempt ${job.attemptsMade + 1}/${maxAttempts}, will retry: ${error.message}`,
      );
    }
  }
}

/**
 * Read the correlation id off a job payload without asserting a shape on it.
 *
 * Deliberately structural rather than a shared `CorrelatedJobData` interface
 * every payload must extend: the base class must work for a payload it has
 * never heard of, including `_examples`' and any queue added later. A payload
 * that carries no id is not an error here — it is the legacy case, and
 * the constructor above supplies a fresh one.
 */
function correlationIdOf(job: Job<unknown>): string | null {
  const data = job.data as { requestId?: unknown } | null | undefined;
  return typeof data?.requestId === 'string' && data.requestId.length > 0 ? data.requestId : null;
}

/** Same, for the tenant. Null is a real answer: a scheduler tick has none. */
function organizationIdOf(job: Job<unknown>): string | null {
  const data = job.data as { organizationId?: unknown } | null | undefined;
  return typeof data?.organizationId === 'string' && data.organizationId.length > 0
    ? data.organizationId
    : null;
}
