/**
 * Enough of ioredis for the rate limiters: `MULTI` of `INCR` / `DECR` /
 * `PEXPIRE` and of the sorted-set commands a concurrency slot uses
 * (`ZREMRANGEBYSCORE` / `ZADD` / `ZCARD`), plus a bare `DECR` and `ZREM`,
 * over maps that several limiter instances can share (as replicas share one
 * Redis). `fail` makes every call reject.
 */
export function fakeRateRedis(
  store = new Map<string, number>(),
  sets = new Map<string, Map<string, number>>(),
) {
  const set = (key: string) => {
    let members = sets.get(key);
    if (!members) sets.set(key, (members = new Map()));
    return members;
  };
  const step = (key: string, by: number) => {
    const next = (store.get(key) ?? 0) + by;
    store.set(key, next);
    return next;
  };

  const redis = {
    fail: false,
    calls: 0,
    multi: () => {
      const ops: Array<() => [null, unknown]> = [];
      const chain = {
        incr: (key: string) => (ops.push(() => [null, step(key, 1)]), chain),
        decr: (key: string) => (ops.push(() => [null, step(key, -1)]), chain),
        pexpire: () => (ops.push(() => [null, 1]), chain),
        zremrangebyscore: (key: string, _min: string | number, max: string | number) => (
          ops.push(() => {
            let removed = 0;
            for (const [member, score] of set(key)) {
              if (score <= Number(max)) {
                set(key).delete(member);
                removed += 1;
              }
            }
            return [null, removed];
          }),
          chain
        ),
        zadd: (key: string, score: number, member: string) => (
          ops.push(() => (set(key).set(member, score), [null, 1])),
          chain
        ),
        zcard: (key: string) => (ops.push(() => [null, set(key).size]), chain),
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
      return Promise.resolve(step(key, -1));
    },
    zrem: (key: string, member: string) => {
      redis.calls += 1;
      if (redis.fail) return Promise.reject(new Error('connection lost'));
      return Promise.resolve(set(key).delete(member) ? 1 : 0);
    },
  };
  return { redis, store, sets };
}
