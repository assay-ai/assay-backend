import {
  ProviderResponse,
  ResponseBody,
  ResponseBodyKind,
  TransportError,
} from '../classification/classification.types';
import { JsonValue } from '../mapping/mapping.types';

/**
 * Removes the call's credential header values from what a provider sent back.
 *
 * A provider may echo what it received: a header in a debug body, the
 * `Authorization` value in an error page, a decoded Basic user in a 401. Every
 * part of a {@link ProviderResponse} is stored or shown somewhere — the tester
 * report and its stored run (`binding_test_runs.report`), the response mapping
 * handed to the agent, MCP evidence, the router's and the attempt's logs — so
 * the invoker runs every response through this **before** it returns, and
 * nothing downstream ever holds a value to leak.
 *
 * Each value is matched in every form it can plausibly come back in, and each
 * match becomes {@link REDACTED}:
 *
 * - **as sent, any case** (`i` flag), so an upper-cased echo is caught too;
 * - **per character, in any mix of encodings**: percent-encoded (upper- or
 *   lower-case `%xx`, or every byte), form-encoded (`+` for a space),
 *   JSON-escaped (`\"`, `\\`, `\/`, `\t`, `\u00xx` as Go writes `<>&`) and
 *   HTML entities (named, `&#nn;`, `&#xhh;`);
 * - **base64**, standard and url-safe, with or without padding, at every byte
 *   alignment: a value inside a larger encoded blob (`Basic
 *   base64(user:value)`) changes its encoding with its offset. The aligned core
 *   is matched plus up to three neighbouring base64 characters on each side,
 *   which hold the value's edge bits. That can also take up to three
 *   characters of an adjacent token: over-redaction is the safe direction.
 *
 * Besides the whole value, each whitespace-separated part is a needle (`Bearer
 * <token>` echoed as just the token), and a `Basic` value also contributes its
 * decoded `user:pass` and each `:`-separated part.
 *
 * **Values (and parts) shorter than {@link MIN_REDACTED_LENGTH} characters are
 * not redacted.** A short needle would match ordinary text (a scheme word, a
 * user name, a status) and mangle responses for no protection: a secret that
 * short is guessable anyway. Matching is longest-first, so a value that
 * contains another is replaced whole.
 */
export const REDACTED = '[REDACTED]';

/** Needles shorter than this are not redacted; see {@link CredentialRedactor}. */
export const MIN_REDACTED_LENGTH = 8;

/** Trailing edge of a base64 match; the leading edge is taken in `string()`, see there. */
const BASE64_TAIL = '[A-Za-z0-9+/_-]{0,3}={0,2}';
const BASE64_CHAR = /[A-Za-z0-9+/_-]/;

export class CredentialRedactor {
  private readonly pattern: RegExp | null;

  constructor(values: readonly string[]) {
    const needles = [...new Set(values.flatMap(needlesOf))]
      .filter((needle) => needle.length >= MIN_REDACTED_LENGTH)
      .sort((a, b) => b.length - a.length);
    // Group 1 is a base64 match, whose leading edge `string()` extends.
    const characters = needles.map(characterPattern);
    const base64 = needles.flatMap(base64Patterns);
    this.pattern =
      needles.length === 0
        ? null
        : new RegExp(`${characters.join('|')}|(${base64.join('|')})`, 'gi');
  }

  static readonly NONE = new CredentialRedactor([]);

  get empty(): boolean {
    return this.pattern === null;
  }

  string(value: string): string {
    if (this.pattern === null) return value;
    // Matched ranges, merged. A base64 match is extended back by up to three
    // base64 characters (the value's leading bits, see above) here rather
    // than in the pattern: a leading `{0,3}` there is tried at every position
    // of the text and triples the scan time.
    const ranges: Array<[number, number]> = [];
    for (const match of value.matchAll(this.pattern)) {
      let start = match.index ?? 0;
      const end = start + match[0].length;
      if (match[1] !== undefined) {
        for (let n = 0; n < 3 && start > 0 && BASE64_CHAR.test(value[start - 1]); n += 1) {
          start -= 1;
        }
      }
      const last = ranges[ranges.length - 1];
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }
    if (ranges.length === 0) return value;
    let out = '';
    let from = 0;
    for (const [start, end] of ranges) {
      out += value.slice(from, start) + REDACTED;
      from = end;
    }
    return out + value.slice(from);
  }

