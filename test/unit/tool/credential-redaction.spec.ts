import {
  ResponseBodyKind,
  TransportErrorKind,
  ProviderResponse,
} from '@modules/tool/domain/classification';
import {
  CredentialRedactor,
  MIN_REDACTED_LENGTH,
  REDACTED,
} from '@modules/tool/domain/egress/credential-redaction';

// Contains every character class that encodes differently: space, `/`, `+`,
// `&`, `<`, `"`, `'` and `\`.
const KEY = `sk-Live_a1b2 c3/d4+e5&f6<g7"h8'i9\\j0`;
const redactor = new CredentialRedactor([KEY]);

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const htmlNamed = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const htmlNumeric = (s: string) =>
  s.replace(/[&<>"'/ ]/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`);
const htmlDecimal = (s: string) => s.replace(/[&<>"'/ ]/g, (c) => `&#${c.charCodeAt(0)};`);
const lowerPercent = (s: string) =>
  encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const percentAll = (s: string) =>
  [...Buffer.from(s, 'utf8')].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');

describe('CredentialRedactor.string — every form a value can come back in', () => {
  it.each([
    ['raw', KEY],
    ['upper-case', KEY.toUpperCase()],
    ['lower-case', KEY.toLowerCase()],
    ['percent-encoded, upper-case %XX', encodeURIComponent(KEY)],
    ['percent-encoded, lower-case %xx', lowerPercent(KEY)],
    ['percent-encoded, every byte', percentAll(KEY)],
    ['form-encoded (+ for space)', new URLSearchParams({ k: KEY }).toString().slice(2)],
    ['JSON-escaped', JSON.stringify(KEY).slice(1, -1)],
    ['JSON-escaped with \\/', JSON.stringify(KEY).slice(1, -1).replace(/\//g, '\\/')],
    [
      'JSON \\u-escaped (Go style)',
      JSON.stringify(KEY)
        .slice(1, -1)
        .replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
    ],
    ['HTML named entities', htmlNamed(KEY)],
    ['HTML hex entities', htmlNumeric(KEY)],
    ['HTML decimal entities', htmlDecimal(KEY)],
    ['base64', b64(KEY)],
    ['base64 without padding', b64(KEY).replace(/=+$/, '')],
    ['base64url', b64url(KEY)],
    ['base64url with padding', b64(KEY).replace(/\+/g, '-').replace(/\//g, '_')],
  ])('redacts the %s form', (_label, form) => {
    const out = redactor.string(`before ${form} after`);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(form);
    expect(out.startsWith('before ')).toBe(true);
    expect(out.endsWith(' after')).toBe(true);
  });

  it.each([1, 2, 3, 4, 5])(
    'redacts base64 when the value sits at byte offset %i of a larger encoded blob',
    (offset) => {
      const prefix = 'u'.repeat(offset);
      const encoded = b64(`${prefix}:${KEY}:tail`);
      const out = redactor.string(encoded);
      expect(out).toContain(REDACTED);
      // What survives decodes to no more than two bytes of the value on either side.
      for (const piece of out.split(REDACTED)) {
        expect(Buffer.from(piece, 'base64').toString('latin1')).not.toContain(KEY.slice(0, 3));
      }
    },
  );

  it('redacts an echoed Basic authorization header, the decoded user:pass and the password', () => {
    const basic = new CredentialRedactor([`Basic ${b64('api-user:p4ssw0rd-long')}`]);
    expect(basic.string(`got Basic ${b64('api-user:p4ssw0rd-long')}`)).not.toContain(
      b64('api-user:p4ssw0rd-long'),
    );
    expect(basic.string('decoded api-user:p4ssw0rd-long')).not.toContain('p4ssw0rd-long');
    expect(basic.string('password=p4ssw0rd-long')).toBe(`password=${REDACTED}`);
  });

  it('redacts the token of a scheme-prefixed value when it is echoed on its own', () => {
    const bearer = new CredentialRedactor(['Bearer tok_9f8e7d6c5b4a']);
    expect(bearer.string('invalid token tok_9f8e7d6c5b4a')).toBe(`invalid token ${REDACTED}`);
    // The scheme word alone is too short to be a needle and stays.
    expect(bearer.string('Bearer realm="api"')).toBe('Bearer realm="api"');
  });

  it('replaces every occurrence, including mixed forms in one string', () => {
    const out = redactor.string(`${KEY}|${encodeURIComponent(KEY)}|${b64(KEY)}|${KEY}`);
    expect(out).toBe([REDACTED, REDACTED, REDACTED, REDACTED].join('|'));
  });

  it('replaces the longer of two overlapping values whole', () => {
    const both = new CredentialRedactor(['abcdef123456', 'abcdef123456-and-more']);
    expect(both.string('x abcdef123456-and-more y abcdef123456')).toBe(
      `x ${REDACTED} y ${REDACTED}`,
    );
  });

  it(`does not redact values shorter than ${MIN_REDACTED_LENGTH} characters (too many false matches)`, () => {
    const short = new CredentialRedactor(['abc1234']);
    expect(short.empty).toBe(true);
    expect(short.string('abc1234')).toBe('abc1234');
    const exact = new CredentialRedactor(['abc12345']);
    expect(exact.string('abc12345')).toBe(REDACTED);
  });

  it('leaves text without the value untouched', () => {
    expect(redactor.string('nothing to see')).toBe('nothing to see');
  });

  it('treats regex metacharacters in a value literally', () => {
    const meta = new CredentialRedactor(['a.b*c+d?e(f)[g]{h}|i^j$k']);
    expect(meta.string('aXbbbcdde')).toBe('aXbbbcdde');
    expect(meta.string('a.b*c+d?e(f)[g]{h}|i^j$k')).toBe(REDACTED);
  });
});

describe('CredentialRedactor.json', () => {
  it('walks values and keys, leaving other scalars alone', () => {
    expect(redactor.json({ echo: [`Bearer ${KEY}`], [KEY]: 1, n: 2, b: true, z: null })).toEqual({
      echo: [`Bearer ${REDACTED}`],
      [REDACTED]: 1,
      n: 2,
      b: true,
      z: null,
    });
  });
});

describe('CredentialRedactor.response', () => {
  it('redacts headers and a JSON body', () => {
    const out = redactor.response({
      status: 200,
      headers: { 'x-echo': KEY, 'x-b64': b64(KEY) },
      body: { kind: ResponseBodyKind.JSON, value: { got: KEY, html: htmlNamed(KEY) } },
    });
    expect(JSON.stringify(out)).not.toContain('sk-Live');
    expect(out.headers).toEqual({ 'x-echo': REDACTED, 'x-b64': REDACTED });
    expect(out.status).toBe(200);
  });

  it('redacts a raw body and its detail', () => {
    const out = redactor.response({
      status: 500,
      body: { kind: ResponseBodyKind.NON_JSON, raw: `<p>${htmlNamed(KEY)}</p>`, detail: KEY },
    });
    expect(out.body).toEqual({
      kind: ResponseBodyKind.NON_JSON,
      raw: `<p>${REDACTED}</p>`,
      detail: REDACTED,
    });
  });

  it('redacts a transport error detail and partial body, keeping the kind', () => {
    const out = redactor.response({
      status: 0,
      body: { kind: ResponseBodyKind.EMPTY },
      transportError: {
        kind: TransportErrorKind.TIMEOUT,
        detail: `timed out on https://api.example.com/x?k=${lowerPercent(KEY)}`,
        partialBody: `{"k":"${JSON.stringify(KEY).slice(1, -1)}`,
      },
    });
    expect(out.transportError).toEqual({
      kind: TransportErrorKind.TIMEOUT,
      detail: `timed out on https://api.example.com/x?k=${REDACTED}`,
      partialBody: `{"k":"${REDACTED}`,
    });
  });

  it('keeps a null partial body and a null transport error as they are', () => {
    const response: ProviderResponse = {
      status: 200,
      body: { kind: ResponseBodyKind.EMPTY },
      transportError: null,
    };
    expect(redactor.response(response)).toEqual(response);
  });

  it('is the identity with no redactable values', () => {
    const response = { status: 200, body: { kind: ResponseBodyKind.EMPTY } } as const;
    expect(CredentialRedactor.NONE.response(response)).toBe(response);
    expect(new CredentialRedactor(['', 'short']).response(response)).toBe(response);
  });
});
