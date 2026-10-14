/**
 * The Redis commands the operator sign-in, session store and throttle use, in
 * memory, with TTLs honoured against a controllable clock.
 */
export class FakeOperatorRedis {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();
  private readonly sets = new Map<string, Set<string>>();
  now = () => Date.now();

  private live(key: string) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }

  keys(): string[] {
    return [...this.values.keys()].filter((key) => this.live(key));
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, mode?: string, seconds?: number): Promise<'OK'> {
    this.values.set(key, {
      value,
      expiresAt: mode === 'EX' && seconds ? this.now() + seconds * 1000 : null,
    });
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.live(key)?.value ?? null;
    this.values.delete(key);
    return value;
  }

  async incr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = Number(entry?.value ?? 0) + 1;
    this.values.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (entry) entry.expiresAt = this.now() + seconds * 1000;
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key) || this.sets.delete(key)) removed += 1;
    }
    return removed;
  }

  async sadd(key: string, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(member);
    this.sets.set(key, set);
    return 1;
  }

  async srem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  multi() {
    const queued: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (key: string, value: string, mode?: string, seconds?: number) => {
        queued.push(() => this.set(key, value, mode, seconds));
        return chain;
      },
      sadd: (key: string, member: string) => {
        queued.push(() => this.sadd(key, member));
        return chain;
      },
      expire: (key: string, seconds: number) => {
        queued.push(() => this.expire(key, seconds));
        return chain;
      },
      exec: async () => {
        const results: unknown[] = [];
        for (const run of queued) results.push([null, await run()]);
        return results;
      },
    };
    return chain;
  }
}
