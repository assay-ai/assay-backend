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
  twinsKey,
} from './last-seen.kinds';

/** One flush across every replica at a time. */
export const LAST_SEEN_FLUSH_LOCK_KEY = 'assay:last-seen:flush-lock';
const LOCK_TTL_MS = 60_000;

/** Rows per `UPDATE`; a hash larger than this is written in several. */
export const LAST_SEEN_FLUSH_CHUNK = 1_000;

/**
 * Moves the kind's hash to this run's own key and lists it, in one step, so a
 * reader never sees the stamps in neither place. 0 when there is nothing.
 */
const TAKE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('RENAME', KEYS[1], KEYS[2])
redis.call('SADD', KEYS[3], KEYS[2])
return 1
`;

/** Deletes a written twin and unlists it, in one step. */
const DROP_SCRIPT = `
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], KEYS[1])
return 1
`;

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
 * Nothing is lost between the buffer and the row. A flush first moves the
 * kind's hash, atomically, to a key of its own (`:flushing:<run>`) and lists
 * it in the kind's twin set, so every stamp recorded after that instant lands
 * in a fresh hash; it then reads that key, writes it, and deletes (and
 * unlists) it only once the write committed. A failed write, or a process
 * that dies half way, leaves its key listed: the next flush writes every
 * listed key before taking a new one, and readers overlay them all the while.
 * A run only ever deletes a key after writing it itself, so two runs that
 * overlap (a lock that expired under a slow database) can at worst write the
 * same stamps twice, which the `UPDATE` makes harmless: it never moves a
 * column backwards.
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

    // Twins left by a failed or interrupted run (or one still running) first.
    for (const twin of await redis.smembers(twinsKey(kind))) {
      total += await this.writeTwin(kind, twin);
    }
    const own = flushingKey(kind, randomUUID());
    const taken = await redis.eval(TAKE_SCRIPT, 3, pendingKey(kind), own, twinsKey(kind));
    if (Number(taken) !== 1) return total;
    return total + (await this.writeTwin(kind, own));
  }

  private async writeTwin(kind: LastSeenKind, twin: string): Promise<number> {
    const redis = this.cache.getRedisClient();
    const raw = await redis.hgetall(twin);
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
    await redis.eval(DROP_SCRIPT, 2, twin, twinsKey(kind));
    return stamps.size;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
