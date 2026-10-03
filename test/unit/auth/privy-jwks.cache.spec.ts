import { EgressHttpClient } from '@shared/network/egress';
import { PrivyJwksCache } from '@modules/auth/services/privy-jwks.cache';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { FakeEgressHttpClient, okResponse } from './helpers/fake-egress';
import { TEST_PRIVY_CONFIG, createSigningKey, withConfig } from './helpers/privy-tokens';

/**
 * The one thing on the auth path that talks to Privy.
 *
 * Two properties are load-bearing and both are asserted here rather than
 * argued about in a docstring:
 *
 * - **It fails closed.** No key set and no usable cache means every token is
 *   refused, not admitted.
 * - **It does not fail *open* in the other direction either** — a Privy outage
 *   with keys already in hand keeps working, because logging every agent out
 *   because a third party is having a bad ten minutes is its own outage.
 */
describe('PrivyJwksCache — cached, bounded, and closed when it has nothing', () => {
  const key = createSigningKey('kid-a');
  const rotated = createSigningKey('kid-b');

  function jwksBody(...keys: Array<{ jwk: Record<string, unknown> }>) {
    return JSON.stringify({ keys: keys.map((entry) => entry.jwk) });
  }

  function build(egress: FakeEgressHttpClient, config = TEST_PRIVY_CONFIG) {
    return new PrivyJwksCache(egress as unknown as EgressHttpClient, config);
  }

  it('fetches once and answers every later lookup from memory', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(200, jwksBody(key, rotated)),
    );
    const cache = build(egress);

    expect(await cache.getKey('kid-a')).not.toBeNull();
    expect(await cache.getKey('kid-b')).not.toBeNull();
    expect(await cache.getKey('kid-a')).not.toBeNull();

    expect(egress.requests).toHaveLength(1);
  });

  it('asks for the configured JWKS URL, and sends no credentials with it', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() => okResponse(200, jwksBody(key)));

    await build(egress).getKey('kid-a');

    expect(egress.lastRequest?.url).toBe(TEST_PRIVY_CONFIG.jwksUrl);
    expect(egress.lastRequest?.method).toBe('GET');
    expect(Object.keys(egress.lastRequest?.headers ?? {})).not.toContain('authorization');
  });

  it('follows no redirects and caps the response, because this sits in front of authentication', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() => okResponse(200, jwksBody(key)));

    await build(egress).getKey('kid-a');

    expect(egress.lastRequest?.policy?.limits.maxRedirects).toBe(0);
    expect(egress.lastRequest?.policy?.limits.maxResponseBytes).toBe(64 * 1024);
  });

  it('collapses concurrent cold lookups into one outbound fetch', async () => {
    let resolveFetch: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });

    const egress = new FakeEgressHttpClient().respondWith(async () => {
      await gate;
      return okResponse(200, jwksBody(key));
    });
    const cache = build(egress);

    const lookups = Promise.all([cache.getKey('kid-a'), cache.getKey('kid-a')]);
    resolveFetch?.();

    const [first, second] = await lookups;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(egress.requests).toHaveLength(1);
  });

  it('refuses — it does not admit — when the first fetch fails and nothing is cached', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() => {
      throw new Error('connection refused');
    });

    await expectErrorCodeAsync(
      () => build(egress).getKey('kid-a'),
      'AUTH_IDENTITY_PROVIDER_UNAVAILABLE',
    );
  });

  it('refuses a JWKS that parses but contains no usable ES256 key', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(200, JSON.stringify({ keys: [{ kty: 'RSA', kid: 'rsa-1', n: 'x', e: 'AQAB' }] })),
    );

    await expectErrorCodeAsync(
      () => build(egress).getKey('rsa-1'),
      'AUTH_IDENTITY_PROVIDER_UNAVAILABLE',
    );
  });

  it('refuses a non-200 from the JWKS endpoint', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() => okResponse(503, 'upstream down'));

    await expectErrorCodeAsync(
      () => build(egress).getKey('kid-a'),
      'AUTH_IDENTITY_PROVIDER_UNAVAILABLE',
    );
  });

  it('keeps serving cached keys while a refresh is failing, inside the grace window', async () => {
    let healthy = true;
    const egress = new FakeEgressHttpClient().respondWith(() => {
      if (!healthy) throw new Error('privy is down');
      return okResponse(200, jwksBody(key));
    });

    // One second of freshness, an hour of grace: the second lookup is past the
    // TTL, so it tries to refresh, fails, and must still answer.
    const cache = build(egress, withConfig({ jwksTtlMs: 1, jwksStaleGraceMs: 3_600_000 }));

    expect(await cache.getKey('kid-a')).not.toBeNull();

    healthy = false;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await cache.getKey('kid-a')).not.toBeNull();
    expect(egress.requests.length).toBeGreaterThan(1);
  });

  it('stops serving cached keys once the grace window has passed', async () => {
    let healthy = true;
    const egress = new FakeEgressHttpClient().respondWith(() => {
      if (!healthy) throw new Error('privy is down');
      return okResponse(200, jwksBody(key));
    });

    const cache = build(egress, withConfig({ jwksTtlMs: 1, jwksStaleGraceMs: 0 }));

    expect(await cache.getKey('kid-a')).not.toBeNull();

    healthy = false;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expectErrorCodeAsync(() => cache.getKey('kid-a'), 'AUTH_IDENTITY_PROVIDER_UNAVAILABLE');
  });

  it('re-fetches for an unrecognised kid — a rotation is a kid we have never seen', async () => {
    let published = [key];
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(200, jwksBody(...published)),
    );

    const cache = build(egress, withConfig({ jwksMinRefreshMs: 0 }));

    expect(await cache.getKey('kid-a')).not.toBeNull();
    expect(await cache.getKey('kid-b')).toBeNull();

    published = [key, rotated];
    expect(await cache.getKey('kid-b')).not.toBeNull();
  });

  it('does not let a stream of unknown kids become a request amplifier', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() => okResponse(200, jwksBody(key)));

    // The default 60s floor: the first unknown kid buys one refresh, the next
    // forty do not.
    const cache = build(egress);
    await cache.getKey('kid-a');
    const afterWarmup = egress.requests.length;

    for (let i = 0; i < 40; i += 1) {
      expect(await cache.getKey(`forged-${i}`)).toBeNull();
    }

    expect(egress.requests.length - afterWarmup).toBeLessThanOrEqual(1);
  });

  it('keeps the rest of a key set when one member cannot be imported', async () => {
    const egress = new FakeEgressHttpClient().respondWith(() =>
      okResponse(
        200,
        JSON.stringify({
          keys: [
            { kty: 'EC', crv: 'P-256', kid: 'broken', x: 'not-base64url!', y: '???' },
            key.jwk,
          ],
        }),
      ),
    );

    const cache = build(egress);

    expect(await cache.getKey('kid-a')).not.toBeNull();
  });
});
