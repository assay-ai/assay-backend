import { createHash } from 'node:crypto';

import {
  RESOURCE_HASH_PREFIX,
  RESOURCE_HASH_RE,
  computeResourceHash,
  hashHexToBytes,
} from '@modules/payment/domain/resource-hash';

const RESOURCE = 'https://api.x402.dev/tools/weather-now';

describe('computeResourceHash', () => {
  it('is sha256 of the utf-8 resource, prefixed', () => {
    expect(computeResourceHash(RESOURCE)).toBe(
      `${RESOURCE_HASH_PREFIX}${createHash('sha256').update(RESOURCE, 'utf8').digest('hex')}`,
    );
    expect(RESOURCE_HASH_RE.test(computeResourceHash(RESOURCE))).toBe(true);
  });

  it('is stable and lower-case hex', () => {
    expect(computeResourceHash(RESOURCE)).toBe(computeResourceHash(RESOURCE));
    expect(computeResourceHash(RESOURCE).slice(RESOURCE_HASH_PREFIX.length)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('separates resources that differ by one character', () => {
    expect(computeResourceHash(RESOURCE)).not.toBe(computeResourceHash(`${RESOURCE}/`));
  });

  it('hashes bytes, not code points — a normalised twin is a different resource', () => {
    // `caf\u00e9` (one code point) and `cafe\u0301` (`e` + a combining acute)
    // render identically and are not the same resource. The voucher signs the
    // hash, so the chain draws the same distinction the string comparison in
    // `VoucherService` does.
    expect(computeResourceHash('caf\u00e9')).not.toBe(computeResourceHash('cafe\u0301'));
  });
});

describe('hashHexToBytes', () => {
  it('returns the 32 raw bytes of the digest', () => {
    const bytes = hashHexToBytes(computeResourceHash(RESOURCE));

    expect(bytes).toHaveLength(32);
    expect(Buffer.from(bytes).toString('hex')).toBe(
      createHash('sha256').update(RESOURCE, 'utf8').digest('hex'),
    );
  });

  it.each([
    ['no prefix', 'a'.repeat(64)],
    ['a short digest', `sha256:${'a'.repeat(63)}`],
    ['a long digest', `sha256:${'a'.repeat(65)}`],
    ['upper-case hex', `sha256:${'A'.repeat(64)}`],
    ['a non-hex character', `sha256:${'g'.repeat(64)}`],
    ['the wrong algorithm', `sha512:${'a'.repeat(64)}`],
    ['an empty string', ''],
  ])('throws rather than padding or truncating: %s', (_case, value) => {
    // Zero-padding a short digest would produce a message the buyer did not
    // mean to sign, and `redeem_voucher` would answer `MissingBuyerSignature` —
    // sending the reader to look at key registration rather than at 31 bytes.
    expect(() => hashHexToBytes(value)).toThrow(/64 hex characters/);
  });
});
