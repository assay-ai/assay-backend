import { KeyObject, verify as verifySignature } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PRIVY_AUTH_CONFIG, PrivyAuthConfig } from '../domain/privy-auth.config';
import { ES256_SIGNATURE_BYTES, PRIVY_TOKEN_ALGORITHM, PrivyClaims } from '../domain/privy-claims';
import { PrivyJwksCache } from './privy-jwks.cache';

/** Longest `sub` we will consider — `agents.privy_user_id` is `varchar(128)`. */
const MAX_SUBJECT_LENGTH = 128;

/**
 * Verifies a Privy access token locally, against the cached JWKS.
 *
 * ## One negative answer, by construction
 *
 * `verify` returns `PrivyClaims | null`. There is exactly one falsy value and
 * no error variants, so **no branch in this class can leak which check
 * failed** — not by code, not by message, not by status. That is not a style
 * choice: an error distinguishing "bad signature" from "expired" from "wrong
 * audience" tells someone probing precisely which half of a forgery to fix
 * next, and the caller (`PrivyMcpSessionSource`) turns every `null` into the
 * one generic `MCP_CREDENTIAL_INVALID` that `ConfigMcpSessionSource` also
 * raises.
 *
 * The reason *is* logged, at debug, without the token — an operator debugging
 * a clock-skew problem at 03:00 needs it, and a log line is not an oracle.
 *
 * The single exception is `AUTH_IDENTITY_PROVIDER_UNAVAILABLE`, thrown by
 * `PrivyJwksCache` when there is no usable key at all. It reveals nothing
 * about the presented token — a forgery and a perfect token get the same
 * answer, because neither was checked.
 *
 * ## What is checked, in order
 *
 * 1. Three base64url segments.
 * 2. Header `alg` **equals** `ES256`, pinned — never taken from the token.
 *    Reading `alg` and honouring it is how `none` and the
 *    HMAC-with-the-public-key confusion work.
 * 3. Header `kid` names a key in the cached JWKS.
 * 4. The ES256 signature over `header.payload`, `r ‖ s`, 64 bytes.
 * 5. `iss` equals the configured issuer, `aud` contains the app id — the claim
 *    that stops a genuine token minted for **another Privy app** from being
 *    accepted here.
 * 6. `exp` in the future and `iat` / `nbf` not in the future, both within
 *    `clockSkewMs`.
 *
 * The signature is checked before any claim is read, so a payload that never
 * came from Privy never reaches a comparison.
 */
@Injectable()
export class PrivyTokenVerifier {
  private readonly logger = new Logger(PrivyTokenVerifier.name);

  constructor(
    private readonly jwks: PrivyJwksCache,
    @Inject(PRIVY_AUTH_CONFIG) private readonly config: PrivyAuthConfig,
  ) {}

  async verify(token: string): Promise<PrivyClaims | null> {
    // An unset app id would make the audience check vacuous, and the audience
    // is the only claim standing between this platform and a perfectly genuine
    // token minted for somebody else's Privy app. Unconfigured therefore means
    // "refuse everything", not "check less".
    if (!this.config.appId) {
      return this.refuse('privy is not configured');
    }

    const segments = token.split('.');
    if (segments.length !== 3) {
      return this.refuse('token is not a three-segment JWS');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = segments;

    const header = decodeJson(encodedHeader);
    if (!header) return this.refuse('header is not base64url JSON');

    if (header.alg !== PRIVY_TOKEN_ALGORITHM) {
      return this.refuse(`unsupported alg`);
    }

    const kid = typeof header.kid === 'string' ? header.kid : null;
    if (!kid) return this.refuse('header carries no kid');

    // Throws `AUTH_IDENTITY_PROVIDER_UNAVAILABLE` when there is no usable key
    // set at all — the fail-closed branch, deliberately not swallowed here.
    const key = await this.jwks.getKey(kid);
    if (!key) return this.refuse('no signing key for this kid');

    const signature = decodeBase64Url(encodedSignature);
    if (!signature || signature.length !== ES256_SIGNATURE_BYTES) {
      return this.refuse('signature is not a 64-byte P-256 signature');
    }

    if (!this.signatureIsGood(`${encodedHeader}.${encodedPayload}`, signature, key)) {
      return this.refuse('signature does not verify');
    }

    const payload = decodeJson(encodedPayload);
    if (!payload) return this.refuse('payload is not base64url JSON');

    if (payload.iss !== this.config.issuer) {
      return this.refuse('unexpected issuer');
    }

    if (!audienceMatches(payload.aud, this.config.appId)) {
      return this.refuse('token was minted for a different application');
    }

    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
      return this.refuse('subject is missing or implausible');
    }

    const now = Date.now();
    const skew = this.config.clockSkewMs;

    const expiresAtSeconds = numericClaim(payload.exp);
    if (expiresAtSeconds === null) return this.refuse('token carries no exp');
    if (expiresAtSeconds * 1000 + skew <= now) return this.refuse('token has expired');

    const issuedAtSeconds = numericClaim(payload.iat);
    if (issuedAtSeconds !== null && issuedAtSeconds * 1000 - skew > now) {
      return this.refuse('token was issued in the future');
    }

    const notBeforeSeconds = numericClaim(payload.nbf);
    if (notBeforeSeconds !== null && notBeforeSeconds * 1000 - skew > now) {
      return this.refuse('token is not valid yet');
    }

    return {
      subject,
      sessionId: typeof payload.sid === 'string' && payload.sid ? payload.sid : null,
      expiresAt: new Date(expiresAtSeconds * 1000),
      issuedAt: issuedAtSeconds === null ? null : new Date(issuedAtSeconds * 1000),
    };
  }

  /**
   * `dsaEncoding: 'ieee-p1363'` is what makes this a JWS check rather than an
   * X.509 one: JWS carries the raw `r ‖ s` pair, Node's default for EC is DER.
   * Without it every genuine token fails to verify.
   */
  private signatureIsGood(signingInput: string, signature: Buffer, key: KeyObject): boolean {
    try {
      return verifySignature(
        'sha256',
        Buffer.from(signingInput, 'ascii'),
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    } catch {
      // A malformed point or an unexpected key type surfaces as a throw from
      // OpenSSL. It is a refusal, not an outage.
      return false;
    }
  }

  /** Never carries the token, and never reaches the caller. */
  private refuse(reason: string): null {
    this.logger.debug(`Privy token refused: ${reason}`);
    return null;
  }
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const raw = decodeBase64Url(segment);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `aud` is a string in Privy's tokens; the RFC allows an array, so accept both. */
function audienceMatches(aud: unknown, appId: string): boolean {
  if (typeof aud === 'string') return aud === appId;
  if (Array.isArray(aud)) return aud.some((entry) => entry === appId);
  return false;
}

function numericClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
