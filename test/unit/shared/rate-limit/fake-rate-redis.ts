/**
 * Enough of ioredis for the rate limiters: `MULTI` of `INCR` / `DECR` /
 * `PEXPIRE`, and a bare `DECR`, over one map that several limiter instances
 * can share (as replicas share one Redis). `fail` makes every call reject.
 */
export function fakeRateRedis(store = new Map<string, number>()) {
  const redis = {
    fail: false,
    calls: 0,
    multi: () => {
      const ops: Array<() => [null, number]> = [];
      const step = (key: string, by: number) => () => {
        const next = (store.get(key) ?? 0) + by;
        store.set(key, next);
        return [null, next] as [null, number];
      };
      const chain = {
        incr: (key: string) => (ops.push(step(key, 1)), chain),
        decr: (key: string) => (ops.push(step(key, -1)), chain),
        pexpire: () => (ops.push(() => [null, 1]), chain),
        exec: () => {
          redis.calls += 1;
          return redis.fail
            ? Promise.reject(new Error('connection lost'))
            : Promise.resolve(ops.map((op) => op()));
        },
      };
      return chain;
    },
    decr: (key: string) => {
      redis.calls += 1;
      if (redis.fail) return Promise.reject(new Error('connection lost'));
      const next = (store.get(key) ?? 0) - 1;
      store.set(key, next);
      return Promise.resolve(next);
    },
  };
  return { redis, store };
}
