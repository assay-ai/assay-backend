import { Module } from '@nestjs/common';

import { OperatorIdentityModule } from '@modules/operator/operator-identity.module';

import { ObservabilityDashboardController } from './controllers/observability-dashboard.controller';
import { ObservabilityMetricsRepository } from './repositories/observability-metrics.repository';
import { MetricsCollectorService } from './services/metrics-collector.service';
import { OAuthSignalsReader } from './services/oauth-signals.reader';

/**
 * `GET /operator/dashboard` (+ its JSON twin). The OAuth signals read the
 * OAuth tables and the request-path counters `OAuthMetrics` writes to Redis
 * (`OAuthSignalsReader`); nothing here records metrics in process.
 *
 * `ReconciliationRunRepository`, `PlatformMetricsRepository` and
 * `SlashProposalRepository` (all injected by `MetricsCollectorService`) come
 * from `PostgresModule`, which is `@Global()`, so this module does not
 * re-declare them. `OperatorIdentityModule` is **not** global (its guards
 * resolve `OPERATOR_SESSION_SOURCE` from wherever it is imported), so it is
 * imported here explicitly; NestJS deduplicates it alongside
 * `OperatorApiModule` in the same process.
 */
@Module({
  imports: [OperatorIdentityModule],
  providers: [MetricsCollectorService, ObservabilityMetricsRepository, OAuthSignalsReader],
  controllers: [ObservabilityDashboardController],
})
export class ObservabilityModule {}
