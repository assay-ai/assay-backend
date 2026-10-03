import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';
import { SlashOpenerModule } from '@modules/slash/slash-opener.module';
import { SLA_WINDOW_POSTER } from '@modules/verification/ports/sla-window-poster.port';

import { DEFAULT_SLA_WINDOW_CONFIG, SLA_WINDOW_CONFIG } from './constants/sla-window.constants';
import { SlaWindowService } from './services/sla-window.service';

/**
 * `SlaWindowService`, on its own.
 *
 * This is not a slice of `ProviderModule` — it is the answer to `settle()`'s
 * own instruction to make the dependency injectable "through a port interface
 * ... so `VerificationModule` does not gain a hard dependency on
 * `ProviderModule`". `VerificationModule` imports *this* module rather than
 * `ProviderModule`, and the graph stays acyclic because of what each side
 * needs:
 *
 * - `SlaWindowService` needs `SlaWindowRepository` / `SlaWindowCallRepository`
 *   / `SlaStrikeRepository` / `ToolBindingRepository` (all provided globally
 *   by `PostgresModule`), `NOTIFICATION_PORT` (imported directly, below —
 *   the same reason `ProviderModule`'s own comment gives for not re-exporting
 *   it: a BullMQ-backed module dragged into every consumer), and the two
 *   *pure functions* `VERDICT_CONSEQUENCE` / `isProviderAtFault` from
 *   `@modules/verification/domain/verdict` — a type-only import with no
 *   `Module` behind it, so it creates no edge in the DI graph.
 * - Nothing here imports `VerificationModule`, `ProviderModule`, or anything
 *   that imports either — so `VerificationModule → SlaWindowModule` closes no
 *   cycle, and `ProviderApiModule` / `ProviderStakeMonitorSchedulerModule`
 *   (which already import `NotificationModule` directly, on the same
 *   precedent) remain untouched.
 *
 * `ProviderSlaWindowSweepSchedulerModule` (`provider-scheduler.module.ts`)
 * imports this module too, for the age sweep's `@Cron` wrapper.
 */
@Module({
  // `SlashOpenerModule` is the slash-proposal satellite, imported here for the same
  // reason `VerificationModule` imports this one: a window closing in breach
  // must reach the proposal lifecycle without this module gaining an edge to
  // the operator identity, the override log or the chain executor.
  imports: [NotificationModule, SlashOpenerModule],
  providers: [
    { provide: SLA_WINDOW_CONFIG, useValue: DEFAULT_SLA_WINDOW_CONFIG },
    SlaWindowService,
    { provide: SLA_WINDOW_POSTER, useExisting: SlaWindowService },
  ],
  exports: [SlaWindowService, SLA_WINDOW_POSTER, SLA_WINDOW_CONFIG],
})
export class SlaWindowModule {}
