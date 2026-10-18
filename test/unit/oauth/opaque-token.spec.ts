import { digestToken } from '@shared/crypto/token-digest';
import {
  OPAQUE_TOKEN_PREFIXES,
  OpaqueTokenPrefix,
  hasPrefix,
  hashOpaqueToken,
  isWellFormed,
  mint,
} from '@modules/oauth/domain/opaque-token';

describe('opaque tokens (R-OA-11, R-OA-12)', () => {
  it.each(OPAQUE_TOKEN_PREFIXES)('mints %s + 32 random bytes in base64url', (prefix) => {
    const token = mint(prefix);
    expect(token.startsWith(prefix)).toBe(true);
    const body = token.slice(prefix.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(body, 'base64url')).toHaveLength(32);
    expect(isWellFormed(token, prefix)).toBe(true);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => mint('assay_at_')));
    expect(seen.size).toBe(1000);
  });

  it('refuses an unknown prefix at run time', () => {
    for (const prefix of ['assay_sk_live_', 'x402_sk_live_', '', 'assay_at']) {
      expect(() => mint(prefix as OpaqueTokenPrefix)).toThrow();
    }
  });

  it('hasPrefix checks the exact, case-sensitive prefix', () => {
    const access = mint('assay_at_');
    expect(hasPrefix(access, 'assay_at_')).toBe(true);
    expect(hasPrefix(access, 'assay_rt_')).toBe(false);
    expect(hasPrefix(access.toUpperCase(), 'assay_at_')).toBe(false);
    expect(hasPrefix(` ${access}`, 'assay_at_')).toBe(false);
    expect(hasPrefix('assay_sk_live_abc', 'assay_at_')).toBe(false);
    for (const value of [undefined, null, 1, {}, [access]]) {
      expect(hasPrefix(value, 'assay_at_')).toBe(false);
    }
  });

  it('isWellFormed refuses a wrong body', () => {
    const access = mint('assay_at_');
    for (const token of [
      'assay_at_',
      access.slice(0, -1),
      `${access}A`,
      `${access}\n`,
      `${access}=`,
      'assay_at_' + 'A'.repeat(42) + '+',
      'assay_rt_' + access.slice('assay_at_'.length),
    ]) {
      expect(isWellFormed(token, 'assay_at_')).toBe(false);
    }
  });

  it('hashes with the shared digestToken', () => {
    const token = mint('assay_rt_');
    expect(hashOpaqueToken(token)).toBe(digestToken(token));
    expect(hashOpaqueToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
