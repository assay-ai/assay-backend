import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  CacheableSessionSource,
  CachingSessionSource,
  RESUBSCRIBE_RETRY_MS,
  SESSION_EVICTIONS_CHANNEL,
  SessionCache,
  SessionEvictions,
} from '@modules/auth/session-cache';
import { BlocklistSessionSource } from '@modules/blocklist/services/blocklist-session.source';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

function session(overrides: Partial<McpSession> = {}): McpSession {
  return {
    credentialId: 'cred-1',
    storedCredential: true,
    organizationId: ORG,
    agentId: 'agent-1',
    agentAccount: 'eip155:1:0xabc' as never,
    chainId: 'eip155:1' as never,
    label: 'bot',
    callerKind: McpCallerKind.AGENT,
    delegateAccount: null,
    paymentsAllowed: true,
    ...overrides,
  };
}

class Clock {
  t = 1_000_000;
  now = () => this.t;
}

function source(
  answer: () => Promise<{ session: McpSession; notAfter: Date | null; cacheable?: boolean }>,
) {
  const resolveForCache = jest.fn((_token: string) => answer());
  const inner: CacheableSessionSource = {
    resolveForCache,
    resolve: async (token) => (await resolveForCache(token as string)).session,
  };
  return { inner, resolveForCache };
}

describe('SessionCache', () => {
  it('serves a copy until the TTL, then forgets it', () => {
    const clock = new Clock();
    const cache = new SessionCache(15_000, 10, clock.now);
    cache.set('k', session(), null, cache.generation);

    const first = cache.get('k') as McpSession;
    expect(first).toEqual(session());
    (first as { label: string | null }).label = 'mutated';
    expect(cache.get('k')?.label).toBe('bot');

    clock.t += 14_999;
    expect(cache.get('k')).toBeDefined();
    clock.t += 1;
    expect(cache.get('k')).toBeUndefined();
  });

  it('never outlives notAfter (a JWT exp, a key expiry)', () => {
    const clock = new Clock();
    const cache = new SessionCache(15_000, 10, clock.now);
    cache.set('k', session(), new Date(clock.t + 3_000), cache.generation);
    clock.t += 3_000;
    expect(cache.get('k')).toBeUndefined();

    cache.set('gone', session(), new Date(clock.t), cache.generation);
    expect(cache.get('gone')).toBeUndefined();
  });

  it('is bounded, dropping the least recently used', () => {
    const cache = new SessionCache(15_000, 2);
    cache.set('a', session(), null, cache.generation);
    cache.set('b', session(), null, cache.generation);
    cache.get('a');
    cache.set('c', session(), null, cache.generation);
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });

  it('evicts by organization, by credential, or everything', () => {
    const cache = new SessionCache();
    cache.set('a', session(), null, cache.generation);
    cache.set(
      'b',
      session({ organizationId: OTHER_ORG, credentialId: 'cred-2' }),
      null,
      cache.generation,
    );
    cache.set(
      'c',
      session({ organizationId: OTHER_ORG, credentialId: 'cred-3' }),
      null,
      cache.generation,
    );

    expect(cache.evict({ organizationId: ORG })).toBe(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.evict({ credentialId: 'cred-2' })).toBe(1);
    expect(cache.get('c')).toBeDefined();
    expect(cache.evict({ all: true })).toBe(1);
    expect(cache.size).toBe(0);
  });

  it('refuses to store what a resolve read before an eviction', () => {
    const cache = new SessionCache();
    const before = cache.generation;
    cache.evict({ organizationId: ORG });
    cache.set('k', session(), null, before);
    expect(cache.get('k')).toBeUndefined();
  });

  it("lets another organization's eviction pass: a ticket is refused only by its own scopes", () => {
    const cache = new SessionCache();
    const ticket = cache.generation;
    cache.evict({ organizationId: OTHER_ORG });
    cache.evict({ credentialId: 'cred-other' });
    cache.set('k', session(), null, ticket);
    expect(cache.get('k')).toBeDefined();

    const second = cache.generation;
    cache.evict({ credentialId: 'cred-1' });
    cache.set('k2', session(), null, second);
    expect(cache.get('k2')).toBeUndefined();

    const third = cache.generation;
    cache.evict({ all: true });
    cache.set('k3', session(), null, third);
    expect(cache.get('k3')).toBeUndefined();
    cache.set('k4', session(), null, cache.generation);
    expect(cache.get('k4')).toBeDefined();
  });

  it('stays bounded in eviction records, refusing what a pruned record could have refused', () => {
    const clock = new Clock();
    const cache = new SessionCache(15_000, 2, clock.now);
    const old = cache.generation;
    cache.evict({ organizationId: ORG });
    clock.t += 61_000;
    cache.evict({ organizationId: 'org-a' });
    cache.evict({ organizationId: 'org-b' });
    // ORG's record was pruned: the old ticket is refused anyway.
    cache.set('k', session(), null, old);
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', session(), null, cache.generation);
    expect(cache.get('k')).toBeDefined();
  });

  it('keys by source and sha256 of the token, never the token', () => {
    const key = SessionCache.keyOf('db', 'assay_sk_secret');
    expect(key).toMatch(/^db:[0-9a-f]{64}$/);
    expect(key).not.toContain('secret');
    expect(SessionCache.keyOf('oauth', 'assay_sk_secret')).not.toBe(key);
  });
});

