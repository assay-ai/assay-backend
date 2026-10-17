/**
 * The Redis commands `McpIdempotencyStore` runs: `SET … PX … NX`, `GET`, and
 * its two scripts (compare-and-delete, compare-and-set). Recorded, not
 * enforced: a test expires a record with {@link expire} or loses all of them
 * with {@link flush}.
 */
export class FakeIdempotencyRedis {
  readonly strings = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly commands: string[] = [];
  /** Set to make every command reject, standing in for an unreachable Redis. */
  down = false;

  private guard(command: string): void {
    this.commands.push(command);
    if (this.down) throw new Error('redis is unreachable');
  }

  async set(key: string, value: string, _px: 'PX', ms: number, nx?: 'NX'): Promise<'OK' | null> {
    this.guard('set');
    if (nx === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    this.ttls.set(key, ms);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.guard('get');
    return this.strings.get(key) ?? null;
  }

  async eval(script: string, _keys: number, key: string, ...args: string[]): Promise<number> {
    const complete = script.includes("'SET'");
    this.guard(complete ? 'complete' : 'release');
    const current = this.strings.get(key);
    if (complete) {
      const [claimed, done, ms] = args;
      if (current !== undefined && current !== claimed) return 0;
      this.strings.set(key, done);
      this.ttls.set(key, Number(ms));
      return 1;
    }
    if (current !== args[0]) return 0;
    this.strings.delete(key);
    return 1;
  }

  /** The record's TTL ran out. */
  expire(key: string): void {
    this.strings.delete(key);
    this.ttls.delete(key);
  }

  /** Everything Redis forgets on a flush, an eviction or a failover. */
  flush(): void {
    this.strings.clear();
    this.ttls.clear();
  }

  /** The parsed records, for asserting what was (and was not) stored. */
  get records(): Array<Record<string, unknown>> {
    return [...this.strings.values()].map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}
