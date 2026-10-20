import { randomBytes } from 'node:crypto';

import { digestToken } from '@shared/crypto/token-digest';

/**
 * Opaque OAuth tokens (spec §6.2, R-OA-11, R-OA-12).
 *
 * ```text
 * access token        assay_at_ + base64url(32 random bytes)   1 h
 * refresh token       assay_rt_ + base64url(32 random bytes)   30 days
 * authorization code  assay_ac_ + base64url(32 random bytes)   60 s
 * ```
 *
 * Only `digestToken(token)` is stored. The prefix lets a session source refuse
 * anything that is not an access token before it reads the database (R-OA-20).
 */
export const OPAQUE_TOKEN_PREFIXES = ['assay_at_', 'assay_rt_', 'assay_ac_'] as const;
export type OpaqueTokenPrefix = (typeof OPAQUE_TOKEN_PREFIXES)[number];

const TOKEN_BYTES = 32;
/** base64url of 32 bytes, unpadded. */
const BODY_RE = /^[A-Za-z0-9_-]{43}$/;

export function mint(prefix: OpaqueTokenPrefix): string {
  if (!OPAQUE_TOKEN_PREFIXES.includes(prefix)) {
    throw new Error('mint: unknown opaque token prefix');
  }
  return prefix + randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hasPrefix(token: unknown, prefix: OpaqueTokenPrefix): token is string {
  return typeof token === 'string' && token.startsWith(prefix);
}

/** The prefix and a 43-character base64url body: the only shape {@link mint} produces. */
export function isWellFormed(token: unknown, prefix: OpaqueTokenPrefix): token is string {
  return hasPrefix(token, prefix) && BODY_RE.test(token.slice(prefix.length));
}

/** The stored form of a token; the same digest API keys use. */
export function hashOpaqueToken(token: string): string {
  return digestToken(token);
}
