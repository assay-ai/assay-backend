import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';
import { signatureBase } from '@modules/tool/request-auth/signature-base';

const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const keys = [{ keyId: 'test-2026-10', seed, claimedPublicKey: null }];
const NOW = new Date(1760700000 * 1000);
const req = {
  method: 'POST',
  url: 'https://api.example.test/v1/search?q=a%20b',
  headers: { 'x-assay-call-id': 'c-1' },
  body: '{"q":"a b"}',
};

describe('RequestSignerService', () => {
  const signer = new RequestSignerService(keys);
  const publicKey = () =>
    createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: signer.jwks().keys[0].x },
      format: 'jwk',
    });

  it('signs and the signature verifies', async () => {
    const h = await signer.sign(req, NOW);
    expect(h['Signature-Input']).toMatch(/^assay=\("@method"/);
    expect(h['Signature']).toMatch(/^assay=:[A-Za-z0-9+/]+=*:$/);
    const nonce = /nonce="([^"]+)"/.exec(h['Signature-Input'])![1];
    const base = signatureBase(
      { ...req, headers: { ...req.headers, 'content-digest': h['Content-Digest'] } },
      { created: 1760700000, expires: 1760700300, nonce, keyId: 'test-2026-10' },
    );
    const sig = Buffer.from(h['Signature'].slice('assay=:'.length, -1), 'base64');
    expect(verify(null, Buffer.from(base), publicKey(), sig)).toBe(true);
  });

  it('uses a fresh nonce per call', async () => {
    const a = await signer.sign(req, NOW);
    const b = await signer.sign(req, NOW);
    expect(a['Signature-Input']).not.toBe(b['Signature-Input']);
  });

  it('omits Content-Digest when there is no body', async () => {
    const h = await signer.sign({ ...req, body: undefined }, NOW);
    expect(h['Content-Digest']).toBeUndefined();
  });

  it('publishes a JWKS', () => {
    const k = signer.jwks().keys[0];
    expect(k).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      kid: 'test-2026-10',
      use: 'sig',
      alg: 'EdDSA',
    });
    expect(Buffer.from(k.x, 'base64url')).toHaveLength(32);
  });

  it('throws in production without keys, returns {} elsewhere', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new RequestSignerService([])).toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(await new RequestSignerService([]).sign(req, NOW)).toEqual({});
  });

  it('matches the published test vectors', () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/request-signing/v1.json'), 'utf8'),
    );
    expect(signer.jwks().keys[0].x).toBe(fixture.publicKeyJwk.x);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
    for (const c of fixture.cases) {
      const headers = signer.signWith(c.request, c.params);
      expect(headers).toEqual(c.expected.headers);
      const withDigest =
        c.request.body !== undefined
          ? { ...c.request.headers, 'content-digest': headers['Content-Digest'] }
          : c.request.headers;
      expect(signatureBase({ ...c.request, headers: withDigest }, c.params)).toBe(
        c.expected.signatureBase,
      );
    }
  });
});
