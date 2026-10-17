import { randomInt } from 'node:crypto';

import type { Redis } from 'ioredis';

/**
 * Reads an invalidation epoch, creating it when the key is missing.
 *
 * A missing key is never read as a constant: after an eviction or a flush, a
 * fixed fallback (`'0'`) would match every cache entry written before the
 * counter was first bumped, and serve them as fresh. A new counter starts
 * from the current time in milliseconds × 10⁶ plus a random part instead —
 * above any value the evicted counter could have reached by incrementing
 * (fewer than a million writes a millisecond), and within Redis's int64 — so
 * no old entry ever matches it. `SET NX` lets one process's start win when several race.
 */
export async function readEpoch(redis: Pick<Redis, 'get' | 'set'>, key: string): Promise<string> {
  const current = await redis.get(key);
  if (current !== null) return current;
  const start = (BigInt(Date.now()) * 1_000_000n + BigInt(randomInt(1_000_000))).toString();
  await redis.set(key, start, 'NX');
  return (await redis.get(key)) ?? start;
}
