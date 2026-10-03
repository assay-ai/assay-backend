import type { Redis } from 'ioredis';

import { KillScope, findKill, killKey, keysCovering } from '@modules/verification/domain';
import {
  KillSwitchConfig,
  RedisPolicyKillSwitchService,
} from '@modules/verification/services/redis-policy-kill-switch.service';

/**
 * The kill switch, off Redis.
 *
 * Two things are proved here and nowhere else, because both need a clock a test
 * controls: that a snapshot this process cannot refresh withdraws **everything**
 * rather than continuing to enforce a list it can no longer confirm, and that
 * the poll alone carries the switch when the broadcast is lost.
 *
 * The part that cannot be faked — that a kill written by one process reaches
 * another, and how long that takes — is in
 * `test/integration/verification/kill-switch.integration.spec.ts` against a
 * real Redis.
 */

/** A Redis hash and a pub/sub channel, enough for the switch and nothing else. */
class FakeRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly handlers: Array<(channel: string, message: string) => void> = [];
  /** Set to drop broadcasts, so only the poll can carry a change. */
  deliverBroadcasts = true;
  /** Set to make every command throw, simulating an unreachable Redis. */
  down = false;

  private hash(key: string): Map<string, string> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key) as Map<string, string>;
  }

  hgetall(key: string): Promise<Record<string, string>> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    return Promise.resolve(Object.fromEntries(this.hash(key)));
  }

  hset(key: string, field: string, value: string): Promise<number> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    this.hash(key).set(field, value);
    return Promise.resolve(1);
  }

  hdel(key: string, field: string): Promise<number> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    return Promise.resolve(this.hash(key).delete(field) ? 1 : 0);
  }

  publish(channel: string, message: string): Promise<number> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    if (this.deliverBroadcasts) {
      for (const handler of this.handlers) handler(channel, message);
    }
    return Promise.resolve(this.handlers.length);
  }

  subscribe(): Promise<void> {
    return Promise.resolve();
  }

  unsubscribe(): Promise<void> {
    return Promise.resolve();
  }

  on(event: string, handler: (channel: string, message: string) => void): this {
    if (event === 'message') this.handlers.push(handler);
    return this;
  }
}

const POLICY_ID = 'search_web.default';

