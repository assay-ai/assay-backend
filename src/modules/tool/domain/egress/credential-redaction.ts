import {
  ProviderResponse,
  ResponseBody,
  ResponseBodyKind,
  TransportError,
  TransportErrorKind,
} from '../classification/classification.types';
import { JsonValue } from '../mapping/mapping.types';

/**
 * Removes the call's credential header values from what a provider sent back.
 *
 * A provider may echo what it received: a header in a debug body, the
 * `Authorization` value in an error page, a decoded Basic credential in a 401.
 * Every part of a {@link ProviderResponse} is stored or shown somewhere — the
 * tester report and its stored run (`binding_test_runs.report`), the response
 * mapping handed to the agent, MCP evidence, the router's and the attempt's
 * logs — so the invoker runs every response through this **before** it
 * returns, and nothing downstream ever holds a value to leak.
 *
 * ## What is matched
 *
 * - **A canonical view of the text**, built in one pass with a map back to the
 *   original offsets: `%xx` (either case) decoded, HTML entities decoded
 *   (`&amp; &lt; &gt; &quot; &apos;`, `&#nn;`, `&#xhh;`, any leading zeros),
 *   JSON escapes decoded (`\" \\ \/ \b \f \n \r \t \uXXXX`, letters in either
 *   case), ASCII lower-cased and `+` folded to a space (form encoding).
 *   Encodings may be mixed per character.
 * - **Each echo form as its own needle**: the value as sent, upper- and
 *   lower-cased, JSON-escaped, Go-JSON-escaped (`\u003c`), HTML-escaped,
 *   percent-encoded (either hex case) and form-encoded, each put through the
 *   same canonicaliser as the text. A value that itself contains `%41`, `\t`
 *   or `&amp;` canonicalises differently as sent and as encoded, so one
 *   decoded form is not enough. Out of scope: two encodings stacked (the HTML
 *   escape of a JSON escape, …).
 * - **Base64**, standard and url-safe, with or without padding, at all three
 *   byte alignments (a value inside a larger blob such as `Basic
 *   base64(user:value)` encodes differently at each offset), searched
 *   case-sensitively in the original text. Each alignment's needle is the run
 *   of whole groups made only of the value's bytes; a match is widened by up
 *   to three base64 characters on each side, which carry the value's edge
 *   bits, plus padding. That may take up to three characters of an adjacent
 *   token: over-redaction is the safe direction.
 * - **Needles**: the whole value, each whitespace-separated part (`Bearer
 *   <token>` echoed as just the token) and, for a `Basic` value, the decoded
 *   `user:pass` and the password. Never the user name alone: it is not a
 *   secret and is usually an ordinary word.
 * - **Values, not keys**: in a JSON body only string values are rewritten.
 *   Rewriting keys could merge two keys into one and change the data, so a
 *   key that holds a credential fails the whole response closed instead.
 *
 * **Needles shorter than {@link MIN_REDACTED_LENGTH} characters are not
 * redacted.** A short needle would match ordinary text (a scheme word, a
 * status) and mangle responses for no protection: a secret that short is
 * guessable anyway.
 *
 * ## Cost, and failing closed
 *
 * The provider controls both the credential and the response, so the scan
 * must not be steerable into super-linear time (a backtracking regex, or
 * `String.prototype.indexOf`, is). Matching uses an Aho–Corasick automaton:
 * linear in the text plus the needles, whatever their content.
 *
 * On top of that there is a hard budget per response: any one string longer
 * than {@link MAX_REDACTABLE_CHARS}, a scan running past the time budget
 * ({@link REDACTION_BUDGET_MS} plus {@link REDACTION_BUDGET_MS_PER_MIB} per MiB
 * scanned), or a JSON key holding a credential
 * **fails closed** — every header value and the body become
 * {@link REDACTED}, the internal note header {@link REDACTION_NOTE_HEADER} is
 * set, and the response carries a `PLATFORM_UNAVAILABLE` transport error with
 * the fixed detail {@link REDACTION_FAILED_DETAIL}: Assay's fault, never the
 * provider's, and no secret is exposed.
 */
export const REDACTED = '[REDACTED]';

