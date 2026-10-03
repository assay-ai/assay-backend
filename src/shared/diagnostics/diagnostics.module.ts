import { Module } from '@nestjs/common';
import { ErrorShapeProbeController } from './error-shape-probe.controller';

/**
 * Diagnostics surface — exists to make the error contract verifiable against a
 * running server, not to serve product traffic.
 *
 * Gated by `areDiagnosticsEnabled()` in the api bootstrap: unset means on
 * outside production and off when `NODE_ENV=production`, so a route that
 * deliberately raises errors can never appear on a production surface by
 * forgetting a variable.
 */
@Module({
  controllers: [ErrorShapeProbeController],
})
export class DiagnosticsModule {}
