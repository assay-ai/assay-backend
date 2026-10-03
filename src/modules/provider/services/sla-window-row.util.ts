import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';

import { SlaWindowCounters, SlaWindowSnapshot } from '../domain/sla/sla-window';

/**
 * `sla_windows` row → the two pure-domain shapes `domain/sla/sla-window.ts`
 * takes.
 *
 * Shared between `SlaWindowService` (the write path) and
 * `ProviderSlaWindowsService` (the read path) so there is exactly one place
 * that knows a bigint-as-string column is `BigInt(...)` and a numeric-as-
 * string one is `Number(...)`, rather than two copies that could disagree
 * about which is which.
 */
export function snapshotFrom(window: SlaWindowEntity): SlaWindowSnapshot {
  return {
    declaredFailureRate: Number(window.declaredFailureRate),
    minVerifiedCalls: window.minVerifiedCalls,
    zScore: window.zScore,
    maxAgeMs: Number(window.maxAgeMs),
    warningRatio: window.warningRatio,
    warningMinSampleFraction: window.warningMinSampleFraction,
    penaltyMultiplier: window.penaltyMultiplier,
  };
}

export function countersFrom(window: SlaWindowEntity): SlaWindowCounters {
  return {
    totalCalls: window.totalCalls,
    verifiedCalls: window.verifiedCalls,
    failedCalls: window.failedCalls,
    totalCallAmount: BigInt(window.totalCallAmount),
  };
}
