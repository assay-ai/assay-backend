/**
 * A tiny in-process cache for the public Explorer routes.
 *
 * One promise per key, reused until it expires, so concurrent requests share
 * the load in flight. A rejected load is dropped at once, so a failure is
 * never served from cache. Keys are bounded by the caller — the public
 * catalogue only caches ids it has already listed.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** `at` overrides the clock for this call — for a caller that already holds "now". */
  get(key: string, load: () => Promise<T>, at: number = this.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > at) return hit.value;

    const value = load();
    const entry = { expiresAt: at + this.ttlMs, value };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }
}
