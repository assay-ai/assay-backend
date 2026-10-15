import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import {
  DUPLICATE_REQUEST_THRESHOLD,
  DUPLICATE_REQUEST_WINDOW_MS,
} from '../constants/spend-policy-defaults.constants';

/**
 * The two count-based velocity ceilings.
 *
 * `spend_policies.max_spend_per_hour` is deliberately not here: it bounds
 * money, and money is only spent once a hold is opened or settled, so it is
 * measured from `payment_intents` by `SpendPolicyEnforcementService` (see
 * `SpendUsageService`), not from a counter bumped on every attempt — an
 * attempt counter cannot be told that a call was later voided or refunded.
 */
export interface VelocityLimits {
  /** `spend_policies.max_calls_per_minute`. `null` = unlimited. */
  readonly maxCallsPerMinute: number | null;
  /** `spend_policies.max_calls_per_hour`. `null` = unlimited. */
  readonly maxCallsPerHour: number | null;
}

export enum VelocityViolationKind {
  CALLS_PER_MINUTE = 'CALLS_PER_MINUTE',
  CALLS_PER_HOUR = 'CALLS_PER_HOUR',
  /** Raised by `SpendPolicyEnforcementService` from `payment_intents`, never by {@link SpendPolicyVelocityService.consume}. */
  SPEND_PER_HOUR = 'SPEND_PER_HOUR',
  DUPLICATE_REQUEST = 'DUPLICATE_REQUEST',
  /** Redis could not be reached — see the class doc on which way this fails. */
  UNAVAILABLE = 'UNAVAILABLE',
}

export interface VelocityViolation {
  readonly kind: VelocityViolationKind;
  /** Seconds until the window this violation was measured in rolls over. */
  readonly retryAfterSeconds: number;
  /**
   * `DUPLICATE_REQUEST` only: whether this call is the one that first crossed
   * the threshold for this incident (`true`), or a later call inside the same
   * still-open incident (`false`). The caller uses this to notify once and go
   * quiet — see the class doc's "one notification per incident" section.
   */
  readonly freshAnomaly?: boolean;
}

/** A read-only snapshot of one agent's current velocity counters, for display. */
export interface VelocityUsage {
  readonly callsThisMinute: number | null;
  readonly callsThisHour: number | null;
  /** `false` when Redis could not be read — the caller renders "—", not a wrong zero. */
  readonly readable: boolean;
}

const CALLS_PER_MINUTE_WINDOW_MS = 60_000;
const CALLS_PER_HOUR_WINDOW_MS = 60 * 60_000;

/** How long an incident's "already notified" flag survives once set. */
const INCIDENT_SUPPRESSION_SECONDS = 60 * 60;

const KEY_PREFIX = 'spend-policy:velocity:';

