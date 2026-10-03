import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  LEDGER_BATCH_SIZE,
  LEDGER_BUFFER_HARD_LIMIT,
  LEDGER_FLUSH_INTERVAL_MS,
  LEDGER_MAX_FLUSH_ATTEMPTS,
} from '../constants/ledger.constants';
import { isBufferable } from '../domain/ledger-entry-effect';
import { LedgerErrors } from '../errors/ledger.errors';
import { AppendEntryInput } from '../ports/ledger.types';
import { LedgerJournalService, PreparedEntry } from './ledger-journal.service';
import { runInLedgerTransaction } from './ledger-transaction.util';

/**
 * The batch writer.
 *
 * Batching exists to make the per-call cost of the ledger small enough that a
 * $0.01 tool call is viable. It is a throughput device and nothing else: it
 * changes *when* entries are written, never *whether* they are written
 * correctly.
 *
 * Two rules keep that true.
 *
 * **A batch is one transaction.** Five hundred entries and every balance they
 * move commit together or not at all. A partially applied batch is a set of
 * journal entries with no matching snapshot movement, which is a reconciliation
 * failure that no downstream process can repair without human judgement — so
 * the failure mode is "the batch did not happen", which a retry can fix.
 *
 * **Only entries that cannot reduce a balance may be buffered.** Anything that
 * debits — a hold, a payout, a withdrawal — needs the row lock and the
 * affordability check, and is refused here at the call site (`append`) rather
 * than 200ms later inside a flush, where it would take four hundred innocent
 * entries down with it.
 */
