/**
 * The handful of Redis commands the per-binding traffic counters need, over two maps.
 *
 * A real Redis proves nothing extra: every claim made against this fake is
 * about *which command runs against which key with what argument*, which is
 * exactly what a fake records and a real server hides.
 * `binding-call-counter.spec.ts` and `kill-switch.spec.ts` make the same split
 * for the same reason.
 *
 * Shared rather than copied, because `routing-ceilings.spec.ts` drives the
 * router through the **real** `BindingCeilingService` over this fake — the only
 * way to assert that a provider sheds at the threshold they declared and not at
 * some fraction of it. A second copy of these commands would be a second
 * opinion about what Redis does, and the two would drift.
 */
export type Reply = [Error | null, unknown];

export class FakeRedis {
  readonly strings = new Map<string, string>();
  /** key → member → score. A sorted set, without the sorting nobody asserts on. */
  readonly zsets = new Map<string, Map<string, number>>();
  readonly expiries = new Map<string, number>();
  /** Every command issued, in order — how "read spends nothing" is proved. */
  readonly commands: string[] = [];
  /** Set to make every command reject, standing in for an unreachable Redis. */
  down = false;

  private guard(command: string): void {
    this.commands.push(command);
    if (this.down) throw new Error('redis is unreachable');
  }

  private zset(key: string): Map<string, number> {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    return set;
  }

  // ── strings ──────────────────────────────────────────────────────────────

  get(key: string): Promise<string | null> {
    try {
      this.guard(`get ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  incr(key: string): Promise<number> {
    try {
      this.guard(`incr ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return Promise.resolve(next);
  }

  /**
   * `SET key value EX seconds NX` — the one form
   * `BindingCallCounterService.hydrate` issues.
   *
   * `NX` is the part worth honouring rather than ignoring: two callers can miss
   * the cache at once, and the loser must not overwrite a key the winner has
   * already begun incrementing.
   */
  set(key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX'): Promise<'OK' | null> {
    try {
      this.guard(`set ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    if (nx === 'NX' && this.strings.has(key)) return Promise.resolve(null);
    this.strings.set(key, value);
    this.expiries.set(key, seconds);
    return Promise.resolve('OK');
  }

  exists(key: string): Promise<number> {
    try {
      this.guard(`exists ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.strings.has(key) ? 1 : 0);
  }

  decr(key: string): Promise<number> {
    try {
      this.guard(`decr ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    const next = Number(this.strings.get(key) ?? '0') - 1;
    this.strings.set(key, String(next));
    return Promise.resolve(next);
  }

  expire(key: string, seconds: number): Promise<number> {
    try {
      this.guard(`expire ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    this.expiries.set(key, seconds);
    return Promise.resolve(1);
  }

  // ── sorted sets ──────────────────────────────────────────────────────────

  zcount(key: string, min: string, max: string): Promise<number> {
    try {
      this.guard(`zcount ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.countInRange(key, min, max));
  }

  zrem(key: string, member: string): Promise<number> {
    try {
      this.guard(`zrem ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.zset(key).delete(member) ? 1 : 0);
  }

  multi(): FakePipeline {
    return new FakePipeline(this);
  }

  // ── the synchronous halves the pipeline replays ──────────────────────────

  zremrangebyscoreSync(key: string, min: string, max: string): number {
    const set = this.zset(key);
    let removed = 0;
    for (const [member, score] of [...set]) {
      if (inRange(score, min, max)) {
        set.delete(member);
        removed += 1;
      }
    }
    return removed;
  }

  zaddSync(key: string, score: number, member: string): number {
    const set = this.zset(key);
    const isNew = !set.has(member);
    set.set(member, score);
    return isNew ? 1 : 0;
  }

  zcardSync(key: string): number {
    return this.zset(key).size;
  }

  pexpireSync(key: string, ms: number): number {
    this.expiries.set(key, ms);
    return 1;
  }

  private countInRange(key: string, min: string, max: string): number {
    let count = 0;
    for (const score of this.zset(key).values()) {
      if (inRange(score, min, max)) count += 1;
    }
    return count;
  }

  /** Everything Redis forgets on a flush, an eviction or a failover. */
  flush(): void {
    this.strings.clear();
    this.zsets.clear();
    this.expiries.clear();
  }
}

/** Redis range syntax: `-inf`, `+inf`, `123` (inclusive), `(123` (exclusive). */
function inRange(score: number, min: string, max: string): boolean {
  const lower = min === '-inf' ? -Infinity : Number(min.replace('(', ''));
  const upper = max === '+inf' ? Infinity : Number(max.replace('(', ''));
  const lowerOk = min.startsWith('(') ? score > lower : score >= lower;
  const upperOk = max.startsWith('(') ? score < upper : score <= upper;
  return lowerOk && upperOk;
}

export class FakePipeline {
  private readonly ops: Array<() => unknown> = [];

  constructor(private readonly redis: FakeRedis) {}

  zremrangebyscore(key: string, min: string, max: string): this {
    this.redis.commands.push(`zremrangebyscore ${key}`);
    this.ops.push(() => this.redis.zremrangebyscoreSync(key, min, max));
    return this;
  }

  zadd(key: string, score: number, member: string): this {
    this.redis.commands.push(`zadd ${key}`);
    this.ops.push(() => this.redis.zaddSync(key, score, member));
    return this;
  }

  zcard(key: string): this {
    this.redis.commands.push(`zcard ${key}`);
    this.ops.push(() => this.redis.zcardSync(key));
    return this;
  }

  pexpire(key: string, ms: number): this {
    this.redis.commands.push(`pexpire ${key}`);
    this.ops.push(() => this.redis.pexpireSync(key, ms));
    return this;
  }

  exec(): Promise<Reply[] | null> {
    // `null` is what ioredis returns when the MULTI was discarded — a
    // reconnect, or a watch failure. The service must treat it as "the counter
    // did not run", exactly as `RedisSigningRateLimiter` does.
    if (this.redis.down) return Promise.resolve(null);
    return Promise.resolve(this.ops.map((op) => [null, op()] as Reply));
  }
}