/** Deletes the agent's spend lock only if this holder still owns it. */
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/**
 * The gateway's velocity layer, in Redis.
 *
 * Three independent counters per agent (calls/minute, calls/hour,
 * duplicate-hash), all fixed-window (period baked into
 * the key, one `INCR`/`INCRBY` plus a refreshed `EXPIRE`), not sliding sets
 * like `BindingCeilingService`'s rps window or `RedisSigningRateLimiter`'s
 * signing rate:
 *
 * ## Fixed window, deliberately, not sliding
 *
 * A sliding window exists to stop an *adversary* timing a request pair across
 * a window boundary to double a security-critical rate — that is exactly what
 * `RedisSigningRateLimiter` defends against, because the thing being bounded
 * is how fast a stolen key can be drained. Nothing here is adversarial in that
 * sense: a runaway retry loop is not timing itself against a minute boundary,
 * it is calling as fast as it can, and a fixed window catches that at the
 * resolution that matters here (a loop burns a whole daily budget in *four
 * minutes* — a boundary-doubling of a per-minute counter is noise next to
 * that). `BindingCeilingService`'s daily bucket makes the same trade for the
 * same reason at a coarser grain; this is that same idiom at minute and hour
 * grain.
 *
 * ## Every attempt is counted, refused or not — the `RedisSigningRateLimiter` idiom, not `BindingCeilingService`'s
 *
 * `BindingCeilingService` explicitly does **not** count a refused call,
 * because what it bounds is calls actually delivered to a provider's
 * endpoint, and a refused call was never delivered. This class bounds the
 * opposite thing: how many times an *agent* has tried, which is what a
 * runaway loop is made of. Refusing to count a refused attempt would mean a
 * loop that is already over the per-minute ceiling stops incrementing the
 * per-hour counter for as long as it stays refused — and once the minute
 * rolls over, it would find the hourly counter under-counted and slip past a
 * cap it should already have hit. So {@link consume} increments every counter
 * unconditionally and decides *after*, exactly the order
 * `RedisSigningRateLimiter.observe` documents: *"the increment happens before
 * the decision, and the caller decides on the post-increment count."*
 *
 * That reasoning is about attempts, so it covers only the attempt counters.
 * Money per hour is not counted here: an attempt that is refused, voided or
 * refunded spent nothing, and a counter that summed every attempt's price
 * locked agents out after a run of voided calls with nothing spent. Spend per
 * hour is read from `payment_intents` like the daily cap (see
 * `SpendPolicyEnforcementService`).
 *
 * ## This class fails CLOSED
 *
 * The opposite of `BindingCeilingService`, and for the reason that class's own
 * doc names as the dividing line: *"guards a courtesy a provider asked for"*
 * versus *"guards the production of signatures that take money from
 * providers."* This guards money leaving an agent's balance. The trade, put
 * exactly: *"a spend limiter refusing on a Redis blip
 * costs a call, and permitting on one costs money."* An outage that made every
 * velocity check unavailable would, if this failed open, remove the **one**
 * layer that exists because the other layers cannot catch a runaway loop —
 * precisely the failure mode most likely to be hammering the platform during
 * an outage. Failing closed costs an agent some retryable `429`s until Redis
 * recovers; failing open costs whatever a stuck loop can spend in that
 * window. {@link consume} therefore reports {@link VelocityViolationKind.UNAVAILABLE}
 * rather than `null` when Redis cannot be reached, and the caller
 * (`SpendPolicyEnforcementService`) treats that exactly like a real
 * violation.
 *
 * {@link read} — the display path for `GET /spend-policy`'s live-usage block
 * — is the one place this class is permissive: an unreadable counter there
 * reports `readable: false`, the same `chainReadable: false` idiom the
 * capital screen uses for an RPC outage, rather than either blocking a
 * read-only screen or lying with a zero.
 */
