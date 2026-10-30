import { CacheService } from '@shared/cache/redis-cache/cache.service';

/**
 * The semantics of `evm-hourly-wei-budget.ts`'s two Lua scripts over a map.
 * The take script reads the SERVER's clock (`clock`, review 2026-10-30 M-3),
 * sums the wei suffix of every member still in each key's window, refuses when
 * any key would go above its limit (answering the refused indexes and when
 * enough room frees), and otherwise writes one member per key. The settle
 * script swaps members at the same score. The real scripts are one EVAL each,
 * so nothing interleaves.
 */
export class FakeWeiWindowRedis {
  readonly sets = new Map<string, { score: number; member: string }[]>();
  failWith: Error | null = null;
  /** The Redis server's clock, in ms. */
  clock: () => number = () => 1_000_000;
  /** How many take scripts ran. */
  takes = 0;

  async eval(script: string, numKeys: number, ...rest: string[]): Promise<unknown> {
    if (this.failWith) throw this.failWith;
    const keys = rest.slice(0, numKeys);
    const argv = rest.slice(numKeys);
    if (script.includes('ZSCORE')) {
      const [, ...pairs] = argv;
      keys.forEach((key, i) => {
        const [member, replacement] = [pairs[2 * i], pairs[2 * i + 1]];
        const entries = this.sets.get(key) ?? [];
        const index = entries.findIndex((entry) => entry.member === member);
        if (index >= 0) entries[index] = { score: entries[index].score, member: replacement };
      });
      return 1;
    }
    this.takes += 1;
    const now = this.clock();
    const windowMs = Number(argv[0]);
    const id = argv[1];
    const refused: number[] = [];
    keys.forEach((key, i) => {
      const wei = BigInt(argv[2 + 2 * i]);
      const limit = BigInt(argv[3 + 2 * i]);
      const kept = (this.sets.get(key) ?? [])
        .filter((entry) => entry.score > now - windowMs)
        .sort((a, b) => a.score - b.score);
      this.sets.set(key, kept);
      const total = kept.reduce((sum, entry) => sum + weiOf(entry.member), 0n);
      if (total + wei > limit) {
        const need = total + wei - limit;
        let freed = 0n;
        let at = windowMs;
        if (wei <= limit) {
          for (const entry of kept) {
            freed += weiOf(entry.member);
            if (freed >= need) {
              at = entry.score + windowMs - now;
              break;
            }
          }
        }
        refused.push(i + 1, at);
      }
    });
    if (refused.length > 0) return [0, ...refused];
    keys.forEach((key, i) => {
      this.sets.get(key)!.push({ score: now, member: `${now}:${id}:${argv[2 + 2 * i]}` });
    });
    return [1, now];
  }

  /** The wei recorded under `key`. */
  total(key: string): bigint {
    return (this.sets.get(key) ?? []).reduce((sum, entry) => sum + weiOf(entry.member), 0n);
  }

  asCache(): CacheService {
    return { getRedisClient: () => this } as unknown as CacheService;
  }
}

function weiOf(member: string): bigint {
  return BigInt(/:(\d+)$/.exec(member)![1]);
}
