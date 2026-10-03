import { KeyObject, generateKeyPairSync, sign } from 'node:crypto';

import { PrivyAuthConfig } from '@modules/auth/domain/privy-auth.config';

/**
 * Real ES256 keys and real signatures, minted in-process.
 *
 * The alternative — a fixture token with a fixture key — pins the suite to one
 * captured moment and cannot express "the same payload signed by the *wrong*
 * key", which is the case that matters most here. Generating a P-256 pair per
 * test costs about a millisecond and lets every negative case be built by
 * changing exactly one thing about an otherwise valid token.
 */
export interface TestSigningKey {
  readonly kid: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  /** The public half in the shape a JWKS document carries it. */
  readonly jwk: Record<string, unknown>;
}

export function createSigningKey(kid: string): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

  return {
    kid,
    publicKey,
    privateKey,
    jwk: { ...jwk, kid, use: 'sig', alg: 'ES256' },
  };
}

export interface MintOptions {
  readonly key: TestSigningKey;
  readonly claims?: Record<string, unknown>;
  /** Overrides the header, e.g. to claim `alg: "none"`. */
  readonly header?: Record<string, unknown>;
  /** Replaces the computed signature — for the tampered-token cases. */
  readonly signature?: string;
}

/** A well-formed token for `TEST_PRIVY_CONFIG`, with whatever claims the test needs. */
export function mintToken(options: MintOptions): string {
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: options.key.kid,
    ...options.header,
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    iss: TEST_PRIVY_CONFIG.issuer,
    aud: TEST_PRIVY_CONFIG.appId,
    sub: 'did:privy:test-subject',
    sid: 'session-1',
    iat: nowSeconds - 10,
    exp: nowSeconds + 3600,
    ...options.claims,
  };

  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature =
    options.signature ??
    sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: options.key.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');

  return `${signingInput}.${signature}`;
}

export const TEST_PRIVY_CONFIG: PrivyAuthConfig = Object.freeze({
  appId: 'test-app-id',
  appSecret: 'test-app-secret',
  apiBaseUrl: 'https://auth.privy.io',
  issuer: 'privy.io',
  jwksUrl: 'https://auth.privy.io/api/v1/apps/test-app-id/jwks.json',
  jwksTtlMs: 600_000,
  jwksStaleGraceMs: 3_600_000,
  jwksMinRefreshMs: 60_000,
  clockSkewMs: 60_000,
  defaultChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  userLookupEnabled: true,
});

export function withConfig(overrides: Partial<PrivyAuthConfig>): PrivyAuthConfig {
  return Object.freeze({ ...TEST_PRIVY_CONFIG, ...overrides });
}

/**
 * A stand-in for `PrivyJwksCache` that holds keys rather than recording calls.
 *
 * Same rule as every other fake in this suite: what the verifier's tests need
 * to assert is *which key a token was checked against*, and a map of keys can
 * answer that.
 */
export class FakeJwksCache {
  readonly requestedKids: string[] = [];
  /** Set to make every lookup throw — the fail-closed branch. */
  unavailable: Error | null = null;

  constructor(private readonly keys: Map<string, KeyObject> = new Map()) {}

  static withKeys(...keys: TestSigningKey[]): FakeJwksCache {
    return new FakeJwksCache(new Map(keys.map((key) => [key.kid, key.publicKey])));
  }

  getKey(kid: string): Promise<KeyObject | null> {
    this.requestedKids.push(kid);
    if (this.unavailable) return Promise.reject(this.unavailable);
    return Promise.resolve(this.keys.get(kid) ?? null);
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
