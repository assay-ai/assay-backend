import { CacheService } from '@shared/cache/redis-cache/cache.service';

/**
 * The semantics of `evm-hourly-wei-budget.ts`'s two Lua scripts over a map.
 * The take script sums the wei suffix of every member still in the window and
 * refuses above the limit; the settle script swaps one member for another at
 * the same score. The real scripts are one EVAL each, so nothing interleaves.
 */
export class FakeWeiWindowRedis {
  readonly sets = new Map<string, { score: number; member: string }[]>();
  failWith: Error | null = null;

  async eval(script: string, _keys: number, key: string, ...argv: string[]): Promise<number> {
    if (this.failWith) throw this.failWith;
    if (script.includes('ZSCORE')) {
      const [member, score, replacement] = argv;
      const entries = this.sets.get(key) ?? [];
      const index = entries.findIndex((entry) => entry.member === member);
      if (index < 0) return 0;
      entries[index] = { score: Number(score), member: replacement };
      return 1;
    }
    const [now, windowMs, wei, limit, member] = argv;
    const kept = (this.sets.get(key) ?? []).filter(
      (entry) => entry.score > Number(now) - Number(windowMs),
    );
    this.sets.set(key, kept);
    const total = kept.reduce((sum, entry) => sum + BigInt(/:(\d+)$/.exec(entry.member)![1]), 0n);
    if (total + BigInt(wei) > BigInt(limit)) return 0;
    kept.push({ score: Number(now), member });
    return 1;
  }

  /** The wei recorded under `key`. */
  total(key: string): bigint {
    return (this.sets.get(key) ?? []).reduce(
      (sum, entry) => sum + BigInt(/:(\d+)$/.exec(entry.member)![1]),
      0n,
    );
  }

  asCache(): CacheService {
    return { getRedisClient: () => this } as unknown as CacheService;
  }
}
