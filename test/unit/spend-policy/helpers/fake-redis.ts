/**
 * The handful of Redis commands `SpendPolicyVelocityService` needs.
 *
 * Same reasoning as `test/unit/tool/helpers/fake-redis.ts`: a real Redis
 * proves nothing extra here — every claim under test is about which command
 * runs against which key with what argument, which a fake records and a real
 * server hides. Not shared with that file because this one needs `incr` and
 * `incrby` *inside* a pipeline (`BindingCeilingService` only ever pipelines
 * sorted-set commands), and `set … EX … NX` standalone, which that fake does
 * not model.
 */
export type Reply = [Error | null, unknown];

export class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly expiries = new Map<string, number>();
  readonly commands: string[] = [];
  /** Set to make every command reject, standing in for an unreachable Redis. */
  down = false;

  private guard(command: string): void {
    this.commands.push(command);
    if (this.down) throw new Error('redis is unreachable');
  }

  get(key: string): Promise<string | null> {
    try {
      this.guard(`get ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  /**
   * `SET key value EX seconds NX` — the incident flag — or `PX ms NX`, the
   * agent spend lock. The expiry is recorded, not enforced.
   */
  set(
    key: string,
    value: string,
    _ex: 'EX' | 'PX',
    seconds: number,
    nx?: 'NX',
  ): Promise<'OK' | null> {
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

  /** The spend lock's compare-and-delete script, and only that one. */
  eval(_script: string, _keys: number, key: string, token: string): Promise<number> {
    try {
      this.guard(`eval ${key}`);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.strings.get(key) !== token) return Promise.resolve(0);
    this.strings.delete(key);
    return Promise.resolve(1);
  }

  incrSync(key: string): number {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }

  incrbySync(key: string, amount: string | number): number {
    const next = BigInt(this.strings.get(key) ?? '0') + BigInt(amount);
    this.strings.set(key, next.toString());
    return Number(next);
  }

  pexpireSync(key: string, ms: number): number {
    this.expiries.set(key, ms);
    return 1;
  }

  multi(): FakePipeline {
    return new FakePipeline(this);
  }

  /** Everything Redis forgets on a flush, an eviction or a failover. */
  flush(): void {
    this.strings.clear();
    this.expiries.clear();
  }
}

export class FakePipeline {
  private readonly ops: Array<() => unknown> = [];

  constructor(private readonly redis: FakeRedis) {}

  incr(key: string): this {
    this.redis.commands.push(`incr ${key}`);
    this.ops.push(() => this.redis.incrSync(key));
    return this;
  }

  incrby(key: string, amount: string | number): this {
    this.redis.commands.push(`incrby ${key}`);
    this.ops.push(() => this.redis.incrbySync(key, amount));
    return this;
  }

  pexpire(key: string, ms: number): this {
    this.redis.commands.push(`pexpire ${key}`);
    this.ops.push(() => this.redis.pexpireSync(key, ms));
    return this;
  }

  exec(): Promise<Reply[] | null> {
    // `null` is what ioredis returns when the MULTI was discarded — a
    // reconnect, or a watch failure. The service treats it as "nothing was
    // counted", which fails closed (see `SpendPolicyVelocityService`'s class
    // doc).
    if (this.redis.down) return Promise.resolve(null);
    return Promise.resolve(this.ops.map((op) => [null, op()] as Reply));
  }
}
