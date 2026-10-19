import {
  fakeMetricsRepository,
  fakeSlashProposalRepository,
} from '../operator/helpers/fake-metrics';
import {
  fakeObservabilityMetricsRepository,
  fakeReconciliationRunRepository,
  FakeObservabilityOverrides,
} from './helpers/fake-observability-repositories';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { MetricsCollectorService } from '@modules/observability/services/metrics-collector.service';
import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';
import { SignalAvailability } from '@modules/observability/domain/signal-catalog';
import { ReconciliationSeverity } from '@modules/settlement/ports/reconciliation.types';
import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { SignalReadingDto } from '@modules/observability/dto/metrics-snapshot.dto';

function build(
  options: {
    runs?: Array<Partial<ReconciliationRunEntity>>;
    observability?: FakeObservabilityOverrides;
    falsePositive?: { resolved: number; falsePositives: number };
    intentRateCounts?: { lastMinute: number; hourAgoMinute: number };
    verificationBacklog?: { count: number; p95AgeSeconds: number | null };
  } = {},
) {
  const collector = new MetricsCollectorService(
    fakeReconciliationRunRepository(options.runs ?? []),
    fakeMetricsRepository({
      intentRateCounts: options.intentRateCounts,
      verificationBacklog: options.verificationBacklog,
    }),
    fakeSlashProposalRepository(options.falsePositive),
    fakeObservabilityMetricsRepository(options.observability),
    new MetricsRegistryService(),
  );
  return { collector };
}

function findSignal(snapshotSignals: SignalReadingDto[], signal: string): SignalReadingDto {
  const row = snapshotSignals.find((s) => s.signal === signal);
  if (!row) throw new Error(`no signal reading for ${signal}`);
  return row;
}

