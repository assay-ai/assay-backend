import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  DEFAULT_PROVIDER_EGRESS_LIMITS,
  EGRESS_SLOT_TTL_MS,
  ProviderEgressLimiter,
} from '@modules/provider/services/provider-egress-limiter.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeRateRedis } from '../shared/rate-limit/fake-rate-redis';

/**
 * Review P-4 / P-5: the mapping tester and the connectivity check run in the
 * API process on a URL the provider typed, with no bound on concurrency or rate.
 */
describe('ProviderEgressLimiter', () => {
  const LIMITS = {
    perOrganizationConcurrent: 2,
    globalConcurrent: 3,
    globalConnectivityConcurrent: 1,
    perOrganizationConnectivityConcurrent: 1,
    perOrganizationPerWindow: 4,
    windowMs: 60_000,
  };

  function gate(): { promise: Promise<void>; open: () => void } {
    let open = () => {};
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  it('refuses a third concurrent run for one organization, and frees the slot after', async () => {
    const limiter = new ProviderEgressLimiter(LIMITS);
    const g = gate();
    const first = limiter.run('org-a', () => g.promise);
    const second = limiter.run('org-a', () => g.promise);

    await expectErrorCodeAsync(
      () => limiter.run('org-a', () => Promise.resolve()),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );

    g.open();
    await Promise.all([first, second]);
    await expect(limiter.run('org-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('caps the whole process, across organizations', async () => {
    const limiter = new ProviderEgressLimiter(LIMITS);
    const g = gate();
    const running = [
      limiter.run('org-a', () => g.promise),
      limiter.run('org-b', () => g.promise),
      limiter.run('org-c', () => g.promise),
    ];

    await expectErrorCodeAsync(
      () => limiter.run('org-d', () => Promise.resolve()),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );

    g.open();
    await Promise.all(running);
  });

  it('keeps connectivity checks in a pool of their own: a full tester pool does not deny them (N-3)', async () => {
    const limiter = new ProviderEgressLimiter(LIMITS);
    const g = gate();
    const testers = [
      limiter.run('org-a', () => g.promise),
      limiter.run('org-b', () => g.promise),
      limiter.run('org-c', () => g.promise),
    ];

    const check = limiter.run('org-d', () => g.promise, 'connectivity');
    // ...and the connectivity pool is capped on its own.
    await expectErrorCodeAsync(
      () => limiter.run('org-e', () => Promise.resolve(), 'connectivity'),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
    await expectErrorCodeAsync(
      () => limiter.run('org-e', () => Promise.resolve()),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );

    g.open();
    await Promise.all([...testers, check]);
  });

  it('counts both pools against one organization', async () => {
    const limiter = new ProviderEgressLimiter({ ...LIMITS, globalConnectivityConcurrent: 3 });
    const g = gate();
    const running = [
      limiter.run('org-a', () => g.promise),
      limiter.run('org-a', () => g.promise, 'connectivity'),
    ];

    await expectErrorCodeAsync(
      () => limiter.run('org-a', () => Promise.resolve(), 'connectivity'),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );

    g.open();
    await Promise.all(running);
  });

  /**
   * Round-two review R2-4: with two checks per organization, four accounts
   * held all eight connectivity slots open against a stalling endpoint. One
   * check per organization and a pool of sixteen need sixteen.
   */
  it('lets one organization hold one connectivity check at a time', async () => {
    const limiter = new ProviderEgressLimiter();
    const g = gate();
    const check = limiter.run('org-a', () => g.promise, 'connectivity');

    await expectErrorCodeAsync(
      () => limiter.run('org-a', () => Promise.resolve(), 'connectivity'),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
    // The organization's other slot is still there for the tester.
    const tester = limiter.run('org-a', () => g.promise);

    g.open();
    await Promise.all([check, tester]);
  });

  it('takes at least eight organizations to fill the default connectivity pool', async () => {
    const limiter = new ProviderEgressLimiter();
    const g = gate();
    const running: Promise<unknown>[] = [];
    let organizations = 0;
    for (;;) {
      const org = `org-${organizations}`;
      const before = running.length;
      for (let i = 0; i < DEFAULT_PROVIDER_EGRESS_LIMITS.perOrganizationConcurrent; i += 1) {
        running.push(limiter.run(org, () => g.promise, 'connectivity').catch((error) => error));
      }
      await new Promise((resolve) => setImmediate(resolve));
      const settled = await Promise.all(
        running.slice(before).map((p) => Promise.race([p, Promise.resolve('running')])),
      );
      if (settled.every((outcome) => outcome !== 'running')) break; // all refused: the pool is full
      organizations += 1;
    }

    expect(organizations).toBeGreaterThanOrEqual(8);
    g.open();
    await Promise.all(running);
  });

  it('limits how many runs one organization may start per window, even sequentially', async () => {
    const limiter = new ProviderEgressLimiter(LIMITS);
    for (let i = 0; i < LIMITS.perOrganizationPerWindow; i += 1) {
      await limiter.run('org-a', () => Promise.resolve());
    }

    await expectErrorCodeAsync(
      () => limiter.run('org-a', () => Promise.resolve()),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
    // Another organization has its own budget.
    await expect(limiter.run('org-b', () => Promise.resolve(1))).resolves.toBe(1);
  });

  it('releases the slot when the work throws', async () => {
    const limiter = new ProviderEgressLimiter(LIMITS);
    await expect(limiter.run('org-a', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(limiter.run('org-a', () => Promise.resolve(2))).resolves.toBe(2);
    await expect(limiter.run('org-a', () => Promise.resolve(3))).resolves.toBe(3);
  });

  it('does not start the work when refusing', async () => {
    const limiter = new ProviderEgressLimiter({ ...LIMITS, perOrganizationPerWindow: 0 });
    const work = jest.fn(() => Promise.resolve());

    await expectErrorCodeAsync(
      () => limiter.run('org-a', work),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
    expect(work).not.toHaveBeenCalled();
  });
});

/**
 * The per-organization counts in Redis: one bound across API replicas, the
 * process pools still per replica, and this process's own counts when Redis
 * is out.
 */
describe('ProviderEgressLimiter with Redis', () => {
  const LIMITS = {
    perOrganizationConcurrent: 2,
    globalConcurrent: 8,
    globalConnectivityConcurrent: 8,
    perOrganizationConnectivityConcurrent: 1,
    perOrganizationPerWindow: 4,
    windowMs: 60_000,
  };

  function gate(): { promise: Promise<void>; open: () => void } {
    let open = () => {};
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  const replicas = (redis: unknown) => [
    new ProviderEgressLimiter(LIMITS, redis as never),
    new ProviderEgressLimiter(LIMITS, redis as never),
  ];
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('holds one organization to its concurrency across replicas', async () => {
    const { redis, sets } = fakeRateRedis();
    const [a, b] = replicas(redis);
    const g = gate();
    const running = [a.run('org-a', () => g.promise), b.run('org-a', () => g.promise)];
    await settle();

    await expectErrorCodeAsync(
      () => a.run('org-a', () => Promise.resolve()),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
    await expect(b.run('org-b', () => Promise.resolve('other org'))).resolves.toBe('other org');

    g.open();
    await Promise.all(running);
    await settle();
    expect(sets.get('rate:egress:in-flight:org-a')?.size).toBe(0);
    await expect(b.run('org-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('counts the per-minute starts across replicas, and a refused run uses none', async () => {
    const { redis } = fakeRateRedis();
    const [a, b] = replicas(redis);
    const g = gate();

    // Two in flight, then two refused for concurrency: those do not count.
    const running = [a.run('org-a', () => g.promise), b.run('org-a', () => g.promise)];
    await settle();
    for (const limiter of [a, b]) {
      await expectErrorCodeAsync(
        () => limiter.run('org-a', () => Promise.resolve()),
        ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
      );
    }
    g.open();
    await Promise.all(running);
    await settle();

    await a.run('org-a', () => Promise.resolve());
    await b.run('org-a', () => Promise.resolve());
    await expectErrorCodeAsync(
      () => a.run('org-a', () => Promise.resolve()),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
  });

  it('allows one connectivity check per organization across replicas', async () => {
    const { redis } = fakeRateRedis();
    const [a, b] = replicas(redis);
    const g = gate();
    const check = a.run('org-a', () => g.promise, 'connectivity');
    await settle();

    await expectErrorCodeAsync(
      () => b.run('org-a', () => Promise.resolve(), 'connectivity'),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
    // The organization's other slot is still there for the tester.
    const tester = b.run('org-a', () => g.promise);

    g.open();
    await Promise.all([check, tester]);
  });

  it('falls back to this process’s counts when Redis fails, which still limit', async () => {
    const { redis } = fakeRateRedis();
    redis.fail = true;
    const limiter = new ProviderEgressLimiter(LIMITS, redis as never);

    for (let i = 0; i < LIMITS.perOrganizationPerWindow; i += 1) {
      await limiter.run('org-a', () => Promise.resolve());
    }
    await expectErrorCodeAsync(
      () => limiter.run('org-a', () => Promise.resolve()),
      ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
    );
    // One failed call, then Redis is left alone for a while.
    expect(redis.calls).toBe(1);
  });

  it('frees the Redis slot when the work throws', async () => {
    const { redis, sets } = fakeRateRedis();
    const limiter = new ProviderEgressLimiter(LIMITS, redis as never);

    await expect(limiter.run('org-a', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await settle();
    expect(sets.get('rate:egress:in-flight:org-a')?.size).toBe(0);
  });

  it('frees a slot whose release was lost once it expires, however often the org retries', async () => {
    const { redis } = fakeRateRedis();
    const limiter = new ProviderEgressLimiter(
      { ...LIMITS, perOrganizationConcurrent: 1, perOrganizationPerWindow: 1_000 },
      redis as never,
    );
    let now = 20_000_000;
    limiter.now = () => now;
    // A replica that died mid-run: its slot is taken and never given back.
    const hung = limiter.run('org-a', () => new Promise<void>(() => undefined));
    await settle();

    for (let i = 0; i < 30; i += 1) {
      now += 3_000;
      await expectErrorCodeAsync(
        () => limiter.run('org-a', () => Promise.resolve()),
        ProviderErrorCode.PROVIDER_EGRESS_RATE_LIMITED,
      );
    }
    now = 20_000_000 + EGRESS_SLOT_TTL_MS;
    await expect(limiter.run('org-a', () => Promise.resolve('freed'))).resolves.toBe('freed');
    void hung;
  });
});