describe('CachingSessionSource', () => {
  it('resolves once, then answers from the cache and replays the stamp', async () => {
    const cache = new SessionCache();
    const { inner, resolveForCache } = source(async () => ({ session: session(), notAfter: null }));
    const onHit = jest.fn();
    const caching = new CachingSessionSource('db', inner, cache, onHit);

    expect(await caching.resolve('token')).toEqual(session());
    expect(await caching.resolve('token')).toEqual(session());
    expect(resolveForCache).toHaveBeenCalledTimes(1);
    expect(onHit).toHaveBeenCalledTimes(1);
    expect(onHit).toHaveBeenCalledWith(session());
  });

  it('never caches a refusal: every bad token reaches the source, with its reason', async () => {
    const cache = new SessionCache();
    const refusal = McpErrors.credentialInvalid({ unauthorizedReason: 'revoked' });
    const { inner, resolveForCache } = source(async () => {
      throw refusal;
    });
    const caching = new CachingSessionSource('oauth', inner, cache);

    await expect(caching.resolve('bad')).rejects.toBe(refusal);
    await expect(caching.resolve('bad')).rejects.toBe(refusal);
    expect(resolveForCache).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('does not keep a session the source marks not cacheable', async () => {
    const cache = new SessionCache();
    const { inner, resolveForCache } = source(async () => ({
      session: session(),
      notAfter: null,
      cacheable: false,
    }));
    const caching = new CachingSessionSource('oauth', inner, cache);
    await caching.resolve('t');
    await caching.resolve('t');
    expect(resolveForCache).toHaveBeenCalledTimes(2);
  });

  it('passes a missing token straight through', async () => {
    const resolve = jest.fn().mockRejectedValue(McpErrors.credentialInvalid());
    const caching = new CachingSessionSource(
      'db',
      { resolve, resolveForCache: jest.fn() },
      new SessionCache(),
    );
    await expect(caching.resolve(null)).rejects.toBeDefined();
    expect(resolve).toHaveBeenCalledWith(null);
  });

  it('sits inside the blocklist: a block applies to a cached session at once', async () => {
    const cache = new SessionCache();
    const { inner } = source(async () => ({ session: session(), notAfter: null }));
    let blocked = false;
    const blocklist = {
      firstBlocked: () =>
        blocked ? { role: 'ORGANIZATION', hit: { subjectKind: 'ORGANIZATION' } } : null,
    } as unknown as AccountBlocklistService;
    const guarded = new BlocklistSessionSource(
      new CachingSessionSource('db', inner, cache),
      blocklist,
    );

    await guarded.resolve('t');
    blocked = true;
    await expect(guarded.resolve('t')).rejects.toMatchObject({
      errorCode: 'ACCOUNT_BLOCKED',
    });
  });
});

describe('SessionEvictions', () => {
  function build(status = 'ready') {
    const cache = new SessionCache();
    const handlers: Record<string, Array<(...args: string[]) => void>> = {};
    const subscriber = {
      status,
      on: jest.fn((event: string, handler: (...args: string[]) => void) => {
        (handlers[event] ??= []).push(handler);
      }),
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn(),
    };
    const publisher = { publish: jest.fn().mockResolvedValue(1), disconnect: jest.fn() };
    const evictions = new SessionEvictions(cache, publisher as never, subscriber as never);
    evictions.onModuleInit();
    const deliver = (message: string) =>
      (handlers.message ?? []).forEach((handler) => handler(SESSION_EVICTIONS_CHANNEL, message));
    const ready = () => (handlers.ready ?? []).forEach((handler) => handler());
    return { cache, publisher, subscriber, evictions, deliver, ready };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('subscribes on every (re)connection and drops what it cached while not listening', async () => {
    const { cache, subscriber, ready } = build('connecting');
    expect(subscriber.subscribe).not.toHaveBeenCalled();
    cache.set('k', session(), null, cache.generation);

    ready();
    await flush();
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);

    cache.set('k', session(), null, cache.generation);
    ready(); // a reconnect
    await flush();
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('retries a failed subscribe until it succeeds', async () => {
    jest.useFakeTimers();
    try {
      const { subscriber, evictions } = build('connecting');
      subscriber.subscribe.mockRejectedValueOnce(new Error('connection lost'));
      (evictions as unknown as { subscribe: () => Promise<void> }).subscribe();
      await Promise.resolve();
      await Promise.resolve();
      expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(RESUBSCRIBE_RETRY_MS);
      expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
      await evictions.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts locally before it publishes, then tells the other processes', async () => {
    const { cache, publisher, evictions } = build();
    cache.set('k', session(), null, cache.generation);

    await evictions.evictOrganization(ORG);

    expect(cache.get('k')).toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledWith(
      SESSION_EVICTIONS_CHANNEL,
      JSON.stringify({ organizationId: ORG }),
    );
  });

  it("applies another process's eviction, and clears everything on an unreadable one", async () => {
    const { cache, subscriber, deliver } = build();
    await flush();
    expect(subscriber.subscribe).toHaveBeenCalledWith(SESSION_EVICTIONS_CHANNEL);
    cache.set('a', session(), null, cache.generation);
    cache.set('b', session({ organizationId: OTHER_ORG }), null, cache.generation);

    deliver(JSON.stringify({ organizationId: ORG }));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();

    deliver('not json');
    expect(cache.size).toBe(0);
  });

  it('never fails the write it follows when Redis is down', async () => {
    const { cache, publisher, evictions } = build();
    publisher.publish.mockRejectedValue(new Error('connection refused'));
    cache.set('k', session(), null, cache.generation);
    await expect(evictions.evictOrganization(ORG)).resolves.toBeUndefined();
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('CachingSessionSource over a plain source', () => {
  it('never caches a source that cannot say how long its answer holds', async () => {
    const resolve = jest.fn().mockResolvedValue(session());
    const caching = new CachingSessionSource('privy', { resolve }, new SessionCache());
    await caching.resolve('t');
    await caching.resolve('t');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