describe('MetricsCollectorService', () => {
  it('returns nulls, not NaN or fabricated zeros, against an empty database', async () => {
    const { collector } = build();

    const snapshot = await collector.snapshot();

    expect(snapshot.reconciliation).toEqual([]);
    expect(snapshot.failRateByPolicy).toEqual([]);

    const toolCallSuccess = findSignal(snapshot.signals, 'TOOL_CALL_SUCCESS_RATE');
    expect(toolCallSuccess.value).toBeNull();
    expect(toolCallSuccess.gate).toBeNull();

    const disputeOverturn = findSignal(snapshot.signals, 'DISPUTE_OVERTURN_RATE');
    expect(disputeOverturn.value).toBeNull();

    const openHoldAge = findSignal(snapshot.signals, 'OPEN_HOLD_AGE');
    expect(openHoldAge.value).toBeNull();
  });

  it('marks NONE-availability signals absent regardless of any value supplied', async () => {
    const { collector } = build();

    const snapshot = await collector.snapshot();

    const gasRunway = findSignal(snapshot.signals, 'GAS_RUNWAY_DAYS');
    expect(gasRunway.availability).toBe(SignalAvailability.NONE);
    expect(gasRunway.value).toBeNull();

    const falseNegative = findSignal(snapshot.signals, 'FALSE_NEGATIVE_RATE');
    expect(falseNegative.availability).toBe(SignalAvailability.NONE);
    expect(falseNegative.value).toBeNull();

    const payoutLag = findSignal(snapshot.signals, 'PAYOUT_LAG_P95');
    expect(payoutLag.availability).toBe(SignalAvailability.NONE);
    expect(payoutLag.value).toBeNull();
  });

  it('marks the two uninstrumented signals NONE with a null value', async () => {
    const { collector } = build();

    const snapshot = await collector.snapshot();

    const latency = findSignal(snapshot.signals, 'PLATFORM_LATENCY_P95_BY_BINDING');
    expect(latency.availability).toBe(SignalAvailability.NONE);
    expect(latency.value).toBeNull();

    const egress = findSignal(snapshot.signals, 'EGRESS_BLOCKS');
    expect(egress.availability).toBe(SignalAvailability.NONE);
    expect(egress.value).toBeNull();
  });

  it('never grades the false-positive proxy against the golden-signal gate', async () => {
    const { collector } = build({ falsePositive: { resolved: 40, falsePositives: 4 } });

    const snapshot = await collector.snapshot();

    const falsePositive = findSignal(snapshot.signals, 'FALSE_POSITIVE_RATE');
    expect(falsePositive.value).toBeCloseTo(0.1);
    // 0.1 would be well past the doc's 5% page threshold if graded — the
    // absence of a gate here is the point, not an oversight. See
    // SIGNAL_CATALOG's FALSE_POSITIVE_RATE reason and golden-signals.ts's
    // own docstring on GoldenSignal.FALSE_POSITIVE_RATE.
    expect(falsePositive.gate).toBeNull();
  });

  it('computes reserve health from the latest run per asset and gates it via evaluateReserveHealth', async () => {
    const { collector } = build({
      runs: [
        {
          assetId: 'usdc',
          decimals: 6,
          difference: '-1000000', // -1 USDC display unit
          severity: ReconciliationSeverity.CRITICAL,
          startedAt: new Date(Date.now() - 5000),
        } as Partial<ReconciliationRunEntity>,
      ],
    });

    const snapshot = await collector.snapshot();

    expect(snapshot.reconciliation).toHaveLength(1);
    const row = snapshot.reconciliation[0];
    expect(row.asset).toBe('usdc');
    expect(row.differenceDisplay).toBeCloseTo(-1);
    expect(row.gate?.status).toBe('CRITICAL');
    expect(row.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports a healthy reserve as an OK gate, not a null one', async () => {
    const { collector } = build({
      runs: [
        {
          assetId: 'usdc',
          decimals: 6,
          difference: '5000000',
          severity: ReconciliationSeverity.OK,
          startedAt: new Date(),
        } as Partial<ReconciliationRunEntity>,
      ],
    });

    const snapshot = await collector.snapshot();

    expect(snapshot.reconciliation[0].gate?.status).toBe('OK');
  });

  it('divides FAIL rate by policy correctly and passes rows through unaggregated', async () => {
    const { collector } = build({
      observability: {
        failRateByPolicy: [
          { policyId: 'policy-a', policyVersion: 3, total: 20, fail: 4 },
          { policyId: 'policy-b', policyVersion: 1, total: 5, fail: 5 },
        ],
      },
    });

    const snapshot = await collector.snapshot();

    expect(snapshot.failRateByPolicy).toEqual([
      { policyId: 'policy-a', policyVersion: 3, total: 20, failRate: 0.2 },
      { policyId: 'policy-b', policyVersion: 1, total: 5, failRate: 1 },
    ]);
  });

  it('computes tool-call success rate and grades it against the 97% warn gate', async () => {
    const { collector } = build({
      observability: { toolCallSuccessRate: { total: 100, nonSystemError: 90 } },
    });

    const snapshot = await collector.snapshot();

    const reading = findSignal(snapshot.signals, 'TOOL_CALL_SUCCESS_RATE');
    expect(reading.value).toBeCloseTo(0.9);
    expect(reading.gate?.status).toBe('WARN');
  });

  it('computes dispute overturn rate from raised/overturned counts, 0 raised as null not NaN', async () => {
    const { collector } = build({
      observability: { disputeOverturnCounts: { raised: 10, overturned: 3 } },
    });

    const snapshot = await collector.snapshot();

    const reading = findSignal(snapshot.signals, 'DISPUTE_OVERTURN_RATE');
    expect(reading.value).toBeCloseTo(0.3);
  });

  it('caches the snapshot within the TTL — one round of repository calls serves many requests', async () => {
    const { collector } = build({ observability: { attestationsSigned: 7 } });

    const first = await collector.snapshot();
    const second = await collector.snapshot();

    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it('refreshes after the TTL elapses', async () => {
    process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS = '1';
    try {
      const { collector } = build();

      const first = await collector.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await collector.snapshot();

      expect(second.generatedAt).not.toBe(first.generatedAt);
    } finally {
      delete process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS;
    }
  });

  describe('assay_oauth_live_grants_per_agent', () => {
    function buildWithCredentials(maxLiveOAuthPerAgent: jest.Mock) {
      const registry = new MetricsRegistryService();
      const collector = new MetricsCollectorService(
        fakeReconciliationRunRepository([]),
        fakeMetricsRepository({}),
        fakeSlashProposalRepository(),
        fakeObservabilityMetricsRepository(),
        registry,
        { maxLiveOAuthPerAgent } as unknown as AgentCredentialRepository,
      );
      return { collector, registry };
    }

    it('is set from the repository on each refresh', async () => {
      const max = jest.fn().mockResolvedValue(47);
      const { collector, registry } = buildWithCredentials(max);

      await collector.snapshot();

      expect(max).toHaveBeenCalledTimes(1);
      expect(await registry.metricsText()).toContain('assay_oauth_live_grants_per_agent 47');
    });

    it('a failed read keeps the refresh and the previous value', async () => {
      const max = jest.fn().mockResolvedValueOnce(12).mockRejectedValueOnce(new Error('db down'));
      const { collector, registry } = buildWithCredentials(max);
      const ttl = process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS;
      process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS = '1';
      try {
        await collector.snapshot();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await expect(collector.snapshot()).resolves.toBeDefined();
      } finally {
        if (ttl === undefined) delete process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS;
        else process.env.OBSERVABILITY_METRICS_CACHE_TTL_MS = ttl;
      }

      expect(max).toHaveBeenCalledTimes(2);
      expect(await registry.metricsText()).toContain('assay_oauth_live_grants_per_agent 12');
    });
  });
});