@Injectable()
export class SpendPolicyVelocityService {
  private readonly logger = new Logger(SpendPolicyVelocityService.name);

  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  /**
   * Record one call attempt and report the first limit it breaches, if any.
   *
   * Never throws — a Redis failure is reported as
   * {@link VelocityViolationKind.UNAVAILABLE}, which the caller treats as a
   * refusal (see the class doc on the fail direction).
   */
  async consume(
    agentId: string,
    requestHash: string,
    limits: VelocityLimits,
  ): Promise<VelocityViolation | null> {
    const now = Date.now();

    let counts: {
      callsThisMinute: number;
      callsThisHour: number;
      duplicateCount: number;
    };

    try {
      const pipeline = this.redis.multi();

      const callsMinKey = this.callsMinKey(agentId, now);
      pipeline.incr(callsMinKey);
      pipeline.pexpire(callsMinKey, CALLS_PER_MINUTE_WINDOW_MS + GRACE_MS);

      const callsHrKey = this.callsHrKey(agentId, now);
      pipeline.incr(callsHrKey);
      pipeline.pexpire(callsHrKey, CALLS_PER_HOUR_WINDOW_MS + GRACE_MS);

      const dupKey = this.duplicateKey(agentId, requestHash, now);
      pipeline.incr(dupKey);
      pipeline.pexpire(dupKey, DUPLICATE_REQUEST_WINDOW_MS + GRACE_MS);

      const replies = await pipeline.exec();
      if (!replies) {
        // `exec` returns `null` when the MULTI was discarded — a reconnect or
        // a watch failure. Not distinguishable from a partial count, so it is
        // treated as "nothing was counted", which fails closed above.
        throw new Error('velocity pipeline discarded (MULTI/EXEC)');
      }

      counts = {
        callsThisMinute: readCount(replies, 0),
        callsThisHour: readCount(replies, 2),
        duplicateCount: readCount(replies, 4),
      };
    } catch (error) {
      this.logger.warn(
        `agent ${agentId}: velocity counters unavailable, refusing the call. ${describe(error)}`,
      );
      return {
        kind: VelocityViolationKind.UNAVAILABLE,
        retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
      };
    }

    if (declared(limits.maxCallsPerMinute) && counts.callsThisMinute > limits.maxCallsPerMinute) {
      return {
        kind: VelocityViolationKind.CALLS_PER_MINUTE,
        retryAfterSeconds: secondsRemainingInWindow(CALLS_PER_MINUTE_WINDOW_MS, now),
      };
    }

    if (declared(limits.maxCallsPerHour) && counts.callsThisHour > limits.maxCallsPerHour) {
      return {
        kind: VelocityViolationKind.CALLS_PER_HOUR,
        retryAfterSeconds: secondsRemainingInWindow(CALLS_PER_HOUR_WINDOW_MS, now),
      };
    }

    if (counts.duplicateCount >= DUPLICATE_REQUEST_THRESHOLD) {
      const freshAnomaly = await this.claimIncidentNotification(agentId, requestHash);
      return {
        kind: VelocityViolationKind.DUPLICATE_REQUEST,
        retryAfterSeconds: secondsRemainingInWindow(DUPLICATE_REQUEST_WINDOW_MS, now),
        freshAnomaly,
      };
    }

    return null;
  }

  /**
   * A read-only snapshot for `GET /spend-policy`'s live-usage block.
   *
   * Issues no `INCR` — plain `GET`s against the same keys {@link consume}
   * writes, so a dashboard render never itself counts as a call attempt.
   */
  async read(agentId: string): Promise<VelocityUsage> {
    const now = Date.now();
    try {
      const [callsMin, callsHr] = await Promise.all([
        this.redis.get(this.callsMinKey(agentId, now)),
        this.redis.get(this.callsHrKey(agentId, now)),
      ]);
      return {
        callsThisMinute: Number(callsMin ?? '0'),
        callsThisHour: Number(callsHr ?? '0'),
        readable: true,
      };
    } catch (error) {
      this.logger.warn(
        `agent ${agentId}: velocity usage unreadable for display. ${describe(error)}`,
      );
      return { callsThisMinute: null, callsThisHour: null, readable: false };
    }
  }