/** Needles shorter than this are not redacted; see {@link CredentialRedactor}. */
export const MIN_REDACTED_LENGTH = 8;

/** Longest single string scanned; above it the response fails closed. */
export const MAX_REDACTABLE_CHARS = 5 * 1024 * 1024;

/** Base time budget per response, in ms; past it the response fails closed. */
export const REDACTION_BUDGET_MS = 250;

/** Added to the budget per MiB of text scanned (≈550 ms in all at the 5 MiB cap). */
export const REDACTION_BUDGET_MS_PER_MIB = 60;

/** Internal note on a fail-closed response. Never sent anywhere. */
export const REDACTION_NOTE_HEADER = 'x-assay-redaction';

/** The fixed transport-error detail of a fail-closed response. */
export const REDACTION_FAILED_DETAIL = 'response redaction exceeded its budget';

export interface RedactorOptions {
  /** Base budget; defaults to {@link REDACTION_BUDGET_MS}. Scales with the text, see there. */
  readonly budgetMs?: number;
  /** Clock in ms; `performance.now` by default. For tests. */
  readonly now?: () => number;
}

/** How often (in characters) a scan checks the clock. */
const CLOCK_STRIDE = 1 << 16;

/** Thrown inside a scan to give up on the whole response; see "failing closed". */
class FailClosed extends Error {}

const MIB = 1024 * 1024;

class Budget {
  private deadline: number;

  constructor(
    private readonly now: () => number,
    budgetMs: number,
  ) {
    this.deadline = now() + budgetMs;
  }

  /** Extends the deadline for `chars` more characters of text to scan. */
  allow(chars: number): void {
    this.deadline += (chars / MIB) * REDACTION_BUDGET_MS_PER_MIB;
  }

  check(): void {
    if (this.now() > this.deadline) throw new FailClosed();
  }
}

export class CredentialRedactor {
  private readonly canonical: Automaton | null;
  private readonly base64: Automaton | null;
  private readonly budgetMs: number;
  private readonly now: () => number;

  constructor(values: readonly string[], options: RedactorOptions = {}) {
    const needles = [...new Set(values.flatMap(needlesOf))].filter(
      (needle) => needle.length >= MIN_REDACTED_LENGTH,
    );
    const canonicalForms = new Set<string>();
    const base64Forms = new Set<string>();
    for (const needle of needles) {
      // Every echo form, put through the same canonicaliser as the text: a
      // value that itself contains `%41`, `\t` or `&amp;` canonicalises
      // differently as sent and as encoded, so each encoding is its own needle.
      for (const encode of ECHO_ENCODERS) {
        const form = codesToString(decode(encode(needle)).codes);
        if (form.length >= MIN_REDACTED_LENGTH) canonicalForms.add(form);
      }
      for (const core of base64Cores(needle)) base64Forms.add(core);
    }
    this.canonical = Automaton.of(canonicalForms);
    this.base64 = Automaton.of(base64Forms);
    this.budgetMs = options.budgetMs ?? REDACTION_BUDGET_MS;
    this.now = options.now ?? (() => performance.now());
  }

  private static none: CredentialRedactor | undefined;

  /** Redacts nothing. A getter: the matcher class is defined further down this module. */
  static get NONE(): CredentialRedactor {
    CredentialRedactor.none ??= new CredentialRedactor([]);
    return CredentialRedactor.none;
  }

  get empty(): boolean {
    return this.canonical === null && this.base64 === null;
  }

  /** `value` with every match replaced; all of it is {@link REDACTED} if the budget runs out. */
  string(value: string): string {
    if (this.empty) return value;
    try {
      return this.redact(value, this.budget());
    } catch (error) {
      if (error instanceof FailClosed) return REDACTED;
      throw error;
    }
  }

  /** String values rewritten; keys, numbers, booleans and nulls left as they are. */
  json(value: JsonValue): JsonValue {
    if (this.empty) return value;
    try {
      return this.redactJson(value, this.budget());
    } catch (error) {
      if (error instanceof FailClosed) return REDACTED;
      throw error;
    }
  }

