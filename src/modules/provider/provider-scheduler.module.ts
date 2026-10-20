import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChainsModule } from '@modules/chains/chains.module';
import { NotificationModule } from '@modules/notification/notification.module';

import { BindingStatsRefreshJob } from './jobs/binding-stats-refresh.job';
import { StakeMonitorJob } from './jobs/stake-monitor.job';
import {
  STAKE_GRACE_PERIOD_MS,
  STAKE_HEADROOM_WARNING_RATIO,
  STAKE_MONITOR_CONFIG,
} from './constants/stake-monitor.constants';
import { ProviderModule } from './provider.module';
import { SlaWindowModule } from './sla-window.module';
import { SlaWindowSweepJob } from './jobs/sla-window-sweep.job';
import {
  PROVIDER_MINIMUM_STAKE_PARAMETERS,
  loadMinimumStakeParameters,
} from './services/provider-stake.service';
import { BindingStatsService } from './services/binding-stats.service';
import { StakeMonitorService } from './services/stake-monitor.service';

/**
 * Scheduler-only half of the stake lifecycle — the stake monitor.
 *
 * Registered here and nowhere else, for the reason `docs/architecture.md`
 * §Scaling Design gives: the scheduler is a single instance, so the 5-minute
 * pass happens once per deployment. N API replicas running it would each race
 * to open the same grace row.
 *
 * `ProviderModule` supplies `PROVIDER_STAKE_SOURCE` — the same port the router
 * gates on, which is what makes a grace row open exactly when routing would
 * otherwise have cut the binding. `ChainsModule` supplies `ONCHAIN_STAKE_READER`.
 * `AlertingModule` is `@Global()` and already instantiated by the scheduler
 * bootstrap; the repositories arrive with `PostgresModule`, which is `@Global()`
 * too.
 *
 * `PROVIDER_MINIMUM_STAKE_PARAMETERS` is provided again here rather than
 * imported, with the same factory `ProviderApiModule` uses. That duplication is
 * the one `ProviderStakeService` already documents: `ToolModule` builds the
 * identical value as `ROUTER_CONFIG` and does not export it. Three copies of
 * one factory is worse than two, and is worth fixing the day `ToolModule`
 * exports the token — but not by adding a fourth source of truth here.
 */
@Module({
  // `NotificationModule`: `StakeMonitorService` emits on both
  // `AlertPort` and `NotificationPort` at all three grace/headroom sites.
  // Imported directly here, not through `ProviderModule`, so the queue this
  // module carries stays out of `ToolModule`'s graph — see `provider.module.ts`'s
  // own comment.
  imports: [ProviderModule, ChainsModule, NotificationModule],
  providers: [
    {
      provide: PROVIDER_MINIMUM_STAKE_PARAMETERS,
      useFactory: loadMinimumStakeParameters,
      inject: [ConfigService],
    },
    {
      provide: STAKE_MONITOR_CONFIG,
      // `now` as a function, in the kill-switch style, so a test can stand a
      // grace period one second past its deadline instead of waiting a week.
      useValue: {
        gracePeriodMs: STAKE_GRACE_PERIOD_MS,
        headroomWarningRatio: STAKE_HEADROOM_WARNING_RATIO,
        now: () => Date.now(),
      },
    },
    StakeMonitorService,
    StakeMonitorJob,
  ],
})
export class ProviderStakeMonitorSchedulerModule {}

/**
 * Scheduler-only half of the SLA windows — the age sweep.
 *
 * Its own module, next to `ProviderStakeMonitorSchedulerModule`: the two share
 * nothing but the process, and this one's whole dependency is `SlaWindowModule`
 * — no vault, no ledger, no reconciler.
 *
 * Registered here and nowhere else, for the reason `docs/architecture.md`
 * §Scaling Design gives and `StakeMonitorJob`'s own comment restates: the
 * scheduler is a single instance, so the five-minute pass happens once per
 * deployment. N API replicas running it would each race to close the same
 * overdue window — the CAS in `closeIfOpen` would let one win, but the other
 * N−1 would waste a query and, on a breach, a strike-insert attempt every
 * single pass for nothing.
 */
@Module({
  imports: [SlaWindowModule],
  providers: [SlaWindowSweepJob],
})
export class ProviderSlaWindowSweepSchedulerModule {}

/**
 * Scheduler-only half of the observed stats — the five-minute refresh of
 * `binding_stats` from `binding_attempts` and the verdicts.
 *
 * Here and nowhere else for the reason the two modules above give: one pass
 * per deployment. `ProviderModule` supplies `BINDING_STATS_CONFIG`, the same
 * value `DbProviderRegistry` reads its minimum sample from; the repositories
 * arrive with the `@Global()` `PostgresModule`.
 */
@Module({
  imports: [ProviderModule],
  providers: [BindingStatsService, BindingStatsRefreshJob],
})
export class ProviderBindingStatsSchedulerModule {}
