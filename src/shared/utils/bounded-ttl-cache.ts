/**
 * An in-process cache with a size cap and a time to live.
 *
 * Least recently used first out: a `Map` keeps insertion order, and a read
 * re-inserts its key, so the first key is always the coldest. Entries past
 * their TTL read as absent and are dropped on the way. Keyed by anything a
 * caller can turn into a string — it must never grow with input an agent
 * controls, so each owner bounds it.
 */
export class BoundedTtlCache<V> {
  private readonly entries = new Map<string, { readonly value: V; readonly at: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (this.now() - entry.at >= this.ttlMs) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const coldest = this.entries.keys().next();
      if (coldest.done) break;
      this.entries.delete(coldest.value);
    }
    this.entries.set(key, { value, at: this.now() });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
