import { getMetadataArgsStorage } from 'typeorm';

import { EvidenceBodyEntity } from '@database/postgres/entities/evidence-body.entity';
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

  it.each([
    [VerificationRecordEntity, 'request'],
    [VerificationRecordEntity, 'response'],
    [EvidenceBodyEntity, 'request'],
    [EvidenceBodyEntity, 'response'],
  ])('is installed on %p.%s', (entity, property) => {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === entity && c.propertyName === property,
    );
    expect(column?.options.transformer).toBe(jsonbSafeTransformer);
  });
});
