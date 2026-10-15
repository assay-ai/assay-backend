import { getMetadataArgsStorage } from 'typeorm';

import { EvidenceBodyEntity } from '@database/postgres/entities/evidence-body.entity';
import { EvidencePackEntity } from '@database/postgres/entities/evidence-pack.entity';
import {
  JSONB_ESCAPE_MARK,
  jsonbSafeTransformer,
} from '@database/postgres/entities/jsonb-safe.transformer';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';

/**
 * Final review N-3: `jsonb` refuses `\u0000` and lone surrogates, so a buyer
 * who put one in a string argument made the verification enqueue throw. The
 * bodies are now written through a reversible escape.
 */
describe('jsonbSafeTransformer', () => {
  /** Every string and key in a JSON value — what `jsonb` parses as text. */
  function texts(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(texts);
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, item]) => [key, ...texts(item)]);
    }
    return [];
  }

  /** What PostgreSQL `jsonb` rejects: U+0000, or a string that is not well-formed UTF-16. */
  function rejected(text: string): boolean {
    if (text.includes('\u0000')) return true;
    try {
      encodeURIComponent(text); // throws URIError on a lone surrogate
      return false;
    } catch {
      return true;
    }
  }

  const hostile = {
    query: 'weather\u0000',
    lone: 'a\ud800b',
    trailing: 'x\udc00',
    pair: 'emoji 😀 ok',
    slash: 'back\\slash',
    marked: `${JSONB_ESCAPE_MARK}already`,
    'key\u0000': ['\u0000', 1, null, true, { nested: '\udbff' }],
  };

  it('writes nothing jsonb rejects', () => {
    expect(texts(hostile).filter(rejected)).toHaveLength(6);
    expect(texts(jsonbSafeTransformer.to(hostile)).filter(rejected)).toEqual([]);
  });

  it('reads back exactly what was written', () => {
    const stored = JSON.parse(JSON.stringify(jsonbSafeTransformer.to(hostile))) as unknown;
    expect(jsonbSafeTransformer.from(stored)).toEqual(hostile);
  });

  it('leaves ordinary bodies untouched', () => {
    const body = { query: 'moon landing', n: 3, tags: ['a\\b', 'emoji 😀'], none: null };
    expect(jsonbSafeTransformer.to(body)).toEqual(body);
    expect(jsonbSafeTransformer.from(body)).toEqual(body);
    expect(jsonbSafeTransformer.to(null)).toBeNull();
  });

  /**
   * Round-two review R2-1: `out[key] = …` on a plain `{}` treats `__proto__`
   * as the prototype setter, so the key vanished from what was stored.
   */
  it('keeps "__proto__" and "constructor" as own keys, both ways', () => {
    const served = JSON.parse(
      '{"__proto__":{"hidden":"x"},"constructor":"c","ok":1,"n":{"__proto__":[1]}}',
    ) as Record<string, unknown>;

    for (const mapped of [jsonbSafeTransformer.to(served), jsonbSafeTransformer.from(served)]) {
      const object = mapped as Record<string, unknown>;
      expect(Object.keys(object)).toEqual(['__proto__', 'constructor', 'ok', 'n']);
      expect(Object.getOwnPropertyDescriptor(object, '__proto__')?.value).toEqual({ hidden: 'x' });
      expect((object as { hidden?: unknown }).hidden).toBeUndefined();
      expect(JSON.stringify(mapped)).toBe(JSON.stringify(served));
    }
  });

  /**
   * Round-two review R2-2: a string stored before the transformer existed may
   * start with U+E000 without being an encoded one. Decoding is total: only a
   * body the encoder could have produced is decoded, anything else reads back
   * as stored.
   */
  it.each([
    ['a trailing backslash', `${JSONB_ESCAPE_MARK}ends with \\`],
    ['an unknown escape', `${JSONB_ESCAPE_MARK}a\\qb`],
    ['a short \\u escape', `${JSONB_ESCAPE_MARK}x\\u12`],
    ['a \\u escape of a non-surrogate', `${JSONB_ESCAPE_MARK}\\u0041`],
    ['an uppercase \\u escape', `${JSONB_ESCAPE_MARK}\\uD800`],
    ['a mark with nothing to escape', `${JSONB_ESCAPE_MARK}plain`],
    ['escaped surrogates that form a pair', `${JSONB_ESCAPE_MARK}\\ud83d\\ude00`],
  ])('reads a legacy string with %s back unchanged', (_label, stored) => {
    expect(jsonbSafeTransformer.from(stored)).toBe(stored);
    expect(jsonbSafeTransformer.from(jsonbSafeTransformer.to(stored))).toBe(stored);
  });

  it('round-trips an ordinary string that starts with the mark', () => {
    const original = `${JSONB_ESCAPE_MARK}private use \\ ok`;
    const stored = jsonbSafeTransformer.to(original) as string;
    expect(stored).not.toBe(original);
    expect(jsonbSafeTransformer.from(stored)).toBe(original);
  });

  it.each([
    [VerificationRecordEntity, 'request'],
    [VerificationRecordEntity, 'response'],
    [VerificationRecordEntity, 'stages'],
    [VerificationRecordEntity, 'verifiers'],
    [VerificationRecordEntity, 'tally'],
    [VerificationRecordEntity, 'decidedBy'],
    [EvidencePackEntity, 'core'],
    [EvidenceBodyEntity, 'request'],
    [EvidenceBodyEntity, 'response'],
  ])('is installed on %p.%s', (entity, property) => {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === entity && c.propertyName === property,
    );
    expect(column?.options.transformer).toBe(jsonbSafeTransformer);
  });
});
