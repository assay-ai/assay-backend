import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';

describe('MetricsRegistryService', () => {
  it('constructs a second instance in the same process without throwing', () => {
    // The whole point of an own `Registry` per instance rather than
    // prom-client's process-global default — see the class doc. If this ever
    // regresses to `registers: [Registry.globalRegistry]` (the prom-client
    // default when `registers` is omitted), the second `new` here throws
    // "A metric with the name ... has already been registered."
    expect(() => {
      new MetricsRegistryService();
      new MetricsRegistryService();
    }).not.toThrow();
  });

  it("keeps two instances' metrics independent", async () => {
    const a = new MetricsRegistryService();
    const b = new MetricsRegistryService();

    a.recordEgressBlock('PRIVATE');

    const textA = await a.metricsText();
    const textB = await b.metricsText();

    expect(textA).toContain('x402_egress_blocked_total{reason="PRIVATE"} 1');
    // `b`'s definition (HELP/TYPE) is still present — every instance
    // registers the same metric names — but no *sample* line, since nothing
    // was ever recorded against it. That is the "absent, not zero" contract.
    expect(textB).not.toMatch(/x402_egress_blocked_total\{/);
  });

  it('records an egress block under its reason label', async () => {
    const registry = new MetricsRegistryService();

    registry.recordEgressBlock('LOOPBACK');
    registry.recordEgressBlock('LOOPBACK');
    registry.recordEgressBlock('PRIVATE');

    const text = await registry.metricsText();

    expect(text).toContain('x402_egress_blocked_total{reason="LOOPBACK"} 2');
    expect(text).toContain('x402_egress_blocked_total{reason="PRIVATE"} 1');
  });

  it('emits no series for a Counter/Histogram that was never recorded — the "absent, not zero" contract', async () => {
    const registry = new MetricsRegistryService();

    const text = await registry.metricsText();

    // HELP/TYPE lines are always emitted (they describe the metric, not a
    // sample); what must be absent is any line carrying a sample value.
    expect(text).not.toMatch(/x402_egress_blocked_total\{/);
    expect(text).not.toMatch(/x402_platform_added_latency_ms_bucket/);
  });

  it('observes platform-added latency into per-binding histogram buckets', async () => {
    const registry = new MetricsRegistryService();

    registry.observePlatformLatency('binding-a', 18);

    const text = await registry.metricsText();

    expect(text).toContain(
      'x402_platform_added_latency_ms_bucket{le="20",bindingId="binding-a"} 1',
    );
    expect(text).toContain('x402_platform_added_latency_ms_sum{bindingId="binding-a"} 18');
  });

  it('sets DB-backed gauges and reports them at their own value, not accumulated', async () => {
    const registry = new MetricsRegistryService();

    registry.falsePositiveRate.set(0.05);
    registry.falsePositiveRate.set(0.02);

    const text = await registry.metricsText();

    expect(text).toContain('x402_verification_false_positive_rate 0.02');
  });

  it('reports the signal-status gate gauge per labelled signal', async () => {
    const registry = new MetricsRegistryService();

    registry.signalStatus.labels('tool_call_success_rate').set(1);
    registry.signalStatus.labels('reserve_health:usdc').set(2);

    const text = await registry.metricsText();

    expect(text).toContain('x402_signal_status{signal="tool_call_success_rate"} 1');
    expect(text).toContain('x402_signal_status{signal="reserve_health:usdc"} 2');
  });
});
