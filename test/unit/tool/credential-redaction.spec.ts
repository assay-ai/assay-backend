import {
  ResponseBodyKind,
  TransportErrorKind,
  ProviderResponse,
} from '@modules/tool/domain/classification';
import { randomBytes } from 'node:crypto';

import {
  CredentialRedactor,
  MAX_REDACTABLE_CHARS,
  MIN_REDACTED_LENGTH,
  REDACTED,
  REDACTION_FAILED_DETAIL,
  REDACTION_NOTE_HEADER,
  REDACTION_UNUSABLE_DETAIL,
} from '@modules/tool/domain/egress/credential-redaction';
import {
  ClassificationReason,
  ResponseClass,
  classifyResponse,
} from '@modules/tool/domain/classification';
import { attributeAttempt } from '@modules/tool/domain/routing/attempt-attribution';

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
  it('rewrites string values only, leaving keys and other scalars alone', () => {
    expect(redactor.json({ echo: [`Bearer ${KEY}`], k: 1, n: 2, b: true, z: null })).toEqual({
      echo: [`Bearer ${REDACTED}`],
      k: 1,
      n: 2,
      b: true,
      z: null,
    });
  });

  it('never rewrites (or merges) keys: a key holding a credential fails closed', () => {
    expect(redactor.json({ [KEY]: 'a', [KEY.toUpperCase()]: 'b' })).toBe(REDACTED);
  });

  it('leaves an ordinary word equal to a Basic user name alone', () => {
    const basic = new CredentialRedactor([
      `Basic ${Buffer.from('customer:hunter2hunter2').toString('base64')}`,
    ]);
    const value = { type: 'customer', Customer: 'x', note: 'customer customers' };
    expect(basic.json(value)).toEqual(value);
    expect(basic.string('{"type":"customer","Customer":"x"}')).toBe(
      '{"type":"customer","Customer":"x"}',
    );
    expect(basic.string('pw hunter2hunter2')).toBe(`pw ${REDACTED}`);
  });
});

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Differential probe from review: keys that themselves contain escape-like
 * text (`%41`, `\t`, `&amp;`) once leaked in some echo forms. Every form here
 * was caught by the earlier regex redactor; none may leak now. Out of scope:
 * two encodings stacked (HTML of JSON).
 */
