import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PKCE, S256 only (RFC 7636; spec §6.3.4, §6.3.10, R-OA-4, R-OA-5).
 *
 * ```text
 * code_challenge         ^[A-Za-z0-9_-]{43}$        BASE64URL(SHA256(verifier)), unpadded
 * code_challenge_method  S256                       `plain` is not a method
 * code_verifier          ^[A-Za-z0-9\-._~]{43,128}$
 * ```
 */
export const CODE_CHALLENGE_METHODS: readonly string[] = ['S256'];

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isSupportedChallengeMethod(method: unknown): boolean {
  return method === 'S256';
}

export function isValidChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && CHALLENGE_RE.test(challenge);
}

export function isValidVerifier(verifier: unknown): verifier is string {
  return typeof verifier === 'string' && VERIFIER_RE.test(verifier);
}

/**
 * True when `challenge === BASE64URL(SHA256(verifier))`. Both must be well
 * formed; the comparison is constant-time (both sides are 43 ASCII bytes once
 * the formats hold).
 */
export function verifyS256(verifier: unknown, challenge: unknown): boolean {
  if (!isValidVerifier(verifier) || !isValidChallenge(challenge)) return false;
  const expected = Buffer.from(
    createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    'ascii',
  );
  const actual = Buffer.from(challenge, 'ascii');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