@Injectable()
export class LedgerWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LedgerWriterService.name);

  private timer: NodeJS.Timeout | null = null;

  private buffer: PreparedEntry[] = [];

  /**
   * Batches that failed `LEDGER_MAX_FLUSH_ATTEMPTS` times in a row and were set
   * aside so the buffer behind them could drain.
   *
   * Nothing in a quarantined batch was ever applied, so this is un-written
   * credit, not lost money: the reconciler re-derives it from chain state and
   * the intent record. It is kept in memory and counted so the condition is
   * visible rather than inferred from a gap in the journal.
   */
  private readonly quarantined: PreparedEntry[][] = [];

  private consecutiveFailures = 0;

  /**
   * Serialises flushes. Two overlapping flushes would each splice half the
   * buffer and race for the same balance locks — correct, but needlessly, and
   * the interval timer makes overlap likely under load rather than exotic.
   */
  private inFlight: Promise<number> = Promise.resolve(0);

  constructor(
    private readonly journal: LedgerJournalService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {}

  /**
   * Buffers an entry for the next flush.
   *
   * Validation happens now, not at flush time, so a bad entry fails the caller
   * that wrote it instead of the batch that inherited it.
   */
  append(input: AppendEntryInput): void {
    if (!isBufferable(input.entryType)) {
      throw LedgerErrors.entryNotBufferable({ entryType: input.entryType });
    }

    if (this.buffer.length >= LEDGER_BUFFER_HARD_LIMIT) {
      throw LedgerErrors.batchFlushFailed({
        size: this.buffer.length,
        cause: `buffer is at its hard limit of ${LEDGER_BUFFER_HARD_LIMIT}; the flusher is not keeping up`,
      });
    }

    this.buffer.push(this.journal.prepare(input));

    if (this.buffer.length >= LEDGER_BATCH_SIZE) {
      void this.flush().catch(() => {
        // Already logged and re-buffered by `flush`. Swallowed here because
        // `append` is synchronous and its caller cannot act on a failure that
        // belongs to an earlier batch.
      });
    }
  }

  /** Number of entries waiting to be written. Diagnostics and tests. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Writes the entire buffer as one transaction.
   *
   * On failure the batch is put **back** at the front of the buffer and the
   * error is raised. Nothing was applied, so re-queueing cannot double-apply,
   * and dropping it would silently lose provider earnings.
   */
  async flush(): Promise<number> {
    this.inFlight = this.inFlight.then(
      () => this.flushOnce(),
      () => this.flushOnce(),
    );
    return this.inFlight;
  }

  private async flushOnce(): Promise<number> {
    const batch = this.buffer.splice(0);
    if (batch.length === 0) {
      return 0;
    }

    const batchId = randomUUID();
    const stamped = batch.map((entry) => ({ ...entry, batchId }));

    // A batch may carry entries for several organizations. They are applied in
    // sorted organization order — inside ONE transaction, not one per
    // organization. Splitting per organization would mean a batch that failed
    // on its third organization had already committed the first two, and the
    // re-queue below would then apply those twice. All-or-nothing has to mean
    // the whole batch, not each slice of it.
    const byOrganization = new Map<string, PreparedEntry[]>();
    for (const entry of stamped) {
      const existing = byOrganization.get(entry.organizationId);
      if (existing) {
        existing.push(entry);
      } else {
        byOrganization.set(entry.organizationId, [entry]);
      }
    }
    // Sorted so two concurrent flushes touching the same organizations always
    // take their balance locks in the same order.
    const organizations = [...byOrganization.keys()].sort();

    try {
      const written = await runInLedgerTransaction(
        this.dataSource,
        async (queryRunner) => {
          let applied = 0;
          for (const organizationId of organizations) {
            const entries = await this.journal.applyEntries(
              queryRunner,
              organizationId,
              byOrganization.get(organizationId) as PreparedEntry[],
            );
            applied += entries.length;
          }
          return applied;
        },
        this.logger,
      );
      this.consecutiveFailures = 0;
      return written;
    } catch (error) {
      this.consecutiveFailures += 1;
      const cause = error instanceof Error ? error.message : String(error);

      if (this.consecutiveFailures >= LEDGER_MAX_FLUSH_ATTEMPTS) {
        // Retrying was right — nothing was applied, so a retry could not
        // double-apply. Retrying *forever* is not: this batch sits at the front
        // of the buffer and takes every healthy entry behind it down with it on
        // every attempt. Set it aside, loudly, and let the rest through.
        this.quarantined.push(batch);
        this.consecutiveFailures = 0;
        this.logger.error(
          `Ledger batch ${batchId} of ${batch.length} entries failed ${LEDGER_MAX_FLUSH_ATTEMPTS} times ` +
            `and was QUARANTINED; none of it was applied and the reconciler must re-derive it`,
          error instanceof Error ? error.stack : String(error),
        );
      } else {
        // Put it back, in order, ahead of anything appended while we were away.
        this.buffer.unshift(...batch);
        this.logger.error(
          `Ledger batch ${batchId} of ${batch.length} entries rolled back; re-queued ` +
            `(attempt ${this.consecutiveFailures}/${LEDGER_MAX_FLUSH_ATTEMPTS})`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      throw LedgerErrors.batchFlushFailed({ batchId, size: batch.length, cause });
    }
  }

  /** Entries set aside after repeated failure. Should always be zero. */
  get quarantinedCount(): number {
    return this.quarantined.reduce((total, batch) => total + batch.length, 0);
  }

  /** Hands the quarantined batches to a caller that intends to repair them. */
  drainQuarantine(): PreparedEntry[] {
    return this.quarantined.splice(0).flat();
  }

  /**
   * Starts the flush cadence.
   *
   * A plain `setInterval`, not `@Interval` from `@nestjs/schedule`, and not a
   * scheduler job. The buffer is **per process**: the API instance that
   * accepted a call is the only one holding that call's `PROVIDER_CREDIT` in
   * memory, so it is the only one that can write it. A single-instance
   * scheduler firing a flush would flush its own empty buffer while four API
   * instances sat on unwritten credit indefinitely.
   *
   * `unref()` so a ledger that is idle at shutdown does not hold the event loop
   * open — the flush on destroy is what makes that safe.
   */
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {
        // Logged, re-queued or quarantined by `flush`. The interval must not
        // die on a failed batch or the buffer stops draining entirely.
      });
    }, LEDGER_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Last chance to durably write what is still in memory. */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) {
      return;
    }
    try {
      await this.flush();
    } catch (error) {
      this.logger.error(
        `Shutdown flush failed with ${this.buffer.length} entries still buffered`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
