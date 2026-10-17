import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';

import {
  BindingAttemptInput,
  BindingAttemptRepository,
} from '@database/postgres/repositories/binding-attempt.repository';

import { Classification } from '../domain/classification';
import { RoutingCallClass, attributeAttempt } from '../domain/routing';
import { ToolBinding } from '../ports/tool.types';

/** One attempt, as the router saw it. */
export interface ObservedAttempt {
  readonly binding: ToolBinding;
  readonly classification: Classification;
  readonly elapsedMs: number;
  /** The budget the attempt was given — `binding.timeoutMs`, or less if the request's deadline cut it. */
  readonly timeoutMs: number;
  /** The longest budget this binding can ever be given: `min(binding.timeoutMs, totalDeadlineMs)`. */
  readonly maxBudgetMs: number;
  readonly callClass?: RoutingCallClass;
  readonly buyerOrganizationId?: string;
}

/** How the recorder buffers. A value so a test can shrink it. */
export interface AttemptBufferOptions {
  /** Rows held before new ones are dropped. */
  readonly capacity: number;
  /** Rows per `INSERT`; reaching it flushes at once. */
  readonly batchSize: number;
  /** The longest a row waits before it is flushed. */
  readonly flushIntervalMs: number;
}

/** DI token for {@link AttemptBufferOptions}; absent means {@link DEFAULT_ATTEMPT_BUFFER}. */
export const ATTEMPT_BUFFER_OPTIONS = Symbol('ATTEMPT_BUFFER_OPTIONS');

/**
 * 10,000 rows is a few megabytes at most, and at the default flush cadence it
 * is several seconds of a very busy pod's traffic — enough to ride out a slow
 * database without holding memory the process needs for anything else.
 */
export const DEFAULT_ATTEMPT_BUFFER: AttemptBufferOptions = Object.freeze({
  capacity: 10_000,
  batchSize: 500,
  flushIntervalMs: 1_000,
});

/**
 * Writes the attempts `attributeAttempt` counts to `binding_attempts`, the raw
 * window behind `ProviderStats`.
 *
 * ## Why the router, and not the MCP loop
 *
 * The router is the only place that sees every attempt. The payment intent
 * and `tool_call_records` name the binding that answered last; an attempt that
 * failed over — exactly the provider-caused `SYSTEM_ERROR` availability is
 * about — is recorded nowhere else, and neither is a paid call's latency.
 *
 * ## Why Postgres and not a Redis counter
 *
 * The codebase keeps its source of truth in Postgres and puts Redis in front
 * of it as a cache (`BindingCallCounterService`), so a flush cannot reset a
 * provider's record. A window of "the last N attempts" also needs the attempts
 * themselves to compute a p95 from, which a counter cannot hold. The table is
 * pruned to that window by the stats refresh, so it stays bounded.
 *
 * ## Buffered, bounded, and never on the caller's path
 *
 * {@link record} is synchronous: it attributes the attempt and appends it to
 * an in-memory buffer. The buffer is written as one multi-row `INSERT` when it
 * reaches a batch, or after a short interval, or when the module shuts down.
 * So a burst of traffic is a few inserts rather than one per attempt, and a
 * slow database never holds up an agent.
 *
 * The buffer is bounded. When it is full — the database has stopped keeping
 * up — new rows are **dropped and counted**, never queued without limit and
 * never awaited: an observation is one out of a thousand in a window, and the
 * call it describes has already been answered. A batch the database refuses
 * is dropped and counted the same way.
 */
@Injectable()
export class BindingAttemptRecorder implements OnModuleDestroy {
  private readonly logger = new Logger(BindingAttemptRecorder.name);
  private readonly options: AttemptBufferOptions;
  private buffer: BindingAttemptInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private droppedRows = 0;

  constructor(
    private readonly attempts: BindingAttemptRepository,
    @Optional() @Inject(ATTEMPT_BUFFER_OPTIONS) options: AttemptBufferOptions | null = null,
  ) {
    this.options = options ?? DEFAULT_ATTEMPT_BUFFER;
  }

  /** Attribute one attempt and buffer it if it counts. Never throws, never waits. */
  record(attempt: ObservedAttempt): void {
    const { binding, classification } = attempt;
    try {
      const attribution = attributeAttempt({
        responseClass: classification.responseClass,
        reason: classification.reason,
        providerId: binding.providerId,
        buyerOrganizationId: attempt.buyerOrganizationId,
        callClass: attempt.callClass,
        elapsedMs: attempt.elapsedMs,
        timeoutMs: attempt.timeoutMs,
        maxBudgetMs: attempt.maxBudgetMs,
      });
      if (!attribution.counted || !attempt.buyerOrganizationId) return;

      if (this.buffer.length >= this.options.capacity) {
        this.drop(1, 'buffer full');
        return;
      }
      this.buffer.push({
        bindingId: binding.id,
        providerId: binding.providerId,
        buyerOrganizationId: attempt.buyerOrganizationId,
        callClass: attempt.callClass ?? null,
        available: attribution.available,
        latencyMs: attribution.latencyMs,
        reason: classification.reason,
      });

      if (this.buffer.length >= this.options.batchSize) {
        void this.flush();
      } else {
        this.schedule();
      }
    } catch (error) {
      this.logger.warn(`binding ${binding.id}: attempt not recorded. ${describe(error)}`);
    }
  }

  /** Write everything buffered. One flush at a time; a second caller waits for it and then drains. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) await this.flushing;
    if (this.buffer.length === 0) return;

    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  /** Rows dropped since start — the buffer was full, or the database refused a batch. */
  get dropped(): number {
    return this.droppedRows;
  }

  /** Whatever is still buffered is written before the process goes. */
  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.options.batchSize);
      try {
        await this.attempts.appendMany(batch);
      } catch (error) {
        this.drop(batch.length, describe(error));
      }
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.flushIntervalMs);
    // A pending flush must not keep a process (or a test) alive by itself.
    this.timer.unref?.();
  }

  private drop(rows: number, why: string): void {
    const before = this.droppedRows;
    this.droppedRows += rows;
    // The first drop, then one line per thousand, so a sustained outage is
    // visible without one log line per call.
    if (before === 0 || Math.floor(before / 1000) !== Math.floor(this.droppedRows / 1000)) {
      this.logger.warn(
        `${rows} attempt row(s) dropped (${why}); ${this.droppedRows} dropped since start. ` +
          `Binding stats will read slightly thin.`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