  response(response: ProviderResponse): ProviderResponse {
    if (this.empty) return response;
    const budget = this.budget();
    try {
      return {
        ...response,
        ...(response.headers
          ? {
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([key, value]) => [
                  key,
                  this.redact(value, budget),
                ]),
              ),
            }
          : {}),
        body: this.body(response.body, budget),
        ...(response.transportError
          ? { transportError: this.transportError(response.transportError, budget) }
          : {}),
      };
    } catch (error) {
      if (error instanceof FailClosed) return failClosed(response);
      throw error;
    }
  }

  private budget(): Budget {
    return new Budget(this.now, this.budgetMs);
  }

  private redact(text: string, budget: Budget): string {
    if (text.length > MAX_REDACTABLE_CHARS) throw new FailClosed();
    budget.allow(text.length);
    budget.check();
    // Each pass reports matches in order of their end, so merging as they
    // arrive keeps only disjoint ranges: memory stays bounded by the text.
    const canonical = new RangeSet();
    if (this.canonical) {
      const view = decode(text);
      this.canonical.scan(view.codes, view.codes.length, budget, (start, end) => {
        canonical.add(view.starts[start], view.starts[end]);
      });
    }
    const base64 = new RangeSet();
    if (this.base64) {
      this.base64.scanText(text, budget, (start, end) => {
        const [from, to] = widenBase64(text, start, end);
        base64.add(from, to);
      });
    }
    budget.check();
    return replaceRanges(text, RangeSet.union(canonical, base64));
  }

  /**
   * String values rewritten. Keys are never rewritten (that could merge two
   * keys); a key that holds a credential fails the whole response closed.
   */
  private redactJson(value: JsonValue, budget: Budget): JsonValue {
    if (typeof value === 'string') return this.redact(value, budget);
    if (Array.isArray(value)) return value.map((item) => this.redactJson(item, budget));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (this.redact(key, budget) !== key) throw new FailClosed();
          return [key, this.redactJson(item, budget)];
        }),
      );
    }
    return value;
  }

  private transportError(error: TransportError, budget: Budget): TransportError {
    return {
      ...error,
      ...(error.detail !== undefined ? { detail: this.redact(error.detail, budget) } : {}),
      ...(typeof error.partialBody === 'string'
        ? { partialBody: this.redact(error.partialBody, budget) }
        : {}),
    };
  }

  private body(body: ResponseBody, budget: Budget): ResponseBody {
    switch (body.kind) {
      case ResponseBodyKind.JSON:
        return { kind: ResponseBodyKind.JSON, value: this.redactJson(body.value, budget) };
      case ResponseBodyKind.NON_JSON:
        return {
          kind: ResponseBodyKind.NON_JSON,
          raw: this.redact(body.raw, budget),
          detail: this.redact(body.detail, budget),
        };
      default:
        return body;
    }
  }
}

/** Nothing of the provider's answer survives; see "failing closed" above. */
function failClosed(response: ProviderResponse): ProviderResponse {
  return {
    status: 0,
    headers: {
      ...Object.fromEntries(Object.keys(response.headers ?? {}).map((key) => [key, REDACTED])),
      [REDACTION_NOTE_HEADER]: 'truncated',
    },
    body: { kind: ResponseBodyKind.NON_JSON, raw: REDACTED, detail: REDACTED },
    transportError: {
      kind: TransportErrorKind.PLATFORM_UNAVAILABLE,
      partialBody: null,
      detail: REDACTION_FAILED_DETAIL,
    },
  };
}

/** The value, its whitespace-separated parts, and a Basic value's decoded `user:pass` and password. */
function needlesOf(value: string): string[] {
  const needles = [value, ...value.split(/\s+/)];
  const basic = /^basic\s+([A-Za-z0-9+/_-]+={0,2})$/i.exec(value.trim());
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    if (/^[\x20-\x7E]+$/.test(decoded)) {
      needles.push(decoded);
      const colon = decoded.indexOf(':');
      if (colon >= 0) needles.push(decoded.slice(colon + 1));
    }
  }
  return needles;
}

// ---------------------------------------------------------------------------
// The canonical view
// ---------------------------------------------------------------------------

