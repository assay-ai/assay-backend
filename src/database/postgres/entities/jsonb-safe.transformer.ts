import { ValueTransformer } from 'typeorm';

/**
 * Makes any JSON value storable in a PostgreSQL `jsonb` column, and gives it
 * back unchanged on read.
 *
 * ## Why this exists
 *
 * `jsonb` refuses two things a JavaScript string can hold and `JSON.stringify`
 * happily writes: the escape `\u0000` (U+0000) and an unpaired UTF-16
 * surrogate (`\ud800` with no low half). Both fail the whole statement with
 * `22P05 unsupported Unicode escape sequence`. Request and response bodies are
 * written by buyers and providers, so either of them could make the platform
 * fail to record a call it already served — and on the paid path that write
 * is the verification enqueue (final review N-3).
 *
 * ## The encoding — reversible, and a no-op for ordinary text
 *
 * Applied to every string *and every object key*, recursively:
 *
 * - A string with no U+0000, no lone surrogate and not starting with
 *   {@link JSONB_ESCAPE_MARK} is stored exactly as it is. That is every string
 *   an honest call contains.
 * - Any other string is stored as `MARK + body`, where `body` is the original
 *   with `\` written as `\\`, U+0000 as `\0`, and each lone surrogate as `\u`
 *   followed by its four lowercase hex digits.
 *
 * The mark (U+E000, the first private-use code point) is what makes it
 * reversible: a stored string starting with it is always an encoded one,
 * because an original that started with it is encoded too. Reading strips the
 * mark and undoes the three escapes, so every reader — the judge, the evidence
 * sealer, a dispute replay — sees the bytes that were served, and a digest
 * recomputed from a read matches the one taken before the write.
 */
export const JSONB_ESCAPE_MARK = '';

export const jsonbSafeTransformer: ValueTransformer = {
  to: (value: unknown) => mapJson(value, encodeString),
  from: (value: unknown) => mapJson(value, decodeString),
};

function mapJson(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => mapJson(item, map));
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[map(key)] = mapJson(item, map);
  return out;
}

/**
 * Only JSON objects are walked. Anything else — `null`, a `Date`, a TypeORM
 * `FindOperator` in a `where` — passes through untouched.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function encodeString(text: string): string {
  if (!needsEscape(text)) return text;

  let body = '';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0x5c) body += '\\\\';
    else if (unit === 0) body += '\\0';
    else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      body += text[i] + text[i + 1];
      i++;
    } else if (isHighSurrogate(unit) || isLowSurrogate(unit)) {
      body += `\\u${unit.toString(16).padStart(4, '0')}`;
    } else body += text[i];
  }
  return JSONB_ESCAPE_MARK + body;
}

function decodeString(text: string): string {
  if (!text.startsWith(JSONB_ESCAPE_MARK)) return text;

  let out = '';
  for (let i = JSONB_ESCAPE_MARK.length; i < text.length; i++) {
    if (text[i] !== '\\') {
      out += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === '0') {
      out += '\u0000';
      i += 1;
    } else if (next === 'u') {
      out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
      i += 5;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

function needsEscape(text: string): boolean {
  if (text.startsWith(JSONB_ESCAPE_MARK)) return true;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0) return true;
    if (isHighSurrogate(unit)) {
      if (!isLowSurrogate(text.charCodeAt(i + 1))) return true;
      i++;
    } else if (isLowSurrogate(unit)) return true;
  }
  return false;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
