import {
  credentialHeaderProblems,
  credentialQueryKeys,
  originOf,
  secretConstantHeaders,
} from '@modules/provider/credentials/credential-rules';
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

describe('secretConstantHeaders', () => {
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
    const secret = 'Authorization: Bearer sk-live-123';
    const problems = credentialHeaderProblems([
      { name: 'X-Ok', value: 'v' },
      { name: 'X-Ok2', value: 'v' },
      { name: secret, value: 'v' },
    ]);
    expect(problems).toEqual(['Header #3: invalid name']);
    expect(JSON.stringify(problems)).not.toContain('sk-live');
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
