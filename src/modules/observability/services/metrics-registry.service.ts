import { Injectable } from '@nestjs/common';
import { Gauge, Registry } from 'prom-client';

/**
 * The in-process registry the OAuth metrics of spec §6.7 record into.
 *
 * The operator dashboard reads its figures from `MetricsCollectorService`'s
 * JSON snapshot, not from here. This class only holds the OAuth counters
 * (`OAuthMetrics` registers them on `registry`) and the one DB-backed OAuth
 * gauge below, which `MetricsCollectorService` sets on each refresh.
 *
 * ## Its own `Registry`, never `prom-client`'s default
 *
 * `prom-client`'s default registry is a process-global singleton: registering
 * a metric with the same name against it twice throws, which is what happens
 * the moment a second `TestingModule` (or a second `new
 * MetricsRegistryService()` in a unit test) constructs this class in the same
 * Jest worker. Every metric is created with `registers: [this.registry]`, so
 * each instance owns a private `Registry`.
 */
@Injectable()
export class MetricsRegistryService {
  readonly registry = new Registry();

  /**
   * Spec §6.7: the largest number of live OAuth grants held by one agent,
   * against the cap of 50 (`OAUTH_MAX_LIVE_GRANTS_PER_AGENT`).
   */
  readonly oauthLiveGrantsPerAgent = new Gauge({
    name: 'assay_oauth_live_grants_per_agent',
    help: 'The largest number of live OAuth credentials held by one agent. Alert: >= 45.',
    registers: [this.registry],
  });

  /** The registry in the Prometheus text exposition format. */
  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
