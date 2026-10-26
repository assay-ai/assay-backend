import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

/** One limit: how many requests per how long. */
export interface RateWindowSpec {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * One in-process window; its length travels with it, since one map holds
 * windows of every length. `previous` is the count of the window before, for
 * the weighted estimate ({@link slidingOutcome}).
 */
export interface LocalWindow {
  startedAt: number;
  count: number;
  previous: number;
  windowMs: number;
}

export interface RateOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** After a Redis failure, how long counts skip it and go straight to the in-process window. */
export const SHARED_WINDOW_RETRY_MS = 5_000;

export interface SharedRateWindowsOptions {
  /** The shared cache client. Absent, every count is in process. */
  readonly redis?: Redis;
  /**
   * Prepended to every key in Redis (never in process), so two limiters on
   * one Redis never share a count.
   */
  readonly keyPrefix: string;
  /** Keys the in-process fallback tracks at once. Past this, expired windows go first, then the oldest. */
  readonly maxKeys: number;
  /** The clock, read on every count, so a caller (or a test) can swap it after construction. */
  readonly now: () => number;
  readonly logger: Logger;
  /** How often a fallback warning may repeat; one per window by default. */
  readonly warnEveryMs?: number;
}

/**
 * Sliding windows counted in Redis, so every instance shares one count, with a
 * bounded in-process window behind them for when Redis does not answer.
 *
 * A window is the two-window weighted estimate: the count of the current
 * fixed window plus the previous window's count scaled by how much of it still
 * lies within the last `windowMs`. A plain fixed window let a burst that
 * straddles a boundary through twice (`limit` at the end of one window and
 * `limit` at the start of the next); the estimate never counts fewer than the
 * fixed window would, and a steady rate within the limit is never refused.
 *
 * The mechanics `AddressRateLimitInterceptor` documents, for any key and any
 * {@link RateWindowSpec}:
 *
 * - `INCR`, `PEXPIRE` and the `GET` of the previous window go in one `MULTI`,
 *   and the window index is part of the key, so a lost expiry can leave a dead
 *   key behind but never lock a key out past the next window. A key lives two
 *   windows, so the next one can still read it.
 * - A Redis call that does not answer within `withRedisTimeout`'s deadline is
 *   counted in process instead, and for {@link SHARED_WINDOW_RETRY_MS} after a
 *   failure Redis is not asked at all, so an outage does not add the deadline
 *   to every request. The in-process count is still a limit, only a
 *   per-instance one.
 *
 * Concurrency slots ({@link acquireSlot}) are members of a sorted set
 * scored by their own expiry, given back with `ZREM`, and an in-process count
 * when Redis is out.
 */
export class SharedRateWindows {
  private readonly windows = new Map<string, LocalWindow>();
  private readonly localSlots = new Map<string, number>();
  private lastFallbackWarnAt = Number.NEGATIVE_INFINITY;
  private skipSharedUntil = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: SharedRateWindowsOptions) {}

  /** The in-process windows, for tests that check the fallback stays bounded. */
  get localWindows(): ReadonlyMap<string, LocalWindow> {
    return this.windows;
  }

  /** Count one request against `key` in the shared window; on a Redis failure, in the in-process one. */
  async take(key: string, spec: RateWindowSpec): Promise<RateOutcome> {
    const now = this.options.now();
    const redis = this.options.redis;
    if (!redis || now < this.skipSharedUntil) return this.takeLocal(key, spec);

    const index = Math.floor(now / spec.windowMs);
    const sharedKey = `${this.options.keyPrefix}${key}:${index}`;
    const previousKey = `${this.options.keyPrefix}${key}:${index - 1}`;
    try {
      const results = await withRedisTimeout(() =>
        redis
          .multi()
          .incr(sharedKey)
          .pexpire(sharedKey, 2 * spec.windowMs)
          .get(previousKey)
          .exec(),
      );
      if (!results) throw new Error('transaction discarded');
      const [error, count] = results[0];
      if (error) throw error;
      const [previousError, previous] = results[2];
      if (previousError) throw previousError;

      return slidingOutcome(
        Number(previous ?? 0),
        Number(count),
        now - index * spec.windowMs,
        spec,
      );
    } catch (error) {
      this.sharedFailed(now, spec.windowMs, error);
      return this.takeLocal(key, spec);
    }
  }

  /** Count one request against `key` in process; refused with the seconds until it would be allowed. */
  takeLocal(key: string, spec: RateWindowSpec): RateOutcome {
    const now = this.options.now();
    let window = this.windows.get(key);

    if (!window || now - window.startedAt >= spec.windowMs) {
      // The window just ended is the previous one; one older than that counts nothing.
      const previous = window && now - window.startedAt < 2 * spec.windowMs ? window.count : 0;
      const startedAt = window && previous > 0 ? window.startedAt + spec.windowMs : now;
      // Re-inserted, so the map's insertion order stays oldest-window-first.
      this.windows.delete(key);
      if (this.windows.size >= this.options.maxKeys) this.evict(now);
      window = { startedAt, count: 0, previous, windowMs: spec.windowMs };
      this.windows.set(key, window);
    }

    window.count += 1;
    return slidingOutcome(window.previous, window.count, now - window.startedAt, spec);
  }

