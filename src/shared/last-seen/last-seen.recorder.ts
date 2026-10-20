import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

import {
  LastSeenKind,
  batchUpdate,
  flushingKey,
  isWellFormedKey,
  pendingKey,
} from './last-seen.kinds';

/**
 * Sets a hash field to the larger of what it holds and the new stamp, so two
 * replicas racing on one key never move it backwards.
 */
export const MAX_HSET_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if (not current) or (tonumber(current) < tonumber(ARGV[2])) then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
end
return 1
`;

/** With Redis unreachable, at most one direct write per key per this long. */
export const DIRECT_WRITE_INTERVAL_MS = 60_000;

/** Bound on the in-process throttle map; clearing it only ever allows an extra write. */
const DIRECT_WRITE_MAP_LIMIT = 10_000;

/**
 * Records "last seen" stamps without a database write per request.
 *
 * Every authenticated request used to `UPDATE` a row (`agents.last_login_at`,
 * `agent_credentials.last_used_at`, `operators.last_seen_at`). A stamp is now
 * a max-set into a Redis hash per kind, and `LastSeenFlusher` writes each
 * hash to Postgres in one batched `UPDATE` every 30 s. Readers that show a
 * stamp overlay {@link pending}, so a screen reads the same instant it would
 * have read from the row.
 *
 * ## Redis unreachable
 *
 * The stamp falls back to the direct write it used to be, throttled to one
 * per key per {@link DIRECT_WRITE_INTERVAL_MS} in this process, so an outage
 * neither drops stamps silently nor turns into a write per request. The
 * write never moves a column backwards.
 *
 * Fire-and-forget throughout: a stamp must never fail or slow a request.
 */
@Injectable()
export class LastSeenRecorder {
  private readonly logger = new Logger(LastSeenRecorder.name);

  private readonly directWrites = new Map<string, number>();

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional() private readonly cache: CacheService | null = null,
  ) {}

  /** Stamps `key` of `kind` at `at`. Never throws, never waits. */
  record(kind: LastSeenKind, key: string, at: Date = new Date()): void {
    if (!isWellFormedKey(kind, key)) return;
    const ms = at.getTime();
    void this.toRedis(kind, key, ms).catch((error: unknown) => {
      this.logger.debug(`last-seen ${kind} not buffered, writing directly: ${describe(error)}`);
      this.direct(kind, key, ms);
    });
  }

  /**
   * The stamps buffered for `keys` and not yet written, newest per key. Empty
   * when Redis cannot be read: the rows then hold everything this process
   * could not buffer.
   */
  async pending(kind: LastSeenKind, keys: readonly string[]): Promise<Map<string, Date>> {
    const found = new Map<string, Date>();
    if (keys.length === 0 || !this.cache) return found;
    try {
      const redis = this.cache.getRedisClient();
      const [buffered, flushing] = await withRedisTimeout(() =>
        Promise.all([
          redis.hmget(pendingKey(kind), ...keys),
          redis.hmget(flushingKey(kind), ...keys),
        ]),
      );
      keys.forEach((key, index) => {
        const ms = Math.max(Number(buffered[index] ?? 0), Number(flushing[index] ?? 0));
        if (ms > 0) found.set(key, new Date(ms));
      });
    } catch (error) {
      this.logger.debug(`last-seen ${kind} pending stamps unreadable: ${describe(error)}`);
    }
    return found;
  }

  /** The later of a row's stamp and its buffered one. */
  static latest(stored: Date | null, buffered: Date | undefined): Date | null {
    if (!buffered) return stored;
    if (!stored) return buffered;
    return buffered.getTime() > stored.getTime() ? buffered : stored;
  }

  private async toRedis(kind: LastSeenKind, key: string, ms: number): Promise<void> {
    if (!this.cache) throw new Error('no Redis client in this process');
    const redis = this.cache.getRedisClient();
    await withRedisTimeout(() => redis.eval(MAX_HSET_SCRIPT, 1, pendingKey(kind), key, String(ms)));
  }

  private direct(kind: LastSeenKind, key: string, ms: number): void {
    const throttleKey = `${kind}|${key}`;
    const last = this.directWrites.get(throttleKey);
    if (last !== undefined && ms - last < DIRECT_WRITE_INTERVAL_MS) return;
    if (this.directWrites.size >= DIRECT_WRITE_MAP_LIMIT) this.directWrites.clear();
    this.directWrites.set(throttleKey, ms);

    const { sql, params } = batchUpdate(kind, new Map([[key, ms]]));
    void this.dataSource.query(sql, params).catch((error: unknown) => {
      this.logger.warn(`last-seen ${kind} not written: ${describe(error)}`);
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
