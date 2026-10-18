import { Module } from '@nestjs/common';

import { MetricsRegistryService } from './services/metrics-registry.service';

/**
 * The in-process metrics registry, and nothing else: no controller, no
 * collector, no operator guard. A process that records metrics without
 * serving the operator dashboard (the MCP app) imports this; the API app gets
 * it through `ObservabilityModule`, which re-exports it, so each container has
 * exactly one `MetricsRegistryService`.
 */
@Module({
  providers: [MetricsRegistryService],
  exports: [MetricsRegistryService],
})
export class MetricsRegistryModule {}
