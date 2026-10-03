import { CanonicalJsonError, canonicalJson } from '@shared/crypto/canonical-json';

/**
 * These cases moved here from `test/unit/payment/request-hash.spec.ts`, with
 * the serialiser they exercise. They were never about payments:
 * every one of them asks whether a value that is not JSON is refused rather
 * than coerced, which is the serialiser's contract wherever it is used.
 *
 * The payment-specific half stayed behind — that a refusal surfaces as
 * `PAYMENT_REQUEST_NOT_CANONICALISABLE` rather than as this error is a property
 * of `computeRequestHash`, and it is asserted there.
 */
describe('canonicalJson', () => {
  it('sorts object keys, so insertion order cannot change the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order, because a reordered list is a different request', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
    expect(canonicalJson(['b', 'a'])).not.toBe(canonicalJson(['a', 'b']));
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: null })).toBe('{"a":[1,2],"b":null}');
  });

  it('drops undefined properties, matching what a client could have transmitted', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('escapes strings through the JSON grammar', () => {
    expect(canonicalJson('a"b\nc')).toBe('"a\\"b\\nc"');
  });

  it('distinguishes a string from the number that looks like it', () => {
    expect(canonicalJson({ a: '1' })).not.toBe(canonicalJson({ a: 1 }));
  });

  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
    ['a class instance', new (class Thing {})()],
    ['a function', () => undefined],
    ['a bigint', 1n],
    ['a symbol', Symbol('x')],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('refuses %s rather than coercing it', (_name, value) => {
    // `JSON.stringify` turns a Map into `{}`. Hashing that would be hashing a
    // request whose parameters silently vanished.
    expect(() => canonicalJson({ payload: value })).toThrow(CanonicalJsonError);
  });

  it('accepts a null-prototype object, which is still plain JSON', () => {
    const record = Object.create(null) as Record<string, unknown>;
    record.a = 1;
    expect(canonicalJson(record)).toBe('{"a":1}');
  });
});

it('names where in the document the offending value sits', () => {
  expect(() => canonicalJson({ outer: { inner: [1, new Map()] } })).toThrow(
    /\$\.outer\.inner\[1\]/,
  );
});
