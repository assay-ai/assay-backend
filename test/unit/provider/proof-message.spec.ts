import { renderProofMessage } from '@modules/provider/domain/proof-message';

/**
 * How a proof challenge's bytes become the `message` / `message_version` the
 * row stores.
 *
 * Both columns are text, and on eip155 the bytes are a 32-byte EIP-712 digest.
 * `TextDecoder` over it was stored verbatim, and Postgres refuses a 0x00 in a
 * text column — `invalid byte sequence for encoding "UTF8": 0x00`, measured on
 * /provider/setup against eip155:46630 — which a digest carries about one time
 * in eight. The other seven stored mojibake, with a "version" that was the
 * digest's bytes up to the first 0x0a.
 */
describe('renderProofMessage', () => {
  it('keeps a Solana message as its text, and its version as the first line', () => {
    const text = 'x402-payout-proof/v1\nsolana:abc:Xyz\norg\nnonce\n1800000000';

    expect(renderProofMessage(new TextEncoder().encode(text), null)).toEqual({
      message: text,
      messageVersion: 'x402-payout-proof/v1',
    });
  });

  it('stores a typed-data digest as 0x hex — never a NUL — and names its struct as the version', () => {
    const digest = new Uint8Array(32);
    digest[0] = 0x0a;
    digest[31] = 0xff; // and a 0x00 everywhere between

    const rendered = renderProofMessage(digest, { primaryType: 'PayoutProof' });

    expect(rendered.message).toBe(`0x0a${'00'.repeat(30)}ff`);
    expect(rendered.message).not.toContain('\u0000');
    expect(rendered.messageVersion).toBe('eip712/PayoutProof');
  });

  it('gives the two eip155 proof kinds different versions, which is how prove tells them apart', () => {
    const digest = new Uint8Array(32).fill(7);
    expect(renderProofMessage(digest, { primaryType: 'PayoutProof' }).messageVersion).not.toBe(
      renderProofMessage(digest, { primaryType: 'StakeAuthorityProof' }).messageVersion,
    );
  });
});
