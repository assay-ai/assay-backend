import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CacheService } from '@shared/cache/redis-cache/cache.service';

import {
  LAST_SEEN_KINDS,
  LastSeenKind,
  batchUpdate,
  flushingKey,
  isWellFormedKey,
  pendingKey,
} from './last-seen.kinds';

/** One flush across every replica at a time. */
export const LAST_SEEN_FLUSH_LOCK_KEY = 'assay:last-seen:flush-lock';
const LOCK_TTL_MS = 60_000;

/** Rows per `UPDATE`; a hash larger than this is written in several. */
export const LAST_SEEN_FLUSH_CHUNK = 1_000;

/** Deletes the lock only if this run still holds it. */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export interface LastSeenFlushSummary {
  readonly skipped: boolean;
  readonly written: Partial<Record<LastSeenKind, number>>;
}

/**
 * Writes the stamps {@link LastSeenRecorder} buffered, one batched `UPDATE`
 * per kind.
 *
 * Nothing is lost between the buffer and the row. A flush first `RENAME`s the
 * kind's hash to its `:flushing` twin, atomically, so every stamp recorded
 * after that instant lands in a fresh hash; it then reads the twin, writes
 * it, and deletes it only once the write committed. A failed write, or a
 * process that dies half way, leaves the twin in place: the next flush writes
 * it before taking a new one (a `RENAME` onto it would overwrite it, so none
 * is taken while it exists), and readers overlay it all the while. The
 * `UPDATE` never moves a column backwards, so writing a twin twice is
 * harmless.
 *
 * A Redis lock keeps two scheduler replicas from flushing at once.
 */
@Injectable()
export class LastSeenFlusher {
  private readonly logger = new Logger(LastSeenFlusher.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly cache: CacheService,
  ) {}

  async flush(): Promise<LastSeenFlushSummary> {
    const redis = this.cache.getRedisClient();
    const token = randomUUID();
    const locked = await redis.set(LAST_SEEN_FLUSH_LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
    if (locked !== 'OK') return { skipped: true, written: {} };

    const written: Partial<Record<LastSeenKind, number>> = {};
    try {
      for (const kind of LAST_SEEN_KINDS) {
        try {
          written[kind] = await this.flushKind(kind);
        } catch (error) {
          // One kind's failure must not hold the others back; its twin stays.
          this.logger.warn(`last-seen ${kind} flush failed: ${describe(error)}`);
        }
      }
    } finally {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, LAST_SEEN_FLUSH_LOCK_KEY, token).catch(() => 0);
    }
    return { skipped: false, written };
  }

  private async flushKind(kind: LastSeenKind): Promise<number> {
    const redis = this.cache.getRedisClient();
    let total = 0;

    // A twin left by a failed or interrupted flush goes first.
    if ((await redis.exists(flushingKey(kind))) === 1) {
      total += await this.writeTwin(kind);
    }
    try {
      await redis.rename(pendingKey(kind), flushingKey(kind));
    } catch (error) {
      if (/no such key/i.test(describe(error))) return total;
      throw error;
    }
    return total + (await this.writeTwin(kind));
  }

  private async writeTwin(kind: LastSeenKind): Promise<number> {
    const redis = this.cache.getRedisClient();
    const raw = await redis.hgetall(flushingKey(kind));
    const stamps = new Map<string, number>();
    for (const [key, value] of Object.entries(raw)) {
      const ms = Number(value);
      if (isWellFormedKey(kind, key) && Number.isFinite(ms) && ms > 0) stamps.set(key, ms);
    }

    const entries = [...stamps];
    for (let start = 0; start < entries.length; start += LAST_SEEN_FLUSH_CHUNK) {
      const { sql, params } = batchUpdate(
        kind,
        new Map(entries.slice(start, start + LAST_SEEN_FLUSH_CHUNK)),
      );
      await this.dataSource.query(sql, params);
    }
    await redis.del(flushingKey(kind));
    return stamps.size;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
