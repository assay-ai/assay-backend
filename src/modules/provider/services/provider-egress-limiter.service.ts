import { Inject, Injectable, Optional } from '@nestjs/common';

import { ProviderErrors } from '../errors/provider.errors';

/**
 * How many provider-triggered outbound calls — mapping tester runs and
 * connectivity checks — may run at once, and how often.
 *
 * Both run inside the API process, on a URL the provider typed, and each can
 * hold a socket and a multi-megabyte buffer until its deadline. Without a
 * bound, one account firing requests in parallel is a memory DoS on the API,
 * and an unthrottled proxy from the platform's egress IPs to any public host.
 */
export interface ProviderEgressLimits {
  /** Calls one organization may have in flight. */
  readonly perOrganizationConcurrent: number;
  /** Mapping tester runs the whole process may have in flight. */
  readonly globalConcurrent: number;
  /**
   * Connectivity checks the whole process may have in flight — a pool of its
   * own, so tester runs held open to a slow endpoint (up to 30 s each) cannot
   * also deny every other provider "Check we can reach it" (review N-3). A
   * check has a 10 s budget and a tiny body, so its slots are cheap.
   */
  readonly globalConnectivityConcurrent: number;
  /**
   * Connectivity checks one organization may have in flight, inside
   * {@link perOrganizationConcurrent}. One, so filling the connectivity pool
   * takes as many accounts as it has slots (round-two review R2-4).
   */
  readonly perOrganizationConnectivityConcurrent: number;
  /** Calls one organization may start per {@link windowMs}. */
  readonly perOrganizationPerWindow: number;
  readonly windowMs: number;
}

export const DEFAULT_PROVIDER_EGRESS_LIMITS: ProviderEgressLimits = Object.freeze({
  perOrganizationConcurrent: 2,
  // ~15 MB per tester slot at most; 16 takes eight accounts to fill (N-3).
  globalConcurrent: 16,
  // One check per organization: sixteen accounts to fill it (R2-4).
  globalConnectivityConcurrent: 16,
  perOrganizationConnectivityConcurrent: 1,
  perOrganizationPerWindow: 20,
  windowMs: 60_000,
});

export const PROVIDER_EGRESS_LIMITS = Symbol('PROVIDER_EGRESS_LIMITS');

/** Which process-wide pool a run takes its slot from. */
export type ProviderEgressPool = 'tester' | 'connectivity';

/**
 * In-process: the state lives in this API replica only. That is the right
 * scope for the memory bound — it is this process's heap being protected —
 * and with N replicas it lets an organization through N times the rate,
 * which is still a bound.
 */
@Injectable()
export class ProviderEgressLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly connectivityInFlight = new Map<string, number>();
  private readonly started = new Map<string, number[]>();
  private readonly total: Record<ProviderEgressPool, number> = { tester: 0, connectivity: 0 };

  constructor(
    @Optional()
    @Inject(PROVIDER_EGRESS_LIMITS)
    private readonly limits: ProviderEgressLimits = DEFAULT_PROVIDER_EGRESS_LIMITS,
  ) {}

  /**
   * Run `work` under the limits, or throw `PROVIDER_EGRESS_RATE_LIMITED`
   * without running it. The per-organization limits count both pools.
   */
  async run<T>(
    organizationId: string,
    work: () => Promise<T>,
    pool: ProviderEgressPool = 'tester',
  ): Promise<T> {
    const limits = this.limits ?? DEFAULT_PROVIDER_EGRESS_LIMITS;
    const now = Date.now();
    const recent = (this.started.get(organizationId) ?? []).filter(
      (at) => now - at < limits.windowMs,
    );
    const active = this.inFlight.get(organizationId) ?? 0;

    if (recent.length >= limits.perOrganizationPerWindow) {
      throw ProviderErrors.egressRateLimited({ reason: 'per-minute limit' });
    }
    if (active >= limits.perOrganizationConcurrent) {
      throw ProviderErrors.egressRateLimited({
        reason: 'too many in flight for this organization',
      });
    }
    const checking = this.connectivityInFlight.get(organizationId) ?? 0;
    if (pool === 'connectivity' && checking >= limits.perOrganizationConnectivityConcurrent) {
      throw ProviderErrors.egressRateLimited({
        reason: 'a connectivity check is already running for this organization',
      });
    }
    const poolLimit =
      pool === 'connectivity' ? limits.globalConnectivityConcurrent : limits.globalConcurrent;
    if (this.total[pool] >= poolLimit) {
      throw ProviderErrors.egressRateLimited({ reason: 'the platform is busy' });
    }

    recent.push(now);
    this.started.set(organizationId, recent);
    this.inFlight.set(organizationId, active + 1);
    this.total[pool] += 1;
    if (pool === 'connectivity') this.connectivityInFlight.set(organizationId, checking + 1);

    try {
      return await work();
    } finally {
      this.total[pool] -= 1;
      if (pool === 'connectivity') {
        const checks = (this.connectivityInFlight.get(organizationId) ?? 1) - 1;
        if (checks > 0) this.connectivityInFlight.set(organizationId, checks);
        else this.connectivityInFlight.delete(organizationId);
      }
      const left = (this.inFlight.get(organizationId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(organizationId, left);
      else this.inFlight.delete(organizationId);
    }
  }
}