  json(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.string(value);
    if (Array.isArray(value)) return value.map((item) => this.json(item));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.string(key), this.json(item)]),
      );
    }
    return value;
  }

  response(response: ProviderResponse): ProviderResponse {
    if (this.pattern === null) return response;
    return {
      ...response,
      ...(response.headers
        ? {
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [key, this.string(value)]),
            ),
          }
        : {}),
      body: this.body(response.body),
      ...(response.transportError
        ? { transportError: this.transportError(response.transportError) }
        : {}),
    };
  }

  private transportError(error: TransportError): TransportError {
    return {
      ...error,
      ...(error.detail !== undefined ? { detail: this.string(error.detail) } : {}),
      ...(typeof error.partialBody === 'string'
        ? { partialBody: this.string(error.partialBody) }
        : {}),
    };
  }

  private body(body: ResponseBody): ResponseBody {
    switch (body.kind) {
      case ResponseBodyKind.JSON:
        return { kind: ResponseBodyKind.JSON, value: this.json(body.value) };
      case ResponseBodyKind.NON_JSON:
        return {
          kind: ResponseBodyKind.NON_JSON,
          raw: this.string(body.raw),
          detail: this.string(body.detail),
        };
      default:
        return body;
    }
  }
}

/** The value, its whitespace-separated parts, and a Basic value's decoded user:pass and parts. */
function needlesOf(value: string): string[] {
  const needles = [value, ...value.split(/\s+/)];
  const basic = /^basic\s+([A-Za-z0-9+/_-]+={0,2})$/i.exec(value.trim());
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    if (/^[\x20-\x7E]+$/.test(decoded)) needles.push(decoded, ...decoded.split(':'));
  }
  return needles;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  '&': 'amp',
  '<': 'lt',
  '>': 'gt',
  '"': 'quot',
  "'": 'apos',
};

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '/': '\\/',
  '\t': '\\t',
};

/**
 * One alternation group per character: the character itself or any of its
 * encodings, so a value is matched in any mix of them. Case-insensitivity
 * comes from the `i` flag on the combined pattern.
 */
function characterPattern(value: string): string {
  return [...value].map(characterAlternatives).join('');
}

function characterAlternatives(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const bytes = [...Buffer.from(char, 'utf8')];
  const forms = [escapeRegExp(char), bytes.map((b) => `%${hex(b, 2)}`).join('')];
  if (char === ' ') forms.push('\\+');
  if (code <= 0xffff) forms.push(escapeRegExp(`\\u${hex(code, 4)}`));
  if (JSON_ESCAPES[char]) forms.push(escapeRegExp(JSON_ESCAPES[char]));
  forms.push(`&#0*${code};`, `&#x0*${code.toString(16)};`);
  if (NAMED_ENTITIES[char]) forms.push(`&${NAMED_ENTITIES[char]};`);
  return `(?:${forms.join('|')})`;
}

/**
 * The base64 encodings of `value` at the three byte alignments, standard and
 * url-safe: the groups made only of the value's bytes, plus the edge
 * characters on each side that carry its remaining bits, plus padding.
 */
function base64Patterns(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const cores = new Set<string>();
  for (let offset = 0; offset < 3; offset += 1) {
    const lead = offset === 0 ? 0 : 3 - offset;
    const whole = Math.floor((bytes.length - lead) / 3) * 3;
    if (whole <= 0) continue;
    const core = bytes.subarray(lead, lead + whole).toString('base64');
    cores.add(core);
    cores.add(core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return [...cores].map((core) => `${escapeRegExp(core)}${BASE64_TAIL}`);
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}