interface CanonicalView {
  /** Decoded, folded code units. */
  readonly codes: Uint16Array;
  /** `starts[i]` is the original offset where `codes[i]` begins; `starts[length]` is the text's length. */
  readonly starts: Int32Array;
}

const NAMED_ENTITIES: ReadonlyArray<readonly [string, number]> = [
  ['amp;', 0x26],
  ['lt;', 0x3c],
  ['gt;', 0x3e],
  ['quot;', 0x22],
  ['apos;', 0x27],
];

/** JSON escape letters, matched case-insensitively (an upper-cased echo of `\t` is `\T`). */
const JSON_ESCAPES: Readonly<Record<string, number>> = {
  '"': 0x22,
  '\\': 0x5c,
  '/': 0x2f,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  B: 0x08,
  F: 0x0c,
  N: 0x0a,
  R: 0x0d,
  T: 0x09,
};

/**
 * How a provider may echo a value back. Each is put through the canonicaliser
 * to become a needle. Out of scope: two encodings stacked (HTML of JSON, …).
 */
const ECHO_ENCODERS: ReadonlyArray<(value: string) => string> = [
  (value) => value,
  (value) => value.toUpperCase(),
  (value) => value.toLowerCase(),
  (value) => JSON.stringify(value).slice(1, -1),
  (value) =>
    JSON.stringify(value)
      .slice(1, -1)
      .replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
  (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  (value) => encodeURIComponent(value),
  (value) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  (value) => new URLSearchParams({ v: value }).toString().slice(2),
];

/** Lower-case ASCII and `+` → space: the case- and form-insensitivity of the canonical view. */
function foldCode(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  if (code === 0x2b) return 0x20;
  return code;
}

function codesToString(codes: Uint16Array): string {
  let out = '';
  for (let i = 0; i < codes.length; i += 1) out += String.fromCharCode(codes[i]);
  return out;
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/** Parses `[0-9a-f]` × `count` (hex) or `[0-9]` (decimal) at `at`; -1 if not all digits. */
function digits(text: string, at: number, count: number, radix: 10 | 16): number {
  if (at + count > text.length) return -1;
  let value = 0;
  for (let i = at; i < at + count; i += 1) {
    const d = hexValue(text.charCodeAt(i));
    if (d < 0 || d >= radix) return -1;
    value = value * radix + d;
  }
  return value;
}

/**
 * One left-to-right pass. Each output code unit comes from one contiguous
 * span of the input, so a canonical range maps back to an original range.
 */
function decode(text: string): CanonicalView {
  const codes = new Uint16Array(text.length);
  const starts = new Int32Array(text.length + 1);
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const raw = text.charCodeAt(i);
    if (raw !== 0x25 && raw !== 0x5c && raw !== 0x26) {
      // Fast path: not the start of an escape.
      codes[n] = foldCode(raw);
      starts[n] = i;
      n += 1;
      i += 1;
      continue;
    }
    const [code, width] = decodeAt(text, i);
    codes[n] = foldCode(code);
    starts[n] = i;
    n += 1;
    i += width;
  }
  starts[n] = text.length;
  return { codes: codes.subarray(0, n), starts: starts.subarray(0, n + 1) };
}

/** The code unit encoded at `i`, and how many input characters encode it. */
function decodeAt(text: string, i: number): [number, number] {
  const code = text.charCodeAt(i);
  if (code === 0x25 /* % */) {
    const byte = digits(text, i + 1, 2, 16);
    if (byte >= 0) return [byte, 3];
  } else if (code === 0x5c /* \ */ && i + 1 < text.length) {
    const next = text[i + 1];
    if (next === 'u' || next === 'U') {
      const unit = digits(text, i + 2, 4, 16);
      if (unit >= 0) return [unit, 6];
    } else if (JSON_ESCAPES[next] !== undefined) {
      return [JSON_ESCAPES[next], 2];
    }
  } else if (code === 0x26 /* & */) {
    return decodeEntity(text, i) ?? [code, 1];
  }
  return [code, 1];
}

function decodeEntity(text: string, i: number): [number, number] | null {
  if (text.charCodeAt(i + 1) === 0x23 /* # */) {
    const hex = text[i + 2] === 'x' || text[i + 2] === 'X';
    let from = hex ? i + 3 : i + 2;
    // Leading zeros are skipped whatever their number (`&#0000000115;`). Still
    // linear: a run of zeros follows at most one `&`.
    while (text.charCodeAt(from) === 0x30 && hexValue(text.charCodeAt(from + 1)) >= 0) from += 1;
    let end = from;
    // Then at most 8 significant digits, then `;`.
    while (end < text.length && end - from < 8 && hexValue(text.charCodeAt(end)) >= 0) end += 1;
    if (end === from || text.charCodeAt(end) !== 0x3b /* ; */) return null;
    const value = digits(text, from, end - from, hex ? 16 : 10);
    if (value < 0 || value > 0xffff) return null;
    return [value, end + 1 - i];
  }
  for (const [name, value] of NAMED_ENTITIES) {
    if (text.length - (i + 1) >= name.length) {
      let same = true;
      for (let k = 0; k < name.length && same; k += 1) {
        same = foldCode(text.charCodeAt(i + 1 + k)) === name.charCodeAt(k);
      }
      if (same) return [value, name.length + 1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

const BASE64_CHAR = /[A-Za-z0-9+/_-]/;

/**
 * Per alignment, the base64 of the whole 3-byte groups made only of the
 * value's bytes — standard and url-safe. The characters that depend on the
 * neighbouring bytes are left out and taken by {@link widenBase64}.
 */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const lead = offset === 0 ? 0 : 3 - offset;
    const whole = Math.floor((bytes.length - lead) / 3) * 3;
    if (whole <= 0) continue;
    const core = bytes.subarray(lead, lead + whole).toString('base64');
    if (core.length < MIN_REDACTED_LENGTH) continue;
    cores.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return cores;
}

function widenBase64(text: string, start: number, end: number): [number, number] {
  let from = start;
  for (let n = 0; n < 3 && from > 0 && BASE64_CHAR.test(text[from - 1]); n += 1) from -= 1;
  let to = end;
  for (let n = 0; n < 3 && to < text.length && BASE64_CHAR.test(text[to]); n += 1) to += 1;
  for (let n = 0; n < 2 && to < text.length && text[to] === '='; n += 1) to += 1;
  return [from, to];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Aho–Corasick over UTF-16 code units: one pass, linear in the text plus the
 * needles, for any needles and any text. Reports, at each end position, the
 * longest needle ending there (shorter ones ending there lie inside it).
 *
 * Transitions are stored sparsely — most trie nodes have one child, so a
 * first-child pair in typed arrays, with a `Map` only for branching nodes —
 * which keeps ten 4 KiB credentials' worth of needles small.
 */
class Automaton {
  private readonly firstChar: Int32Array;
  private readonly firstNode: Int32Array;
  private readonly more: Array<Map<number, number> | undefined>;
  private readonly fail: Int32Array;
  /** Length of the longest needle that ends at this node (itself or via suffix links); 0 if none. */
  private readonly out: Int32Array;

  static of(needles: Iterable<string>): Automaton | null {
    const list = [...needles].filter((needle) => needle.length > 0);
    return list.length === 0 ? null : new Automaton(list);
  }

  private constructor(needles: readonly string[]) {
    const capacity = needles.reduce((sum, needle) => sum + needle.length, 1);
    this.firstChar = new Int32Array(capacity).fill(-1);
    this.firstNode = new Int32Array(capacity);
    this.more = [];
    this.fail = new Int32Array(capacity);
    this.out = new Int32Array(capacity);
    const depth = new Int32Array(capacity);

    let nodes = 1;
    for (const needle of needles) {
      let node = 0;
      for (let i = 0; i < needle.length; i += 1) {
        const code = needle.charCodeAt(i);
        let child = this.child(node, code);
        if (child < 0) {
          child = nodes;
          nodes += 1;
          depth[child] = depth[node] + 1;
          this.addChild(node, code, child);
        }
        node = child;
      }
      this.out[node] = depth[node];
    }

    // Breadth-first: suffix links, and `out` inherited along them.
    const queue = new Int32Array(nodes);
    let head = 0;
    let tail = 0;
    this.forEachChild(0, (_code, child) => {
      this.fail[child] = 0;
      queue[tail] = child;
      tail += 1;
    });
    while (head < tail) {
      const node = queue[head];
      head += 1;
      if (this.out[node] === 0) this.out[node] = this.out[this.fail[node]];
      this.forEachChild(node, (code, child) => {
        let f = this.fail[node];
        while (f > 0 && this.child(f, code) < 0) f = this.fail[f];
        const target = this.child(f, code);
        this.fail[child] = target >= 0 && target !== child ? target : 0;
        queue[tail] = child;
        tail += 1;
      });
    }
  }

  /** Calls `found(start, end)` (end exclusive) for the longest match ending at each position. */
  scan(
    codes: Uint16Array,
    length: number,
    budget: Budget,
    found: (start: number, end: number) => void,
  ): void {
    let state = 0;
    for (let i = 0; i < length; i += 1) {
      if ((i & (CLOCK_STRIDE - 1)) === 0 && i > 0) budget.check();
      state = this.step(state, codes[i]);
      const len = this.out[state];
      if (len > 0) found(i + 1 - len, i + 1);
    }
  }

  /** {@link scan} over a string's code units, without copying them. */
  scanText(text: string, budget: Budget, found: (start: number, end: number) => void): void {
    let state = 0;
    for (let i = 0; i < text.length; i += 1) {
      if ((i & (CLOCK_STRIDE - 1)) === 0 && i > 0) budget.check();
      state = this.step(state, text.charCodeAt(i));
      const len = this.out[state];
      if (len > 0) found(i + 1 - len, i + 1);
    }
  }

  private step(from: number, code: number): number {
    let state = from;
    let next = this.child(state, code);
    while (next < 0 && state > 0) {
      state = this.fail[state];
      next = this.child(state, code);
    }
    return next < 0 ? 0 : next;
  }

  private child(node: number, code: number): number {
    if (this.firstChar[node] === code) return this.firstNode[node];
    return this.more[node]?.get(code) ?? -1;
  }

  private addChild(node: number, code: number, child: number): void {
    if (this.firstChar[node] < 0) {
      this.firstChar[node] = code;
      this.firstNode[node] = child;
      return;
    }
    let map = this.more[node];
    if (!map) {
      map = new Map();
      this.more[node] = map;
    }
    map.set(code, child);
  }

  private forEachChild(node: number, visit: (code: number, child: number) => void): void {
    if (this.firstChar[node] >= 0) visit(this.firstChar[node], this.firstNode[node]);
    this.more[node]?.forEach((child, code) => visit(code, child));
  }
}

/**
 * Disjoint ranges, sorted. Fed ranges in non-decreasing order of their end
 * (as a scan finds them), each `add` folds into the ranges it touches.
 */
class RangeSet {
  readonly ranges: Array<[number, number]> = [];

  add(start: number, end: number): void {
    let from = start;
    let to = end;
    while (this.ranges.length > 0 && from <= this.ranges[this.ranges.length - 1][1]) {
      const [lastFrom, lastTo] = this.ranges.pop() as [number, number];
      from = Math.min(from, lastFrom);
      to = Math.max(to, lastTo);
    }
    this.ranges.push([from, to]);
  }

  /** The union of two sets, merged. */
  static union(a: RangeSet, b: RangeSet): Array<[number, number]> {
    const all = [...a.ranges, ...b.ranges].sort((x, y) => x[0] - y[0]);
    const out: Array<[number, number]> = [];
    for (const [from, to] of all) {
      const last = out[out.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else out.push([from, to]);
    }
    return out;
  }
}

/** `text` with each of the disjoint, sorted `ranges` replaced by one {@link REDACTED}. */
function replaceRanges(text: string, ranges: ReadonlyArray<[number, number]>): string {
  if (ranges.length === 0) return text;
  let out = '';
  let from = 0;
  for (const [start, end] of ranges) {
    out += text.slice(from, start) + REDACTED;
    from = end;
  }
  return out + text.slice(from);
}
