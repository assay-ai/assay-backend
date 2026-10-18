/**
 * Generates test/fixtures/request-signing/v1.json, the vectors every provider
 * SDK is tested against. Run: yarn ts-node -T -r tsconfig-paths/register scripts/request-signing/make-test-vectors.ts
 * The seed is bytes 0x00..0x1f and is TEST ONLY.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RequestSignerService } from '../../src/modules/tool/request-auth/request-signer.service';
import { signatureBase } from '../../src/modules/tool/request-auth/signature-base';
import type { SignableRequest } from '../../src/modules/tool/request-auth/signature-base';

const KEY_ID = 'test-2026-10';
const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const signer = new RequestSignerService([{ keyId: KEY_ID, seed, claimedPublicKey: null }]);

const params = (n: number) => ({
  created: 1760700000,
  expires: 1760700300,
  nonce: Buffer.alloc(16, n).toString('base64url'),
  keyId: KEY_ID,
});
const callId = { 'x-assay-call-id': 'c-1' };

const inputs: Array<{ name: string; request: SignableRequest }> = [
  {
    name: 'post-json-body',
    request: {
      method: 'POST',
      url: 'https://API.Example.test/v1/search?q=a%20b',
      headers: callId,
      body: '{"q":"a b"}',
    },
  },
  {
    name: 'get-no-body-no-query',
    request: { method: 'GET', url: 'https://api.example.test', headers: callId },
  },
  {
    name: 'get-with-query',
    request: { method: 'get', url: 'https://api.example.test/items?id=1&x=%2F', headers: callId },
  },
  {
    name: 'non-default-port',
    request: { method: 'GET', url: 'https://api.example.test:8443/v1/ping', headers: callId },
  },
  {
    name: 'empty-string-body',
    request: {
      method: 'POST',
      url: 'https://api.example.test/v1/empty',
      headers: callId,
      body: '',
    },
  },
  {
    name: 'explicit-default-port',
    request: {
      method: 'POST',
      url: 'https://API.Example.test:443/v1/search?q=a%20b',
      headers: callId,
      body: '{"q":"a b"}',
    },
  },
  {
    name: 'utf8-body',
    request: {
      method: 'POST',
      url: 'https://api.example.test/v1/search',
      headers: callId,
      body: '{"q":"café ✓"}',
    },
  },
  {
    name: 'mixed-case-call-id-header',
    request: {
      method: 'GET',
      url: 'https://api.example.test/v1/ping',
      headers: { 'X-Assay-Call-Id': 'c-1' },
    },
  },
];

const cases = inputs.map(({ name, request }, i) => {
  const p = params(i + 1);
  const headers = signer.signWith(request, p);
  const withDigest =
    request.body !== undefined
      ? { ...request.headers, 'content-digest': headers['Content-Digest'] }
      : request.headers;
  return {
    name,
    request,
    params: p,
    expected: { signatureBase: signatureBase({ ...request, headers: withDigest }, p), headers },
  };
});

const out = {
  warning: 'TEST ONLY: the seed below is public. Never use it outside tests.',
  keyId: KEY_ID,
  seedHex: Buffer.from(seed).toString('hex'),
  publicKeyJwk: signer.jwks().keys[0],
  cases,
};
const dir = join(__dirname, '../../test/fixtures/request-signing');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'v1.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${cases.length} cases`);
