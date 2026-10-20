import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';
import {
  SHARED_WINDOW_RETRY_MS,
  SLOT_COMMANDS,
  SLOT_COUNT_OFFSET,
  queueSlot,
  releaseSlot,
} from '@shared/rate-limit/shared-rate-windows';

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
 * How long a run's slot in Redis lasts if it is never given back: longer than
 * any run (a tester run has a 30 s deadline), so a replica that died mid-run,
 * or a release lost with Redis, frees the slot on its own. Each slot expires
 * by its own score; retries do not extend it.
 */
export const EGRESS_SLOT_TTL_MS = 2 * 60_000;

/**
 * Two kinds of state, kept where each one means something:
 *
 * - **Per organization** (the per-minute starts, the in-flight count, the one
 *   connectivity check) in Redis, so the bound holds across API replicas: in
 *   process, N replicas let an organization through N times the rate and N
 *   times the concurrency. One `MULTI` counts the start and takes the run's
 *   slots (sorted-set members scored by expiry, `queueSlot`); past a limit
 *   they are given back and the run refused. The
 *   minute is a fixed window (its index is in the key), not the sliding one
 *   the in-process fallback keeps.
 * - **Per process** (the tester and connectivity pools) in memory, always:
 *   what they protect is this replica's heap and sockets.
 *
 * When Redis does not answer within `withRedisTimeout`'s deadline, the
 * per-organization counts fall back to this process's own, as they were
 * before, and Redis is skipped for {@link SHARED_WINDOW_RETRY_MS}: provider
 * testing keeps working, bounded per replica. A slot whose release was lost
 * frees itself {@link EGRESS_SLOT_TTL_MS} after it was taken.
 */
@Injectable()
export class ProviderEgressLimiter {
  private readonly logger = new Logger(ProviderEgressLimiter.name);
  private readonly inFlight = new Map<string, number>();
  private readonly connectivityInFlight = new Map<string, number>();
  private readonly started = new Map<string, number[]>();
  private readonly total: Record<ProviderEgressPool, number> = { tester: 0, connectivity: 0 };
  private skipSharedUntil = Number.NEGATIVE_INFINITY;
  private lastFallbackWarnAt = Number.NEGATIVE_INFINITY;

  /** The clock; a field rather than a constructor parameter so DI has nothing to resolve. */
  now: () => number = Date.now;

  constructor(
    @Optional()
    @Inject(PROVIDER_EGRESS_LIMITS)
    private readonly limits: ProviderEgressLimits = DEFAULT_PROVIDER_EGRESS_LIMITS,
    @Optional() @Inject(REDIS_CACHE_CLIENT) private readonly redis?: Redis,
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
    const poolLimit =
      pool === 'connectivity' ? limits.globalConnectivityConcurrent : limits.globalConcurrent;
    if (this.total[pool] >= poolLimit) {
      throw ProviderErrors.egressRateLimited({ reason: 'the platform is busy' });
    }
    // Reserved before the organization's counts are awaited, so two runs
    // cannot both pass the pool check while the first is still asking Redis.
    this.total[pool] += 1;

    let release: () => void;
    try {
      release = await this.acquire(organizationId, pool, limits);
    } catch (error) {
      this.total[pool] -= 1;
      throw error;
    }

    try {
      return await work();
    } finally {
      this.total[pool] -= 1;
      release();
    }
  }

  private async acquire(
    organizationId: string,
    pool: ProviderEgressPool,
    limits: ProviderEgressLimits,
  ): Promise<() => void> {
    const now = this.now();
    if (this.redis && now >= this.skipSharedUntil) {
      let shared: (() => void) | string;
      try {
        shared = await this.acquireShared(this.redis, organizationId, pool, limits, now);
      } catch (error) {
        this.sharedFailed(now, error);
        return this.acquireLocal(organizationId, pool, limits, now);
      }
      if (typeof shared === 'string') throw ProviderErrors.egressRateLimited({ reason: shared });
      return shared;
    }
    return this.acquireLocal(organizationId, pool, limits, now);
  }

  private async acquireShared(
    redis: Redis,
    organizationId: string,
    pool: ProviderEgressPool,
    limits: ProviderEgressLimits,
    now: number,
  ): Promise<(() => void) | string> {
    const windowKey = `rate:egress:window:${organizationId}:${Math.floor(now / limits.windowMs)}`;
    const inFlightKey = `rate:egress:in-flight:${organizationId}`;
    const checkKey = `rate:egress:connectivity:${organizationId}`;
    const checking = pool === 'connectivity';

    const runId = randomUUID();

    // One transaction: the minute's start count, and a slot in the
    // organization's in-flight set (and its connectivity set, for a check).
    const results = await withRedisTimeout(() => {
      const tx = redis.multi().incr(windowKey).pexpire(windowKey, limits.windowMs);
      queueSlot(tx, inFlightKey, runId, now, EGRESS_SLOT_TTL_MS);
      if (checking) queueSlot(tx, checkKey, runId, now, EGRESS_SLOT_TTL_MS);
      return tx.exec();
    });
    if (!results) throw new Error('transaction discarded');
    const answers = results.map(([error, value]) => {
      if (error) throw error;
      return value;
    });
    const started = Number(answers[0]);
    const inFlight = Number(answers[2 + SLOT_COUNT_OFFSET]);
    const checks = checking ? Number(answers[2 + SLOT_COMMANDS + SLOT_COUNT_OFFSET]) : 0;

    const releaseSlots = () => {
      releaseSlot(redis, inFlightKey, runId);
      if (checking) releaseSlot(redis, checkKey, runId);
    };

    let reason: string | null = null;
    if (started > limits.perOrganizationPerWindow) reason = 'per-minute limit';
    else if (inFlight > limits.perOrganizationConcurrent) {
      reason = 'too many in flight for this organization';
    } else if (checking && checks > limits.perOrganizationConnectivityConcurrent) {
      reason = 'a connectivity check is already running for this organization';
    }
    if (reason) {
      // Given back on refusal, so a refused run does not use up the minute.
      releaseSlots();
      withRedisTimeout(() => redis.decr(windowKey)).catch(() => undefined);
      return reason;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlots();
    };
  }

  /** This process's own counts: the state before Redis, and the fallback when it is out. */
  private acquireLocal(
    organizationId: string,
    pool: ProviderEgressPool,
    limits: ProviderEgressLimits,
    now: number,
  ): () => void {
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

    recent.push(now);
    this.started.set(organizationId, recent);
    this.inFlight.set(organizationId, active + 1);
    if (pool === 'connectivity') this.connectivityInFlight.set(organizationId, checking + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (pool === 'connectivity') {
        const checks = (this.connectivityInFlight.get(organizationId) ?? 1) - 1;
        if (checks > 0) this.connectivityInFlight.set(organizationId, checks);
        else this.connectivityInFlight.delete(organizationId);
      }
      const left = (this.inFlight.get(organizationId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(organizationId, left);
      else this.inFlight.delete(organizationId);
    };
  }

  private sharedFailed(now: number, error: unknown): void {
    this.skipSharedUntil = now + SHARED_WINDOW_RETRY_MS;
    if (now - this.lastFallbackWarnAt < 60_000) return;
    this.lastFallbackWarnAt = now;
    this.logger.warn(
      `shared egress limits unavailable, counting per instance: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
