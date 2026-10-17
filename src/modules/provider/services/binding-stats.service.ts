import { Inject, Injectable, Logger } from '@nestjs/common';

import { BindingAttemptRepository } from '@database/postgres/repositories/binding-attempt.repository';
import { BindingStatsRepository } from '@database/postgres/repositories/binding-stats.repository';
import { VERDICT_CONSEQUENCE, VerdictStatus } from '@modules/verification/domain/verdict';

import { BINDING_STATS_CONFIG, BindingStatsConfig } from '../constants/binding-stats.constants';
import { mergeWindows } from '../domain/stats/binding-stats';

/**
 * The verdicts that move the quality metric — `PASS` and `FAIL` — derived
 * from the settlement table rather than restated, the same rule
 * `countsTowardWindow` follows for the SLA window. Coverage, misapplication,
 * degraded and skipped verdicts say nothing about whether the provider's data
 * was right.
 */
const QUALITY_STATUSES: readonly string[] = Object.values(VerdictStatus).filter(
  (status) => VERDICT_CONSEQUENCE[status].metric === 'quality',
);

export interface BindingStatsRefreshResult {
  readonly bindings: number;
  readonly pruned: number;
}

/**
 * The stats refresh: `binding_attempts` and `verification_records` →
 * `binding_stats`.
 *
 * ```text
 *   prune   binding_attempts outside the window (older than 7 days, past the last N)
 *   read    each binding's attempt window      ─┐  two aggregate statements,
 *   read    each binding's last N verdicts     ─┘  not one per binding
 *   write   binding_stats, replaced whole, in one transaction
 * ```
 *
 * A plain service so a test can drive it; `BindingStatsRefreshJob` is the
 * cron. It runs in the scheduler only, once per deployment — N API replicas
 * would each recompute the same snapshot.
 *
 * The snapshot survives restarts because it is a table; the router never
 * computes a window on its hot path, it reads this snapshot in the batch
 * `DbProviderRegistry` already issues.
 */
@Injectable()
export class BindingStatsService {
  private readonly logger = new Logger(BindingStatsService.name);

  constructor(
    private readonly attempts: BindingAttemptRepository,
    private readonly stats: BindingStatsRepository,
    @Inject(BINDING_STATS_CONFIG) private readonly config: BindingStatsConfig,
  ) {}

  async refresh(now: Date = new Date()): Promise<BindingStatsRefreshResult> {
    const since = new Date(now.getTime() - this.config.maxAgeMs);

    // Prune first, so the table the aggregate reads is the window itself.
    const pruned = await this.attempts.prune(this.config.windowSize, since);

    const [attemptWindows, verdictWindows] = await Promise.all([
      this.attempts.aggregateWindows(this.config.windowSize, since),
      this.stats.aggregateVerdictWindows({
        windowSize: this.config.windowSize,
        since,
        qualityStatuses: QUALITY_STATUSES,
        passStatus: VerdictStatus.PASS,
      }),
    ]);

    const windows = mergeWindows(attemptWindows, verdictWindows);
    await this.stats.replaceAll(windows, now);

    this.logger.debug(`binding stats refreshed: ${windows.length} binding(s), ${pruned} pruned`);
    return { bindings: windows.length, pruned };
  }
}
