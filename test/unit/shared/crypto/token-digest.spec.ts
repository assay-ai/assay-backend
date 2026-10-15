import { digestToken } from '@shared/crypto/token-digest';

describe('digestToken', () => {
  it('is sha256 of the utf8 bytes, hex encoded', () => {
    expect(digestToken('mcp_demo_token_funded')).toHaveLength(64);
    expect(digestToken('a')).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    );
  });

  it('is stable across calls', () => {
    expect(digestToken('assay_sk_live_abc')).toBe(digestToken('assay_sk_live_abc'));
  });

  it('separates two tokens differing by one character', () => {
    expect(digestToken('assay_sk_live_abc')).not.toBe(digestToken('assay_sk_live_abd'));
  });
});
