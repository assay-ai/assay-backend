import { ReconciliationRunEntity } from '@database/postgres/entities/reconciliation-run.entity';
import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { ObservabilityMetricsRepository } from '@modules/observability/repositories/observability-metrics.repository';

/**
 * Hand-written fakes for {@link MetricsCollectorService}'s dependencies, in
 * the house style documented in `test/unit/provider/stake-monitor.service.spec.ts`
 * and reused by `test/unit/operator/helpers/fake-metrics.ts`: plain objects
 * with `jest.fn()` methods, cast to the concrete class rather than run
 * through a NestJS `TestingModule` or a `jest.mock(...)` of the repository.
 *
 * `PlatformMetricsRepository` and `SlashProposalRepository` are **not**
 * re-faked here — `test/unit/operator/helpers/fake-metrics.ts` already fakes
 * both for the same two methods this collector reuses
 * (`verificationBacklog`/`intentRateCounts`, `falsePositiveCounts`); the spec
 * imports those directly rather than authoring a second fake for the same
 * repository, per the house rule.
 */

export function fakeReconciliationRunRepository(
  runs: Array<Partial<ReconciliationRunEntity>> = [],
): ReconciliationRunRepository {
  return {
    findLatestPerAsset: jest.fn().mockResolvedValue(runs as ReconciliationRunEntity[]),
  } as unknown as ReconciliationRunRepository;
}

export interface FakeObservabilityOverrides {
  toolCallSuccessRate?: { total: number; nonSystemError: number };
  failRateByPolicy?: Array<{
    policyId: string;
    policyVersion: number;
    total: number;
    fail: number;
  }>;
  settlementLagP95Seconds?: number | null;
  openHoldAge?: { count: number; oldestAgeSeconds: number | null };
  attestationsSigned?: number;
  slashesExecuted?: number;
}

/** Every method defaults to the "empty database" answer — no calls, no rows, nothing null-crashing. */
export function fakeObservabilityMetricsRepository(
  overrides: FakeObservabilityOverrides = {},
): ObservabilityMetricsRepository {
  return {
    toolCallSuccessRate: jest
      .fn()
      .mockResolvedValue(overrides.toolCallSuccessRate ?? { total: 0, nonSystemError: 0 }),
    failRateByPolicy: jest.fn().mockResolvedValue(overrides.failRateByPolicy ?? []),
    settlementLagP95Seconds: jest.fn().mockResolvedValue(overrides.settlementLagP95Seconds ?? null),
    openHoldAge: jest
      .fn()
      .mockResolvedValue(overrides.openHoldAge ?? { count: 0, oldestAgeSeconds: null }),
    attestationsSigned: jest.fn().mockResolvedValue(overrides.attestationsSigned ?? 0),
    slashesExecuted: jest.fn().mockResolvedValue(overrides.slashesExecuted ?? 0),
  } as unknown as ObservabilityMetricsRepository;
}
