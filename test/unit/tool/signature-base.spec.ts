import { createHash } from 'node:crypto';

import {
  contentDigest,
  coveredComponents,
  signatureBase,
} from '@modules/tool/request-auth/signature-base';

const BODY = '{"q":"a b"}';
const digest = 'sha-256=:' + createHash('sha256').update(BODY).digest('base64') + ':';
const params = {
  created: 1760700000,
  expires: 1760700300,
  nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
  keyId: 'test-2026-10',
};
const TAIL = `;created=1760700000;expires=1760700300;nonce="AAAAAAAAAAAAAAAAAAAAAA";keyid="test-2026-10";alg="ed25519";tag="assay-request"`;

describe('signature base', () => {
  it('computes content-digest', () => {
    expect(contentDigest(BODY)).toBe(digest);
  });

  it('builds the exact base for a POST with body', () => {
    const base = signatureBase(
      {
        method: 'post',
        url: 'https://API.Example.test:443/v1/search?q=a%20b',
        headers: { 'x-assay-call-id': 'c-1', 'content-digest': digest },
        body: BODY,
      },
      params,
    );
    expect(base).toBe(
      [
        '"@method": POST',
        '"@authority": api.example.test',
        '"@path": /v1/search',
        '"@query": ?q=a%20b',
        `"content-digest": ${digest}`,
        '"x-assay-call-id": c-1',
        `"@signature-params": ("@method" "@authority" "@path" "@query" "content-digest" "x-assay-call-id")${TAIL}`,
      ].join('\n'),
    );
  });

  it('GET without body or query omits content-digest and gives an empty query', () => {
    const base = signatureBase(
      { method: 'GET', url: 'https://api.example.test', headers: { 'x-assay-call-id': 'c-1' } },
      params,
    );
    expect(base).toBe(
      [
        '"@method": GET',
        '"@authority": api.example.test',
        '"@path": /',
        '"@query": ?',
        '"x-assay-call-id": c-1',
        `"@signature-params": ("@method" "@authority" "@path" "@query" "x-assay-call-id")${TAIL}`,
      ].join('\n'),
    );
    expect(coveredComponents(false)).not.toContain('content-digest');
  });

  it('keeps a non-default port and drops a default one', () => {
    const h = { 'x-assay-call-id': 'c-1' };
    expect(
      signatureBase({ method: 'GET', url: 'https://a.test:8443/x', headers: h }, params),
    ).toContain('"@authority": a.test:8443');
    expect(
      signatureBase({ method: 'GET', url: 'http://a.test:80/x', headers: h }, params),
    ).toContain('"@authority": a.test\n');
  });
});
