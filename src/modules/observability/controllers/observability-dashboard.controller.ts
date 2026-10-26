import { Controller, Get, Header, UseGuards } from '@nestjs/common';

import { NoCacheHeader } from '@shared/decorators/cache-header.decorator';
import { RawResponse } from '@shared/decorators/raw-response.decorator';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentOperator, OperatorAuthGuard } from '@shared/auth';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';

import { MetricsSnapshotDto } from '../dto/metrics-snapshot.dto';
import { renderDashboardHtml } from '../services/dashboard-html.renderer';
import { MetricsCollectorService } from '../services/metrics-collector.service';

/**
 * `GET /operator/dashboard` and its JSON twin.
 *
 * Behind `OperatorAuthGuard`, same as `OperatorReferenceController` — the
 * frontend has no operator console (the operator surface is API-only), so
 * this is the only place a human looks at these numbers. No `@RequireRoles`, matching that controller's own rule: a read-only handler
 * with no metadata is open to any authenticated operator, and being blocked
 * from a dashboard would be noise, not a control.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard)
@Controller('operator')
export class ObservabilityDashboardController {
  constructor(private readonly collector: MetricsCollectorService) {}

  /**
   * `@NoCacheHeader()`, not `@Header('Cache-Control', 'no-store')`: Nest writes
   * a `@Header` before the interceptors run, and `CacheHeaderInterceptor` then
   * overwrote it with its `private, no-cache` default for an undecorated GET
   * (BUG-PROD-OPS-CORE-04). Operator-only numbers are never kept by the browser.
   */
  @NoCacheHeader()
  @Get('dashboard')
  @RawResponse()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'The Money and Traffic dashboard rows, server-rendered' })
  async getDashboard(@CurrentOperator() operator: OperatorSession): Promise<string> {
    const snapshot = await this.collector.snapshot();
    return renderDashboardHtml(snapshot, operator.displayName);
  }

  @NoCacheHeader()
  @Get('dashboard/data.json')
  @ApiOperation({ summary: 'The same numbers the dashboard renders, as JSON' })
  @ApiResponse({ status: 200, type: MetricsSnapshotDto })
  async getDashboardData(): Promise<MetricsSnapshotDto> {
    return this.collector.snapshot();
  }
}
