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
  /** Calls the whole process may have in flight. */
  readonly globalConcurrent: number;
  /** Calls one organization may start per {@link windowMs}. */
  readonly perOrganizationPerWindow: number;
  readonly windowMs: number;
}

export const DEFAULT_PROVIDER_EGRESS_LIMITS: ProviderEgressLimits = Object.freeze({
  perOrganizationConcurrent: 2,
  globalConcurrent: 8,
  perOrganizationPerWindow: 20,
  windowMs: 60_000,
});

export const PROVIDER_EGRESS_LIMITS = Symbol('PROVIDER_EGRESS_LIMITS');

/**
 * In-process: the state lives in this API replica only. That is the right
 * scope for the memory bound — it is this process's heap being protected —
 * and with N replicas it lets an organization through N times the rate,
 * which is still a bound.
 */
@Injectable()
export class ProviderEgressLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly started = new Map<string, number[]>();
  private total = 0;

  constructor(
    @Optional()
    @Inject(PROVIDER_EGRESS_LIMITS)
    private readonly limits: ProviderEgressLimits = DEFAULT_PROVIDER_EGRESS_LIMITS,
  ) {}

  /** Run `work` under the limits, or throw `PROVIDER_EGRESS_RATE_LIMITED` without running it. */
  async run<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
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
    if (this.total >= limits.globalConcurrent) {
      throw ProviderErrors.egressRateLimited({ reason: 'the platform is busy' });
    }

    recent.push(now);
    this.started.set(organizationId, recent);
    this.inFlight.set(organizationId, active + 1);
    this.total += 1;

    try {
      return await work();
    } finally {
      this.total -= 1;
      const left = (this.inFlight.get(organizationId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(organizationId, left);
      else this.inFlight.delete(organizationId);
    }
  }
}
