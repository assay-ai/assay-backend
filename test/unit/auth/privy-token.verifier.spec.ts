import { PrivyTokenVerifier } from '@modules/auth/services/privy-token.verifier';
import { PrivyJwksCache } from '@modules/auth/services/privy-jwks.cache';

import {
  FakeJwksCache,
  TEST_PRIVY_CONFIG,
  createSigningKey,
  mintToken,
  withConfig,
} from './helpers/privy-tokens';

/**
 * Local ES256 verification.
 *
 * Every token here is really signed by a really generated P-256 key, so a
 * negative case differs from the positive one by exactly one thing — the key,
 * the algorithm, the audience, a byte of the signature — and nothing else.
 *
 * The suite's second job is the property the security rule actually asks for:
 * **there is only one negative answer.** `verify` returns `PrivyClaims | null`
 * with no error variants, so no amount of probing can separate "expired" from
 * "wrong audience" from "forged". The tests below assert `null` for all of
 * them deliberately, rather than asserting distinct reasons.
 */
describe('PrivyTokenVerifier — one yes, one no, and no way to tell the nos apart', () => {
  const key = createSigningKey('kid-live');

  function build(jwks: FakeJwksCache, config = TEST_PRIVY_CONFIG) {
    return new PrivyTokenVerifier(jwks as unknown as PrivyJwksCache, config);
  }

  it('accepts a token signed by a key in the JWKS and returns only the claims we read', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    const claims = await verifier.verify(mintToken({ key }));

    expect(claims).toEqual({
      subject: 'did:privy:test-subject',
      sessionId: 'session-1',
      expiresAt: expect.any(Date),
      issuedAt: expect.any(Date),
    });
  });

  it('looks the key up by the header kid', async () => {
    const jwks = FakeJwksCache.withKeys(key);

    await build(jwks).verify(mintToken({ key }));

    expect(jwks.requestedKids).toEqual(['kid-live']);
  });

  it('refuses a token signed by a different key of the right shape', async () => {
    const impostor = createSigningKey('kid-live');
    const verifier = build(FakeJwksCache.withKeys(key));

    // Same kid, same algorithm, same claims — a genuine ES256 signature made
    // by a key that is not Privy's.
    expect(await verifier.verify(mintToken({ key: impostor }))).toBeNull();
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));
    const [header, , signature] = mintToken({ key }).split('.');

    const tampered = Buffer.from(
      JSON.stringify({
        iss: 'privy.io',
        aud: TEST_PRIVY_CONFIG.appId,
        sub: 'did:privy:somebody-else',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      'utf8',
    ).toString('base64url');

    expect(await verifier.verify(`${header}.${tampered}.${signature}`)).toBeNull();
  });

  it('refuses alg: none, whatever the rest of the token says', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    const token = mintToken({ key, header: { alg: 'none' }, signature: '' });

    expect(await verifier.verify(token)).toBeNull();
  });

  it('refuses a token that claims a different algorithm than the one we pin', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    expect(await verifier.verify(mintToken({ key, header: { alg: 'RS256' } }))).toBeNull();
  });

  it('refuses a kid the key set does not contain', async () => {
    const rotated = createSigningKey('kid-rotated');
    const verifier = build(FakeJwksCache.withKeys(key));

    expect(await verifier.verify(mintToken({ key: rotated }))).toBeNull();
  });

  it('refuses a genuine token minted for another Privy application', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    expect(await verifier.verify(mintToken({ key, claims: { aud: 'somebody-elses-app' } }))).toBe(
      null,
    );
  });

  it('accepts an aud array that contains this application', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    const claims = await verifier.verify(
      mintToken({ key, claims: { aud: ['another-app', TEST_PRIVY_CONFIG.appId] } }),
    );

    expect(claims?.subject).toBe('did:privy:test-subject');
  });

  it('refuses an unexpected issuer', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    expect(await verifier.verify(mintToken({ key, claims: { iss: 'not-privy.io' } }))).toBeNull();
  });

  it('refuses an expired token, and accepts one expired inside the skew window', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));
    const nowSeconds = Math.floor(Date.now() / 1000);

    expect(await verifier.verify(mintToken({ key, claims: { exp: nowSeconds - 600 } }))).toBeNull();

    // 30s past expiry with a 60s skew allowance: still accepted, which is the
    // whole reason the allowance exists.
    const nearlyExpired = await verifier.verify(
      mintToken({ key, claims: { exp: nowSeconds - 30 } }),
    );
    expect(nearlyExpired?.subject).toBe('did:privy:test-subject');
  });

  it('refuses a token with no exp at all', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    expect(await verifier.verify(mintToken({ key, claims: { exp: undefined } }))).toBeNull();
  });

  it('refuses a token issued in the future beyond the skew', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));
    const nowSeconds = Math.floor(Date.now() / 1000);

    expect(await verifier.verify(mintToken({ key, claims: { iat: nowSeconds + 600 } }))).toBeNull();
  });

  it('honours nbf', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));
    const nowSeconds = Math.floor(Date.now() / 1000);

    expect(await verifier.verify(mintToken({ key, claims: { nbf: nowSeconds + 600 } }))).toBeNull();
  });

  it('refuses anything that is not three base64url segments', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    for (const candidate of ['', 'not-a-token', 'a.b', 'a.b.c.d', '!!!.???.***']) {
      expect(await verifier.verify(candidate)).toBeNull();
    }
  });

  it('refuses a subject that is missing, empty or longer than the column', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    expect(await verifier.verify(mintToken({ key, claims: { sub: undefined } }))).toBeNull();
    expect(await verifier.verify(mintToken({ key, claims: { sub: '' } }))).toBeNull();
    expect(await verifier.verify(mintToken({ key, claims: { sub: 'x'.repeat(129) } }))).toBeNull();
  });

  it('falls back to the subject when a token carries no session id', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));

    const claims = await verifier.verify(mintToken({ key, claims: { sid: undefined } }));

    expect(claims?.sessionId).toBeNull();
  });

  it('refuses every token when no app id is configured, rather than checking a vacuous audience', async () => {
    const verifier = build(FakeJwksCache.withKeys(key), withConfig({ appId: '' }));

    expect(await verifier.verify(mintToken({ key, claims: { aud: '' } }))).toBeNull();
  });

  it('propagates the fail-closed error when there is no usable key set at all', async () => {
    const jwks = FakeJwksCache.withKeys(key);
    jwks.unavailable = new Error('AUTH_IDENTITY_PROVIDER_UNAVAILABLE');

    await expect(build(jwks).verify(mintToken({ key }))).rejects.toThrow(
      'AUTH_IDENTITY_PROVIDER_UNAVAILABLE',
    );
  });

  it('never puts the token, or any part of it, in what it returns', async () => {
    const verifier = build(FakeJwksCache.withKeys(key));
    const token = mintToken({ key });

    const claims = await verifier.verify(token);

    expect(JSON.stringify(claims)).not.toContain(token.split('.')[2]);
  });
});
