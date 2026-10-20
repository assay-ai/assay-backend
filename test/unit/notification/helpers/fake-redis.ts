/**
 * The one Redis command `NotificationService`'s suppression check needs:
 * `SET key value EX seconds NX`.
 *
 * Same shape as `test/unit/tool/helpers/fake-redis.ts` — a fake proves what a
 * real server hides (which command ran, with which arguments), and this file
 * exists separately because the notification suite needs none of the sorted-set
 * commands that fake carries.
 */
export class FakeRedis {
  private readonly strings = new Map<string, string>();
  readonly commands: string[] = [];
  /** The TTL each key was claimed with, so a test can assert the window, not just the call. */
  readonly ttls = new Map<string, number>();
  /** Set to make every command reject, standing in for an unreachable Redis. */
  down = false;

  set(key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX'): Promise<'OK' | null> {
    this.commands.push(`set ${key}`);
    if (this.down) {
      return Promise.reject(new Error('redis is unreachable'));
    }
    if (nx === 'NX' && this.strings.has(key)) {
      return Promise.resolve(null);
    }
    this.strings.set(key, value);
    this.ttls.set(key, seconds);
    return Promise.resolve('OK');
  }

  /** Releases a claim (`NotificationService` on a failed write). */
  del(key: string): Promise<number> {
    this.commands.push(`del ${key}`);
    if (this.down) {
      return Promise.reject(new Error('redis is unreachable'));
    }
    const existed = this.strings.delete(key);
    this.ttls.delete(key);
    return Promise.resolve(existed ? 1 : 0);
  }

  exists(key: string): Promise<number> {
    this.commands.push(`exists ${key}`);
    if (this.down) {
      return Promise.reject(new Error('redis is unreachable'));
    }
    return Promise.resolve(this.strings.has(key) ? 1 : 0);
  }

  flush(): void {
    this.strings.clear();
    this.ttls.clear();
    this.commands.length = 0;
  }
}