function build(overrides: Partial<KillSwitchConfig> = {}) {
  const store = new FakeRedis();
  let now = 1_000_000;

  const config: KillSwitchConfig = {
    namespace: 'test:killswitch',
    // Long enough that no test relies on the interval firing; every refresh
    // below is driven explicitly, so the assertions are about the mechanism
    // and not about jest's timer scheduling.
    pollIntervalMs: 60_000,
    staleAfterMs: 30_000,
    now: () => now,
    ...overrides,
  };

  const service = new RedisPolicyKillSwitchService(
    store as unknown as Redis,
    store as unknown as Redis,
    config,
  );

  return {
    store,
    service,
    config,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('killKey / keysCovering — the target vocabulary', () => {
  it('names the three scopes distinctly', () => {
    expect(killKey({ scope: KillScope.GLOBAL })).toBe('all');
    expect(killKey({ scope: KillScope.POLICY, policyId: POLICY_ID })).toBe(
      'policy:search_web.default',
    );
    expect(killKey({ scope: KillScope.POLICY_VERSION, policyId: POLICY_ID, version: 4 })).toBe(
      'policy:search_web.default@4',
    );
  });

  it('refuses a target that does not identify what it kills', () => {
    expect(() => killKey({ scope: KillScope.POLICY })).toThrow(/needs a policyId/);
    expect(() => killKey({ scope: KillScope.POLICY_VERSION, policyId: POLICY_ID })).toThrow(
      /needs a version/,
    );
  });

  it('covers a version with the global, the policy and the version key, broadest first', () => {
    expect(keysCovering(POLICY_ID, 4)).toEqual([
      'all',
      'policy:search_web.default',
      'policy:search_web.default@4',
    ]);
  });

  it('reports the broadest reason during an incident', () => {
    // A global halt and an incidental per-version kill both cover the call. The
    // operator wants to read their own "halting everything" on the receipt.
    const snapshot = new Map([
      [
        'all',
        {
          key: 'all',
          scope: KillScope.GLOBAL,
          policyId: null,
          version: null,
          reason: 'bad verifier deploy',
          actor: 'oncall',
          killedAt: '2026-08-16T03:00:00.000Z',
        },
      ],
      [
        'policy:search_web.default@4',
        {
          key: 'policy:search_web.default@4',
          scope: KillScope.POLICY_VERSION,
          policyId: POLICY_ID,
          version: 4,
          reason: 'unrelated',
          actor: 'alice',
          killedAt: '2026-08-15T00:00:00.000Z',
        },
      ],
    ]);

    expect(findKill(snapshot, POLICY_ID, 4)?.reason).toBe('bad verifier deploy');
  });
});

describe('RedisPolicyKillSwitchService — scopes', () => {
  it('a version kill covers that version and leaves the others enforcing', async () => {
    const { service } = build();
    await service.refresh();

    await service.kill(
      { scope: KillScope.POLICY_VERSION, policyId: POLICY_ID, version: 4 },
      'the freshness rule is wrong',
      'oncall',
    );

    expect(service.isKilled(POLICY_ID, 4)).not.toBeNull();
    expect(service.isKilled(POLICY_ID, 3)).toBeNull();
  });

  it('a policy kill covers every version of it', async () => {
    const { service } = build();
    await service.refresh();

    await service.kill({ scope: KillScope.POLICY, policyId: POLICY_ID }, 'all of it', 'oncall');

    expect(service.isKilled(POLICY_ID, 3)).not.toBeNull();
    expect(service.isKilled(POLICY_ID, 9)).not.toBeNull();
    expect(service.isKilled('other.policy', 1)).toBeNull();
  });

  it('a global kill covers every policy', async () => {
    const { service } = build();
    await service.refresh();

    await service.kill({ scope: KillScope.GLOBAL }, 'verification is off', 'oncall');

    expect(service.isKilled('anything', 1)?.scope).toBe(KillScope.GLOBAL);
  });

  it('revive puts a policy back and reports whether anything was withdrawn', async () => {
    const { service } = build();
    await service.refresh();
    const target = { scope: KillScope.POLICY_VERSION, policyId: POLICY_ID, version: 4 };

    await service.kill(target, 'wrong', 'oncall');
    expect(await service.revive(target, 'oncall')).toBe(true);
    expect(service.isKilled(POLICY_ID, 4)).toBeNull();

    expect(await service.revive(target, 'oncall')).toBe(false);
  });
});

describe('RedisPolicyKillSwitchService — the poll is the mechanism, the broadcast is the optimisation', () => {
  it('picks up a kill written by another process when the broadcast is lost', async () => {
    const writer = build();
    const reader = build();
    // One Redis, two processes. The reader never receives the broadcast.
    reader.store.hashes.set(
      'test:killswitch',
      writer.store.hashes.get('test:killswitch') ?? new Map(),
    );
    await reader.service.refresh();
    reader.store.deliverBroadcasts = false;

    // The writer's Redis is the reader's Redis.
    writer.store.hashes.set(
      'test:killswitch',
      reader.store.hashes.get('test:killswitch') as Map<string, string>,
    );
    await writer.service.kill(
      { scope: KillScope.POLICY_VERSION, policyId: POLICY_ID, version: 4 },
      'wrong rule',
      'oncall',
    );

    expect(reader.service.isKilled(POLICY_ID, 4)).toBeNull();

    // The poll — the same call the interval makes — carries it.
    await reader.service.refresh();
    expect(reader.service.isKilled(POLICY_ID, 4)?.reason).toBe('wrong rule');
  });
});

describe('RedisPolicyKillSwitchService — a snapshot it cannot trust withdraws everything', () => {
  it('enforces normally while the snapshot is fresh', async () => {
    const { service, advance } = build({ staleAfterMs: 30_000 });
    await service.refresh();

    advance(29_000);
    expect(service.isKilled(POLICY_ID, 4)).toBeNull();
  });

  it('withdraws every policy once the snapshot passes the staleness bound', async () => {
    // The expensive failure, chosen deliberately: an unreachable Redis turns
    // verification off platform-wide rather than leaving us enforcing a list we
    // can no longer confirm — during exactly the incident in which somebody is
    // likely to be trying to pull a policy.
    const { service, store, advance } = build({ staleAfterMs: 30_000 });
    await service.refresh();

    store.down = true;
    advance(31_000);

    const withdrawal = service.isKilled(POLICY_ID, 4);
    expect(withdrawal).not.toBeNull();
    expect(withdrawal?.scope).toBe(KillScope.GLOBAL);
    expect(withdrawal?.reason).toContain('could not be refreshed');
  });

  it('a process that never loaded a snapshot enforces nothing', async () => {
    const { service, store } = build();
    store.down = true;

    await expect(service.refresh()).rejects.toThrow();
    expect(service.snapshotAgeMs()).toBe(Number.POSITIVE_INFINITY);
    expect(service.isKilled(POLICY_ID, 4)).not.toBeNull();
  });

  it('recovers as soon as a refresh succeeds again', async () => {
    const { service, store, advance } = build({ staleAfterMs: 30_000 });
    await service.refresh();

    store.down = true;
    advance(31_000);
    expect(service.isKilled(POLICY_ID, 4)).not.toBeNull();

    store.down = false;
    await service.refresh();
    expect(service.isKilled(POLICY_ID, 4)).toBeNull();
  });
});

describe('RedisPolicyKillSwitchService — a corrupt record still kills', () => {
  it('treats an unreadable entry as engaged rather than ignoring it', async () => {
    const { service, store } = build();
    store.hashes.set(
      'test:killswitch',
      new Map([['policy:search_web.default@4', 'not json at all']]),
    );

    await service.refresh();

    expect(service.isKilled(POLICY_ID, 4)?.reason).toContain('could not be read');
  });
});
