import {
  ASSAY_HEADER_RESERVE_BYTES,
  MAX_OUTBOUND_HEADER_BYTES,
  assayMappingHeaders,
  assertCredentialPut,
  credentialHeaderProblems,
  credentialQueryKeys,
  originOf,
  relayUnsupportedPort,
  assertRelayableEndpoint,
  headerBytes,
  looksLikeSecretName,
  secretConstantHeaders,
} from '@modules/provider/credentials/credential-rules';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { RequestMappingSpec } from '@modules/tool/domain/mapping/mapping.types';

const m = (extra: Partial<RequestMappingSpec> = {}): RequestMappingSpec =>
  ({ method: 'GET', ...extra }) as unknown as RequestMappingSpec;

describe('credentialQueryKeys', () => {
  it('flags credential-like keys in the endpoint, as written', () => {
    expect(credentialQueryKeys('https://x.test/v1?API_KEY=1', m())).toEqual(['API_KEY']);
    expect(credentialQueryKeys('https://x.test/v1?Api-Key=1', m())).toEqual(['Api-Key']);
  });
  it('leaves ordinary keys alone', () => {
    expect(credentialQueryKeys('https://x.test/v1?max_tokens=5&keyword=a', m())).toEqual([]);
  });
  it('flags constant mapping query entries only', () => {
    expect(
      credentialQueryKeys('https://x.test/v1', m({ query: { token: { $const: 'abc' } } })),
    ).toEqual(['token']);
    expect(
      credentialQueryKeys('https://x.test/v1', m({ query: { token: { $path: '$.t' } } })),
    ).toEqual([]);
  });
});

describe('looksLikeSecretName', () => {
  it.each([
    'x-api-key',
    'apikey',
    'apiKey',
    'Subscription-Key',
    'x-goog-api-key',
    'Ocp-Apim-Subscription-Key',
    'X-RapidAPI-Key',
    'access_token',
    'x-auth-token',
    'client_secret',
    'Authorization',
    'Proxy-Authorization',
    'password',
    'passwd',
    'oauth',
    'x-credential',
    'x-signature',
    'session_id',
    'Cookie',
    'sig',
  ])('flags %s', (name) => expect(looksLikeSecretName(name)).toBe(true));
  it.each([
    'idempotency-key',
    'Idempotency-Key',
    'x-sort-key',
    'sort_key',
    'cache-key',
    'x-idempotency-key',
    'X-Cache-Key',
    'max_tokens',
    'keyword',
    'keywords',
    'accept',
    'x-api-version',
    'author',
    'config',
  ])('allows %s', (name) => expect(looksLikeSecretName(name)).toBe(false));
});

describe('secretConstantHeaders', () => {
  it('flags names the exact list missed', () => {
    expect(secretConstantHeaders(m({ headers: { 'x-goog-api-key': { $const: 'a' } } }))).toEqual([
      'x-goog-api-key',
    ]);
  });
  it('flags secret-looking constant headers', () => {
    expect(
      secretConstantHeaders(m({ headers: { Authorization: { $const: 'Bearer x' } } })),
    ).toEqual(['Authorization']);
  });
  it('allows benign constants', () => {
    expect(secretConstantHeaders(m({ headers: { 'x-sort-key': { $const: 'a' } } }))).toEqual([]);
    expect(secretConstantHeaders(m({ headers: { 'idempotency-key': { $const: 'a' } } }))).toEqual(
      [],
    );
  });
  it('ignores derived values', () => {
    expect(secretConstantHeaders(m({ headers: { Authorization: { $path: '$.a' } } }))).toEqual([]);
  });
});

describe('credentialHeaderProblems', () => {
  const ok = { name: 'X-Vendor-Auth', value: 'v' };
  it('accepts a valid set', () => {
    expect(credentialHeaderProblems([ok])).toEqual([]);
  });
  it.each([
    ['too many', Array.from({ length: 11 }, (_, i) => ({ name: `X-K${i}`, value: 'v' }))],
    ['reserved', [{ name: 'Host', value: 'v' }]],
    ['x-assay prefix', [{ name: 'X-Assay-Foo', value: 'v' }]],
    ['bad name', [{ name: 'bad name', value: 'v' }]],
    ['CRLF value', [{ name: 'X-K', value: 'a\r\nb' }]],
    ['oversized value', [{ name: 'X-K', value: 'a'.repeat(4097) }]],
    ['empty value', [{ name: 'X-K', value: '' }]],
    [
      'duplicate',
      [
        { name: 'X-Key', value: 'a' },
        { name: 'x-key', value: 'b' },
      ],
    ],
  ])('rejects %s', (_label, headers) => {
    expect(credentialHeaderProblems(headers).length).toBeGreaterThan(0);
  });
});

describe('credentialHeaderProblems — messages', () => {
  it('rejects an empty set', () => {
    expect(credentialHeaderProblems([])).toEqual([
      'At least one header is required (use DELETE to remove the set)',
    ]);
  });
  it('identifies an invalid name by position and never echoes it', () => {
    const secret = 'Authorization: Bearer sk-example-123';
    const problems = credentialHeaderProblems([
      { name: 'X-Ok', value: 'v' },
      { name: 'X-Ok2', value: 'v' },
      { name: secret, value: 'v' },
    ]);
    expect(problems).toEqual(['Header #3: invalid name']);
    expect(JSON.stringify(problems)).not.toContain('sk-example');
  });
  it('names an empty value by its header', () => {
    expect(credentialHeaderProblems([{ name: 'X-K', value: '' }])).toEqual([
      'Header X-K: value is empty',
    ]);
  });
  it('does not echo an invalid name in value problems either', () => {
    const problems = credentialHeaderProblems([{ name: 'bad name sk-1', value: 'a\nb' }]);
    expect(JSON.stringify(problems)).not.toContain('sk-1');
  });
});