  /**
   * `SET … NX` on the "already notified" flag for this `(agent, hash)`
   * incident. Returns `true` exactly once per incident — the call that wins
   * the `NX` race is the one that notifies; every later call inside
   * {@link INCIDENT_SUPPRESSION_SECONDS} finds the flag already set and stays
   * quiet, matching the requirement: *"fires … once, then suppressed for the
   * incident."*
   *
   * A failure here is swallowed to `false` (do not notify) rather than
   * propagated: the call is already being refused by the caller regardless of
   * whether the flag could be written, and guessing `true` on a Redis error
   * risks a notification storm, which is the one direction "suppressed for
   * the incident" must not fail in.
   */
  private async claimIncidentNotification(agentId: string, requestHash: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        this.duplicateNotifiedKey(agentId, requestHash),
        '1',
        'EX',
        INCIDENT_SUPPRESSION_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      this.logger.warn(
        `agent ${agentId}: could not claim the duplicate-request incident flag; not notifying. ` +
          describe(error),
      );
      return false;
    }
  }

  /**
   * Claims the agent's spend lock for `ttlMs` (`SET NX PX`), naming the holder
   * by `token`. `true` when claimed. Rejects when Redis cannot be reached — the
   * caller fails closed, as {@link consume} does.
   */
  async tryLockAgentSpend(agentId: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(this.spendLockKey(agentId), token, 'PX', ttlMs, 'NX')) === 'OK';
  }

  /** Releases the lock if `token` still holds it. Never throws: the TTL ends it anyway. */
  async unlockAgentSpend(agentId: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.spendLockKey(agentId), token);
    } catch (error) {
      this.logger.warn(
        `agent ${agentId}: could not release the spend lock; it expires by itself. ` +
          describe(error),
      );
    }
  }

  /**
   * Pushes the lock's expiry `ttlMs` out again if `token` still holds it.
   * Never throws: a renewal that cannot reach Redis is a lock nobody else can
   * claim either, because claiming needs the same Redis.
   */
  async renewAgentSpendLock(agentId: string, token: string, ttlMs: number): Promise<void> {
    try {
      await this.redis.eval(RENEW_LOCK_SCRIPT, 1, this.spendLockKey(agentId), token, String(ttlMs));
    } catch (error) {
      this.logger.warn(`agent ${agentId}: could not renew the spend lock. ${describe(error)}`);
    }
  }

  /**
   * `true` when `token` still holds the lock, and pushes its expiry `ttlMs`
   * out — the same compare-and-renew as {@link renewAgentSpendLock}, but its
   * answer is the point. Rejects when Redis cannot be reached: the caller
   * cannot tell whether it still owns the lock and fails closed.
   */
  async holdsAgentSpendLock(agentId: string, token: string, ttlMs: number): Promise<boolean> {
    const renewed = await this.redis.eval(
      RENEW_LOCK_SCRIPT,
      1,
      this.spendLockKey(agentId),
      token,
      String(ttlMs),
    );
    return Number(renewed) === 1;
  }

  private spendLockKey(agentId: string): string {
    return `${KEY_PREFIX}spend-lock:${agentId}`;
  }

  private callsMinKey(agentId: string, now: number): string {
    return `${KEY_PREFIX}calls-min:${agentId}:${bucket(now, CALLS_PER_MINUTE_WINDOW_MS)}`;
  }

  private callsHrKey(agentId: string, now: number): string {
    return `${KEY_PREFIX}calls-hr:${agentId}:${bucket(now, CALLS_PER_HOUR_WINDOW_MS)}`;
  }

  private duplicateKey(agentId: string, requestHash: string, now: number): string {
    return `${KEY_PREFIX}dup:${agentId}:${requestHash}:${bucket(now, DUPLICATE_REQUEST_WINDOW_MS)}`;
  }

  private duplicateNotifiedKey(agentId: string, requestHash: string): string {
    return `${KEY_PREFIX}dup-notified:${agentId}:${requestHash}`;
  }
}

/** Extra time a key survives past its own window, so a write just before the boundary never expires mid-window. */
const GRACE_MS = 10_000;

/** How soon an agent may be told to retry after a Redis-unavailable refusal. */
const UNAVAILABLE_RETRY_SECONDS = 5;

/** `null`/`undefined` is "no ceiling"; spelled out for the same reason `BindingCeilingService.declared` is. */
function declared(ceiling: number | null | undefined): ceiling is number {
  return typeof ceiling === 'number' && Number.isFinite(ceiling);
}

/** Which fixed window `now` falls in — the period baked into the Redis key. */
function bucket(now: number, windowMs: number): number {
  return Math.floor(now / windowMs);
}

/** Seconds left before the fixed window `now` falls in rolls over. */
function secondsRemainingInWindow(windowMs: number, now: number): number {
  return Math.ceil((windowMs - (now % windowMs)) / 1_000);
}

/** The `[error, value]` reply at `index` in a MULTI/EXEC reply array, as a number. */
function readCount(replies: Array<[Error | null, unknown]>, index: number): number {
  const [error, value] = replies[index];
  if (error) throw error;
  return Number(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