describe('CredentialRedactor — keys with escape-like content, every echo form', () => {
  const ECHOES: Record<string, (s: string) => string> = {
    raw: (s) => s,
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    percent: (s) => encodeURIComponent(s),
    percentLower: (s) => lowerPercent(s),
    form: (s) => new URLSearchParams({ a: s }).toString().slice(2),
    json: (s) => JSON.stringify(s).slice(1, -1),
    jsonUpper: (s) => JSON.stringify(s).slice(1, -1).toUpperCase(),
    goJson: (s) =>
      JSON.stringify(s)
        .slice(1, -1)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026'),
    htmlNamed,
  };
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

  it.each([
    ['escape-heavy', 'abcdefABCDEF0123456789%\\&#;xu', 1],
    ['printable', printable, 2],
  ])('leaks no form of 500 seeded %s keys', (_label, alphabet, seed) => {
    const random = seeded(seed);
    const leaks: string[] = [];
    for (let n = 0; n < 500; n += 1) {
      const key = Array.from({ length: 24 }, () => alphabet[Math.floor(random() * alphabet.length)])
        .join('')
        .trim();
      if (key.length < MIN_REDACTED_LENGTH) continue;
      const subject = new CredentialRedactor([key]);
      for (const [name, encode] of Object.entries(ECHOES)) {
        const echoed = encode(key);
        if (subject.string(`<${echoed}>`).includes(echoed)) leaks.push(`${name}: ${key}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it.each([['abc%41def\\tghijk'], ['Xy7%2fQ\\"k9Lm']])(
    'catches the review examples for %s',
    (key) => {
      const subject = new CredentialRedactor([key]);
      for (const encode of Object.values(ECHOES)) {
        expect(subject.string(encode(key))).toBe(REDACTED);
      }
    },
  );

  it('decodes numeric HTML entities with any number of leading zeros', () => {
    const key = 'secret-value-123';
    const padded = [...key].map((c) => `&#0000000${c.charCodeAt(0)};`).join('');
    expect(new CredentialRedactor([key]).string(`x ${padded} y`)).toBe(`x ${REDACTED} y`);
  });
});

describe('CredentialRedactor — failing closed', () => {
  it('fails closed when the time budget runs out: nothing of the answer survives', () => {
    let clock = 0;
    const slow = new CredentialRedactor([KEY], { budgetMs: 10, now: () => (clock += 20) });
    const out = slow.response({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-echo': KEY },
      body: { kind: ResponseBodyKind.JSON, value: { got: KEY, other: 'data' } },
    });
    expect(out).toEqual({
      status: 0,
      headers: {
        'content-type': REDACTED,
        'x-echo': REDACTED,
        [REDACTION_NOTE_HEADER]: 'truncated',
      },
      body: { kind: ResponseBodyKind.NON_JSON, raw: REDACTED, detail: REDACTED },
      transportError: {
        kind: TransportErrorKind.PLATFORM_UNAVAILABLE,
        partialBody: null,
        detail: REDACTION_FAILED_DETAIL,
      },
    });
    expect(slow.string(`x ${KEY}`)).toBe(REDACTED);
  });

  it('fails closed when a JSON object key holds a credential (keys are never rewritten)', () => {
    const out = redactor.response({
      status: 200,
      body: { kind: ResponseBodyKind.JSON, value: { data: { [`echo ${KEY}`]: 1 } } },
    });
    // The provider's content caused it: an unusable response, not a platform fault.
    expect(out.transportError).toEqual({
      kind: TransportErrorKind.UNUSABLE_RESPONSE,
      partialBody: null,
      detail: REDACTION_UNUSABLE_DETAIL,
    });
    expect(JSON.stringify(out)).not.toContain('sk-Live');
  });

  it('scales the budget with the text scanned: 60 ms per MiB on top of the base', () => {
    // The clock reads 0 when a budget starts and 200 ms on every check after.
    let started = false;
    const now = () => (started ? 200 : ((started = true), 0));
    const scaled = new CredentialRedactor([KEY], { budgetMs: 10, now });
    expect(scaled.string('short')).toBe(REDACTED); // 10 ms: past
    started = false;
    const big = 'y'.repeat(4 * 1024 * 1024); // 10 + 4 × 60 = 250 ms: within
    expect(scaled.string(big)).toBe(big);
  });

  it(`fails closed on a string longer than ${MAX_REDACTABLE_CHARS} characters`, () => {
    const out = redactor.response({
      status: 200,
      body: {
        kind: ResponseBodyKind.NON_JSON,
        raw: 'x'.repeat(MAX_REDACTABLE_CHARS + 1),
        detail: 'd',
      },
    });
    expect(out.transportError?.kind).toBe(TransportErrorKind.UNUSABLE_RESPONSE);
    expect(out.transportError?.detail).toBe(REDACTION_UNUSABLE_DETAIL);
    expect(out.body).toEqual({ kind: ResponseBodyKind.NON_JSON, raw: REDACTED, detail: REDACTED });
  });

  /**
   * Who is blamed, end to end: content the provider sent is classified like a
   * malformed body and counted against the binding; only a scan that ran out
   * of time stays a platform fault the stats leave out.
   */
  describe('attribution', () => {
    const paid = {
      providerId: 'provider-1',
      buyerOrganizationId: 'buyer-1',
      callClass: 'PAID' as const,
      elapsedMs: 40,
      timeoutMs: 1000,
      maxBudgetMs: 1000,
    };
    const attribute = (out: ProviderResponse) => {
      const c = classifyResponse(out, { toolId: '*', acceptsNonJsonBody: true });
      return {
        c,
        a: attributeAttempt({ ...paid, responseClass: c.responseClass, reason: c.reason }),
      };
    };

    it.each([
      [
        'a credential echoed as a JSON key',
        { kind: ResponseBodyKind.JSON, value: { [KEY]: 1 } } as const,
      ],
      [
        'a string over the size cap',
        {
          kind: ResponseBodyKind.NON_JSON,
          raw: 'x'.repeat(MAX_REDACTABLE_CHARS + 1),
          detail: 'd',
        } as const,
      ],
    ])('%s: BODY_NOT_JSON, counted as unavailable', (_label, body) => {
      const { c, a } = attribute(redactor.response({ status: 200, body }));
      expect(c.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
      expect(c.reason).toBe(ClassificationReason.BODY_NOT_JSON);
      expect(a).toEqual({ counted: true, available: false, latencyMs: null });
    });

    it('the time budget running out: PLATFORM_UNAVAILABLE, not counted', () => {
      let clock = 0;
      const slow = new CredentialRedactor([KEY], { budgetMs: 10, now: () => (clock += 20) });
      const out = slow.response({
        status: 200,
        body: { kind: ResponseBodyKind.JSON, value: { got: KEY } },
      });
      const { c, a } = attribute(out);
      expect(c.reason).toBe(ClassificationReason.PLATFORM_UNAVAILABLE);
      expect(a).toEqual({ counted: false, why: 'PLATFORM_FAULT' });
    });
  });
});

/**
 * Regression benchmarks. The provider controls both the credential and the
 * body, so the scan must stay linear for any input; ceilings are generous
 * for CI. A generous budget is passed so the timing measures the scan, not
 * the fail-closed path.
 */
describe('CredentialRedactor — linear time', () => {
  const FIVE_MIB = 5 * 1024 * 1024;
  const generous = { budgetMs: 60_000 };

  it.each([
    ['a…ab', 'a'.repeat(4095) + 'b'],
    ['b…a', 'b' + 'a'.repeat(4095)],
    ['a…ba…a', 'a'.repeat(2047) + 'b' + 'a'.repeat(2048)],
  ])('scans a 5 MiB all-a body against a 4 KiB %s near-match in < 500 ms', (_label, needle) => {
    const near = new CredentialRedactor([needle], generous);
    const body = 'a'.repeat(FIVE_MIB);
    const started = Date.now();
    const out = near.string(body);
    const elapsed = Date.now() - started;
    expect(out).toBe(body);
    expect(elapsed).toBeLessThan(500);
  });

  it('scans a 5 MiB random body against 10 random 4 KiB credentials in < 1 s', () => {
    const values = Array.from({ length: 10 }, () =>
      randomBytes(3072).toString('base64').slice(0, 4096),
    );
    const many = new CredentialRedactor(values, generous);
    const body = randomBytes((FIVE_MIB * 3) / 4).toString('base64') + values[7];
    const started = Date.now();
    const out = many.string(body);
    const elapsed = Date.now() - started;
    expect(out.endsWith(REDACTED)).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it('stays within the default budget for a typical 1 MiB JSON body', () => {
    const typical = new CredentialRedactor([
      'sk-example-0123456789abcdef',
      'Bearer tok_abcdefghijkl',
    ]);
    const value = { items: Array.from({ length: 20_000 }, (_, i) => `item ${i} lorem ipsum`) };
    const out = typical.response({ status: 200, body: { kind: ResponseBodyKind.JSON, value } });
    expect(out.transportError).toBeUndefined();
    expect(out.body).toEqual({ kind: ResponseBodyKind.JSON, value });
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