describe('originOf', () => {
  it('lowercases and drops default ports and paths', () => {
    expect(originOf('https://API.x.test:443/a?b')).toBe('https://api.x.test');
  });
});

describe('relayUnsupportedPort', () => {
  it('names a port the relay cannot reach', () => {
    expect(relayUnsupportedPort('https://p.test:3000/x', true)).toBe(3000);
  });
  it('allows anything when the relay is not configured', () => {
    expect(relayUnsupportedPort('https://p.test:3000/x', false)).toBeNull();
  });
  it('allows the default and the listed ports', () => {
    expect(relayUnsupportedPort('https://p.test/x', true)).toBeNull();
    expect(relayUnsupportedPort('https://p.test:8443/x', true)).toBeNull();
    expect(relayUnsupportedPort('https://p.test:443/x', true)).toBeNull();
  });
  it('leaves unparsable input to the other validators', () => {
    expect(relayUnsupportedPort('not a url', true)).toBeNull();
  });
});

describe('assayMappingHeaders', () => {
  it('names every mapping header in the x-assay- namespace, constant or derived', () => {
    expect(
      assayMappingHeaders(
        m({
          headers: {
            'X-Assay-Agent': { $const: 'a' },
            'x-assay-call-id': { $path: '$.id' },
            'X-Assayed': { $const: 'ok' },
            Accept: { $const: 'x' },
          },
        }),
      ),
    ).toEqual(['X-Assay-Agent', 'x-assay-call-id']);
  });
  it('is empty without headers', () => {
    expect(assayMappingHeaders(m())).toEqual([]);
  });
});

describe('headerBytes', () => {
  it('counts name, value and the four bytes of ": " and CRLF', () => {
    expect(headerBytes([['ab', 'cde']])).toBe(9);
    expect(headerBytes(Object.entries({ a: '1', b: '22' }))).toBe(6 + 7);
  });
});

describe('assertCredentialPut — outbound header cap', () => {
  const ENDPOINT = 'https://p.test/v1';
  const put = (mapping: RequestMappingSpec, value: string) => () =>
    assertCredentialPut(ENDPOINT, null, 'https://p.test', [{ name: 'X-K', value }], mapping);
  // Room left for the credential value once its own name and framing are counted.
  const room = MAX_OUTBOUND_HEADER_BYTES - ASSAY_HEADER_RESERVE_BYTES - headerBytes([['X-K', '']]);

  it('accepts a set that fits with the reserve for Assay headers', () => {
    expect(put(m(), 'a'.repeat(Math.min(room, 4096)))).not.toThrow();
  });

  it("counts the mapping's constant headers, refusing the total past 8 KiB", () => {
    const big = m({
      headers: {
        'X-One': { $const: 'o'.repeat(2000) },
        'X-Two': { $const: 't'.repeat(2000) },
        'X-Derived': { $path: '$.q' },
      },
    });
    let thrown: unknown;
    try {
      put(big, 'a'.repeat(4000))();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_INVALID_CREDENTIAL_HEADERS,
    });
    expect(String((thrown as Error).message)).toContain('Headers too large');
    expect(String((thrown as Error).message)).not.toContain('aaaa');
  });

  it('ignores derived mapping headers, which only the call can size', () => {
    expect(put(m({ headers: { 'X-Derived': { $path: '$.q' } } }), 'a'.repeat(4000))).not.toThrow();
  });
});

describe('assertRelayableEndpoint', () => {
  it('refuses http, IP literals and unreachable ports with the relay on', () => {
    expect(() => assertRelayableEndpoint('http://p.test/x', true)).toThrow(
      expect.objectContaining({ errorCode: ProviderErrorCode.PROVIDER_ENDPOINT_NOT_RELAYABLE }),
    );
    for (const ip of ['https://10.0.0.1/x', 'https://[::1]/x', 'https://8.8.8.8:443/x']) {
      expect(() => assertRelayableEndpoint(ip, true)).toThrow(
        expect.objectContaining({ errorCode: ProviderErrorCode.PROVIDER_ENDPOINT_NOT_RELAYABLE }),
      );
    }
    expect(() => assertRelayableEndpoint('https://p.test:3000/x', true)).toThrow(
      expect.objectContaining({
        errorCode: ProviderErrorCode.PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED,
      }),
    );
  });
  it("refuses one of Assay's own hosts, with the relay on or off", () => {
    for (const endpoint of ['https://api.goassay.ai/x', 'https://GOASSAY.AI./x']) {
      for (const relay of [true, false]) {
        expect(() => assertRelayableEndpoint(endpoint, relay)).toThrow(
          expect.objectContaining({
            errorCode: ProviderErrorCode.PROVIDER_ENDPOINT_HOST_NOT_ALLOWED,
          }),
        );
      }
    }
    expect(() => assertRelayableEndpoint('https://goassay.ai.example.com/x', true)).not.toThrow();
  });
  it('accepts an https host name, and anything with the relay off', () => {
    expect(() => assertRelayableEndpoint('https://p.test:8443/x', true)).not.toThrow();
    expect(() => assertRelayableEndpoint('http://10.0.0.1:3000/x', false)).not.toThrow();
    expect(() => assertRelayableEndpoint('not a url', true)).not.toThrow();
  });
});
