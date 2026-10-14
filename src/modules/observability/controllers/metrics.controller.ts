import { Controller, Get, Header, UseGuards } from '@nestjs/common';

import { RawResponse } from '@shared/decorators/raw-response.decorator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { OperatorAuthGuard } from '@shared/auth';

import { MetricsCollectorService } from '../services/metrics-collector.service';

/**
 * `GET /metrics` — Prometheus exposition format.
 *
 * ## Behind `OperatorAuthGuard`, not left open
 *
 * The Prometheus convention is a scrape endpoint with no per-request identity
 * at all — the same reasoning `HealthcheckController`'s `GET /health` follows.
 * That is where this controller started, but
 * `test/unit/shared/api/surface-consistency.spec.ts` enforces a **closed**
 * two-guard model for every controller on this surface (`SessionAuthGuard` or
 * `OperatorAuthGuard`, via a name-by-name allowlist for the operator side) with
 * exactly two hard-coded exceptions — `HealthcheckController` and the
 * error-shape probe — and extending that exception list is a change to the
 * test's own filtering logic, not the one-line allowlist addition its
 * `OPERATOR_SURFACE` docstring describes as the expected workflow for a new
 * operator route. So `/metrics` sits behind the same guard as
 * `ObservabilityDashboardController` instead: a scrape config now needs an
 * operator session token (a wallet sign-in, `POST /operator/auth/verify`, which
 * expires within hours — so a long-running scraper cannot hold one), which is unusual for a
 * Prometheus target but keeps this codebase's one authorization rule
 * genuinely closed rather than growing a third informal exception. Revisiting
 * this — e.g. adding a dedicated "unauthenticated infra route" allowlist to
 * the surface test — is a one-line change away, but is that test's call to
 * make, not this controller's.
 *
 * Nothing exposed here is per-user or per-request data regardless: every
 * series is a platform-wide aggregate, the same shape `PlatformHealthService`
 * already serves at `GET /operator/health`.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard)
@Controller('metrics')
export class MetricsController {
  constructor(private readonly collector: MetricsCollectorService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  // `prom-client`'s `Registry` always defaults to `PROMETHEUS_CONTENT_TYPE`
  // (`text/plain; version=0.0.4; charset=utf-8`, prom-client v15's fixed
  // constant) — this repository never sets `OPENMETRICS_CONTENT_TYPE`, so
  // hard-coding it here is the same string `collector.contentType` would
  // give, without `@Header` needing a per-request value it cannot compute.
  @RawResponse()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Prometheus exposition text for every x402_* series' })
  async getMetrics(): Promise<string> {
    return this.collector.metricsText();
  }
}
