import * as crypto from 'node:crypto';

// Wrap timingSafeEqual (behaviour unchanged) so a test can see that it is used.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

import {
  CODE_CHALLENGE_METHODS,
  isSupportedChallengeMethod,
  isValidChallenge,
  isValidVerifier,
  verifyS256,
} from '@modules/oauth/domain/pkce';

/** RFC 7636 Appendix B, verbatim. */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const s256 = (verifier: string) =>
  crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

describe('PKCE', () => {
  describe('methods', () => {
    it('plain is not a method', () => {
      expect(isSupportedChallengeMethod('plain')).toBe(false);
      expect(CODE_CHALLENGE_METHODS).toEqual(['S256']);
    });

    it('accepts only S256, case-sensitively', () => {
      expect(isSupportedChallengeMethod('S256')).toBe(true);
      for (const method of ['s256', 'S256 ', ' S256', 'SHA256', 'S512', '', undefined, null, 256]) {
        expect(isSupportedChallengeMethod(method)).toBe(false);
      }
    });
  });

  describe('isValidVerifier', () => {
    it('refuses 42 characters and accepts 43', () => {
      expect(isValidVerifier('a'.repeat(42))).toBe(false);
      expect(isValidVerifier('a'.repeat(43))).toBe(true);
    });

    it('accepts 128 characters and refuses 129', () => {
      expect(isValidVerifier('a'.repeat(128))).toBe(true);
      expect(isValidVerifier('a'.repeat(129))).toBe(false);
    });

    it('accepts every unreserved character', () => {
      expect(isValidVerifier('AZaz09-._~'.repeat(5))).toBe(true);
      expect(isValidVerifier(RFC_VERIFIER)).toBe(true);
    });

    it.each([
      ['a space', 'a'.repeat(42) + ' '],
      ['a plus', 'a'.repeat(42) + '+'],
      ['a slash', 'a'.repeat(42) + '/'],
      ['padding', 'a'.repeat(42) + '='],
      ['a percent escape', 'a'.repeat(40) + '%41'],
      ['a trailing newline', 'a'.repeat(43) + '\n'],
      ['a leading newline', '\n' + 'a'.repeat(43)],
      ['a NUL', 'a'.repeat(43) + '\0'],
      ['a non-ASCII letter', 'a'.repeat(42) + 'é'],
      ['a fullwidth letter', 'a'.repeat(42) + 'Ａ'],
      ['the empty string', ''],
    ])('refuses %s', (_label, verifier) => {
      expect(isValidVerifier(verifier)).toBe(false);
    });

    it('refuses non-strings', () => {
      for (const value of [undefined, null, 43, ['a'.repeat(43)], { length: 43 }]) {
        expect(isValidVerifier(value)).toBe(false);
      }
    });
  });

  describe('isValidChallenge', () => {
    it('accepts exactly 43 base64url characters', () => {
      expect(isValidChallenge(RFC_CHALLENGE)).toBe(true);
      expect(isValidChallenge('A'.repeat(43))).toBe(true);
      expect(isValidChallenge('_-'.repeat(21) + 'a')).toBe(true);
    });

    it.each([
      ['42 characters', 'A'.repeat(42)],
      ['44 characters', 'A'.repeat(44)],
      ['padding', 'A'.repeat(42) + '='],
      ['standard base64 +', 'A'.repeat(42) + '+'],
      ['standard base64 /', 'A'.repeat(42) + '/'],
      ['a tilde (verifier-only character)', 'A'.repeat(42) + '~'],
      ['a dot (verifier-only character)', 'A'.repeat(42) + '.'],
      ['a trailing newline', 'A'.repeat(43) + '\n'],
      ['a hex SHA-256 (64 characters)', 'a'.repeat(64)],
      ['the empty string', ''],
    ])('refuses %s', (_label, challenge) => {
      expect(isValidChallenge(challenge)).toBe(false);
    });

    it('refuses non-strings', () => {
      for (const value of [undefined, null, 43, ['A'.repeat(43)]]) {
        expect(isValidChallenge(value)).toBe(false);
      }
    });
  });

  describe('verifyS256', () => {
    it('matches the RFC 7636 Appendix B vector', () => {
      expect(verifyS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
    });

    it('matches a freshly computed pair at both length bounds', () => {
      for (const verifier of ['x'.repeat(43), 'y'.repeat(128), 'AZaz09-._~'.repeat(12)]) {
        expect(verifyS256(verifier, s256(verifier))).toBe(true);
      }
    });

    it('refuses a different verifier', () => {
      expect(verifyS256(RFC_VERIFIER.slice(0, -1) + 'j', RFC_CHALLENGE)).toBe(false);
    });

    it('refuses a challenge that differs in the first or the last character', () => {
      const first = (RFC_CHALLENGE[0] === 'A' ? 'B' : 'A') + RFC_CHALLENGE.slice(1);
      const last = RFC_CHALLENGE.slice(0, -1) + (RFC_CHALLENGE.endsWith('A') ? 'B' : 'A');
      expect(verifyS256(RFC_VERIFIER, first)).toBe(false);
      expect(verifyS256(RFC_VERIFIER, last)).toBe(false);
    });

    it('is not the plain method: the verifier as its own challenge is refused', () => {
      const verifier = 'a'.repeat(43);
      expect(isValidChallenge(verifier)).toBe(true);
      expect(verifyS256(verifier, verifier)).toBe(false);
    });

    it('refuses a padded, standard-base64 or hex challenge of the right digest', () => {
      const digest = crypto.createHash('sha256').update(RFC_VERIFIER).digest();
      expect(verifyS256(RFC_VERIFIER, digest.toString('base64'))).toBe(false);
      expect(verifyS256(RFC_VERIFIER, RFC_CHALLENGE + '=')).toBe(false);
      expect(verifyS256(RFC_VERIFIER, digest.toString('hex'))).toBe(false);
    });

    it('refuses a malformed verifier even when its digest matches', () => {
      for (const verifier of ['a'.repeat(42), 'a'.repeat(129), 'a'.repeat(42) + ' ']) {
        expect(verifyS256(verifier, s256(verifier))).toBe(false);
      }
    });

    it('refuses missing or non-string inputs without throwing', () => {
      const cases: Array<[unknown, unknown]> = [
        [undefined, RFC_CHALLENGE],
        [RFC_VERIFIER, undefined],
        [null, null],
        ['', ''],
        [RFC_VERIFIER, 42],
        [{ toString: () => RFC_VERIFIER }, RFC_CHALLENGE],
      ];
      for (const [verifier, challenge] of cases) {
        expect(verifyS256(verifier, challenge)).toBe(false);
      }
    });

    it('compares in constant time', () => {
      const spy = crypto.timingSafeEqual as jest.MockedFunction<typeof crypto.timingSafeEqual>;
      spy.mockClear();
      expect(verifyS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
      expect(verifyS256(RFC_VERIFIER, 'A'.repeat(43))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