  /**
   * Take one of `max` concurrent slots under `key`, or `null` when all are in
   * use. The returned function gives the slot back; calling it again does
   * nothing.
   *
   * In Redis a slot is a member of a sorted set (see {@link queueSlot}), so
   * a slot whose release was lost (a replica killed mid-run, a `ZREM` that
   * timed out) frees itself `ttlMs` after it was taken, however often the
   * caller retries meanwhile.
   */
  async acquireSlot(key: string, max: number, ttlMs: number): Promise<(() => void) | null> {
    const now = this.options.now();
    const redis = this.options.redis;
    if (redis && now >= this.skipSharedUntil) {
      const sharedKey = `${this.options.keyPrefix}${key}`;
      const runId = randomUUID();
      try {
        const results = await withRedisTimeout(() =>
          queueSlot(redis.multi(), sharedKey, runId, now, ttlMs).exec(),
        );
        if (!results) throw new Error('transaction discarded');
        const [error, count] = results[SLOT_COUNT_OFFSET];
        if (error) throw error;
        const release = once(() => releaseSlot(redis, sharedKey, runId));
        if (Number(count) > max) {
          release();
          return null;
        }
        return release;
      } catch (error) {
        this.sharedFailed(now, ttlMs, error);
      }
    }

    const held = this.localSlots.get(key) ?? 0;
    if (held >= max) return null;
    this.localSlots.set(key, held + 1);
    return once(() => {
      const left = (this.localSlots.get(key) ?? 1) - 1;
      if (left > 0) this.localSlots.set(key, left);
      else this.localSlots.delete(key);
    });
  }

  private sharedFailed(now: number, warnWindowMs: number, error: unknown): void {
    this.skipSharedUntil = now + SHARED_WINDOW_RETRY_MS;
    if (now - this.lastFallbackWarnAt >= (this.options.warnEveryMs ?? warnWindowMs)) {
      this.lastFallbackWarnAt = now;
      this.options.logger.warn(
        `shared rate window unavailable, counting per instance: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Drop windows that no longer count; if still full, drop the oldest until there is room. */
  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= 2 * window.windowMs) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.options.maxKeys) break;
      this.windows.delete(key);
    }
  }
}

/**
 * The two-window weighted decision for a request just counted: `current` is
 * the count of the window it fell in (this request included), `previous` the
 * count of the window before, and `elapsedMs` how far into the current window
 * it arrived. The estimate is `previous × (1 − elapsed / window) + current`.
 *
 * `retryAfterSeconds` is the wait until one more request would be allowed if
 * none arrives meanwhile: later in this window, as the previous one's share
 * fades, or else once the next window has taken enough of this one's weight
 * off.
 */
export function slidingOutcome(
  previous: number,
  current: number,
  elapsedMs: number,
  spec: RateWindowSpec,
): RateOutcome {
  const { limit, windowMs } = spec;
  const estimate = (previous * (windowMs - elapsedMs)) / windowMs + current;
  if (estimate <= limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // Inside this window: previous × (1 − e / W) + current + 1 ≤ limit.
  const roomNow = limit - current - 1;
  let waitMs: number;
  if (roomNow >= 0 && previous > 0) {
    waitMs = windowMs * (1 - roomNow / previous) - elapsedMs;
  } else {
    // In the next window: current × (1 − e / W) + 1 ≤ limit.
    const intoNext = Math.max(0, windowMs * (1 - (limit - 1) / current));
    waitMs = windowMs - elapsedMs + intoNext;
  }
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
}

/**
 * Queue the commands that take a concurrency slot: drop the members whose
 * expiry passed, add this run scored by its own expiry, and count the set.
 * One `MULTI`, so the count includes every run admitted before this one: the
 * run holds a slot when the count is within the limit, and otherwise removes
 * itself (`releaseSlot`) and is refused. A run that is past the limit for an
 * instant, before it removes itself, can only make another one refused,
 * never let one too many in. The key's own expiry only collects an idle set;
 * each member expires by its score, so retries never extend a lost slot.
 */
export function queueSlot<T extends SlotPipeline>(
  tx: T,
  key: string,
  runId: string,
  now: number,
  ttlMs: number,
): T {
  tx.zremrangebyscore(key, '-inf', now);
  tx.zadd(key, now + ttlMs, runId);
  tx.zcard(key);
  tx.pexpire(key, ttlMs);
  return tx;
}

/** Where {@link queueSlot}'s `ZCARD` answer (runs holding a slot, this one included) sits. */
export const SLOT_COUNT_OFFSET = 2;
/** How many commands {@link queueSlot} queues. */
export const SLOT_COMMANDS = 4;

/** The subset of an ioredis pipeline {@link queueSlot} uses. */
export interface SlotPipeline {
  zremrangebyscore(key: string, min: string | number, max: string | number): unknown;
  zadd(key: string, score: number, member: string): unknown;
  zcard(key: string): unknown;
  pexpire(key: string, ms: number): unknown;
}

/** Give a slot back: remove the run from the set. Safe to repeat and after its expiry. */
export function releaseSlot(redis: Redis, key: string, runId: string): void {
  withRedisTimeout(() => redis.zrem(key, runId)).catch(() => undefined);
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
