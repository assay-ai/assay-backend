import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

/** One limit: how many requests per how long. */
export interface RateWindowSpec {
  readonly limit: number;
  readonly windowMs: number;
}

/** One in-process window; its length travels with it, since one map holds windows of every length. */
export interface LocalWindow {
  startedAt: number;
  count: number;
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
 * Fixed windows counted in Redis, so every instance shares one count, with a
 * bounded in-process window behind them for when Redis does not answer.
 *
 * The mechanics `AddressRateLimitInterceptor` documents, for any key and any
 * {@link RateWindowSpec}:
 *
 * - `INCR` and `PEXPIRE` go in one `MULTI`, and the window index is part of
 *   the key, so a lost expiry can leave a dead key behind but never lock a key
 *   out past its window.
 * - A Redis call that does not answer within `withRedisTimeout`'s deadline is
 *   counted in process instead, and for {@link SHARED_WINDOW_RETRY_MS} after a
 *   failure Redis is not asked at all, so an outage does not add the deadline
 *   to every request. The in-process count is still a limit, only a
 *   per-instance one.
 *
 * Concurrency slots ({@link acquireSlot}) follow the same rule: an `INCR`
 * with a safety expiry, given back with `DECR`, and an in-process count when
 * Redis is out.
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
    try {
      const results = await withRedisTimeout(() =>
        redis.multi().incr(sharedKey).pexpire(sharedKey, spec.windowMs).exec(),
      );
      const [error, count] = results?.[0] ?? [new Error('transaction discarded'), null];
      if (error) throw error;

      const windowEndsAt = (index + 1) * spec.windowMs;
      return {
        allowed: Number(count) <= spec.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAt - now) / 1000)),
      };
    } catch (error) {
      this.sharedFailed(now, spec.windowMs, error);
      return this.takeLocal(key, spec);
    }
  }

  /** Count one request against `key` in process; refused with the seconds until its window resets. */
  takeLocal(key: string, spec: RateWindowSpec): RateOutcome {
    const now = this.options.now();
    let window = this.windows.get(key);

    if (!window || now - window.startedAt >= spec.windowMs) {
      // Re-inserted, so the map's insertion order stays oldest-window-first.
      this.windows.delete(key);
      if (this.windows.size >= this.options.maxKeys) this.evict(now);
      window = { startedAt: now, count: 0, windowMs: spec.windowMs };
      this.windows.set(key, window);
    }

    window.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((window.startedAt + spec.windowMs - now) / 1000),
    );
    return { allowed: window.count <= spec.limit, retryAfterSeconds };
  }

  /**
   * Take one of `max` concurrent slots under `key`, or `null` when all are in
   * use. The returned function gives the slot back; call it exactly once.
   *
   * `ttlMs` bounds a slot whose release never ran (the process died with the
   * request in flight): the counter expires and the key is free again.
   */
  async acquireSlot(key: string, max: number, ttlMs: number): Promise<(() => void) | null> {
    const now = this.options.now();
    const redis = this.options.redis;
    if (redis && now >= this.skipSharedUntil) {
      const sharedKey = `${this.options.keyPrefix}${key}`;
      try {
        const results = await withRedisTimeout(() =>
          redis.multi().incr(sharedKey).pexpire(sharedKey, ttlMs).exec(),
        );
        const [error, count] = results?.[0] ?? [new Error('transaction discarded'), null];
        if (error) throw error;
        const release = once(() => {
          withRedisTimeout(() => redis.decr(sharedKey)).catch(() => undefined);
        });
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

  /** Drop expired windows; if still full, drop the oldest until there is room. */
  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= window.windowMs) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.options.maxKeys) break;
      this.windows.delete(key);
    }
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
