import { Module } from '@nestjs/common';

import { OperatorIdentityModule } from '@modules/operator/operator-identity.module';

import { ObservabilityDashboardController } from './controllers/observability-dashboard.controller';
import { ObservabilityMetricsRepository } from './repositories/observability-metrics.repository';
import { MetricsCollectorService } from './services/metrics-collector.service';
import { MetricsRegistryService } from './services/metrics-registry.service';

/**
 * `GET /metrics` (Prometheus text) and `GET /operator/dashboard` (+ its JSON
 * twin).
 *
 * ## Dependencies this module leans on without importing them
 *
 * `ReconciliationRunRepository`, `PlatformMetricsRepository` and
 * `SlashProposalRepository` (all injected by `MetricsCollectorService`) come
 * from `PostgresModule`, which is `@Global()` — every bootstrap process that
 * already imports `DatabaseModule` has them, so this module does not
 * re-declare them. `OperatorIdentityModule` is **not** global (see its own
 * class doc: guards "resolve `OPERATOR_SESSION_SOURCE` from wherever this
 * module is imported"), so it is imported here explicitly — importing it a
 * second time alongside `OperatorApiModule` in the same process is exactly
 * what its docstring describes and NestJS deduplicates the module instance,
 * the same way `mcp.module.ts` is imported by both `bootstrap/api` and
 * `bootstrap/mcp` today.
 *
 * ## Where this belongs
 *
 * Wire this into `src/bootstrap/api/app.module.ts`'s `imports` array. That is
 * the only bootstrap process with both `DatabaseModule` and the operator
 * identity surface already present, and it is where `OperatorApiModule`
 * already lives — this dashboard is one more page in that same console, not
 * a new surface.
 *
 * The two in-process instruments (`MetricsRegistryService.recordEgressBlock`,
 * `.observePlatformLatency`) will only see traffic that runs inside whatever
 * process this module is mounted in. The live tool-call path
 * (`EgressBindingInvoker`, egress calls, provider round-trips) runs through
 * `ToolModule` — imported by `McpModule` — which the dedicated `mcp`
 * bootstrap process mounts via `McpHttpModule`. `bootstrap/api` also imports
 * `McpModule` directly today, so if that is the process actually serving
 * live tool calls, wiring this module into `api` alone is sufficient. If
 * traffic instead flows through the standalone `mcp` process, those two
 * instruments need this module (or a narrower one exporting just
 * `MetricsRegistryService` + `MetricsController`) imported into
 * `bootstrap/mcp/app.module.ts` too — every DB-backed gauge here already
 * works from either process, since both carry `DatabaseModule`. This module
 * does not decide that split; it is written so either wiring is a one-line
 * `imports` addition, not a rewrite.
 */
@Module({
  imports: [OperatorIdentityModule],
  providers: [MetricsRegistryService, MetricsCollectorService, ObservabilityMetricsRepository],
  // `GET /metrics` (MetricsController) is switched off on 2026-10-15: no Prometheus
  // scraper uses it. Re-enable by adding MetricsController back to this list.
  controllers: [ObservabilityDashboardController],
  exports: [MetricsRegistryService],
})
export class ObservabilityModule {}
