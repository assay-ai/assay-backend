import { readEpoch } from '@shared/cache/redis-cache/epoch-counter';
import { BoundedTtlCache } from '@shared/utils/bounded-ttl-cache';

describe('BoundedTtlCache', () => {
  it('drops the least recently used entry beyond its cap', () => {
    const cache = new BoundedTtlCache<number>(2, 1_000, () => 0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('expires an entry after its TTL', () => {
    let now = 0;
    const cache = new BoundedTtlCache<number>(10, 1_000, () => now);
    cache.set('a', 1);
    now = 999;
    expect(cache.get('a')).toBe(1);
    now = 2_000;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('readEpoch', () => {
  function redis(initial: string | null) {
    let value = initial;
    return {
      get: async () => value,
      set: async (_key: string, next: string) => {
        if (value === null) value = next;
        return 'OK';
      },
    };
  }

  it('reads an existing counter as it is', async () => {
    expect(await readEpoch(redis('42') as never, 'k')).toBe('42');
  });

  it('creates a missing counter above anything an evicted one could have reached', async () => {
    const created = await readEpoch(redis(null) as never, 'k');
    expect(BigInt(created) > BigInt(Date.now() - 1) * 1_000_000n).toBe(true);
    expect(created).not.toBe('0');
  });
});
