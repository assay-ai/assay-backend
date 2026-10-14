import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderEgressLimiter } from '@modules/provider/services/provider-egress-limiter.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * Review P-4 / P-5: the mapping tester and the connectivity check run in the
 * API process on a URL the provider typed, with no bound on concurrency or rate.
 */
describe('ProviderEgressLimiter', () => {
  const LIMITS = {
    perOrganizationConcurrent: 2,
    globalConcurrent: 3,
    globalConnectivityConcurrent: 1,
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
