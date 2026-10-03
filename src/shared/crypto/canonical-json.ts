/**
 * Deterministic JSON serialisation, shared by everything that hashes a
 * document.
 *
 * It lived in `payment/domain/request-hash.ts` until the evidence pack needed
 * the same bytes for a different reason: a voucher binds a request, and an evidence
 * pack binds a verdict, but both are "hash this document and be able to prove
 * later that it is the same document". Two implementations of that would be two
 * chances to disagree.
 *
 * ## Why it throws its own error and not a module's
 *
 * `shared/` cannot reach into a module's error catalog without inverting the
 * dependency, so this file throws `CanonicalJsonError` and each caller maps it
 * into its own vocabulary — `PAYMENT_REQUEST_NOT_CANONICALISABLE` for a
 * voucher pre-image, and whatever the verification module decides for a pack.
 * The `path` and `reason` survive the mapping, which is the part a caller
 * actually needs.
 */

/** Refuses a value that is not JSON, naming where in the document it sits. */
export class CanonicalJsonError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Value at ${path} cannot be canonicalised: ${reason}`);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * A deterministic JSON serialisation: object keys sorted, no insignificant
 * whitespace, arrays left in order.
 *
 * Sorting is by UTF-16 code unit (`Array.prototype.sort` with no comparator),
 * not by locale. A locale-aware collation would make the hash depend on the
 * server's `LANG`, which is a binding that breaks when someone changes a
 * Dockerfile.
 *
 * Array order is **preserved**. `["a","b"]` and `["b","a"]` are different
 * requests: a list of symbols to price, or a sequence of operations to apply,
 * means something different reordered.
 *
 * Two limits worth naming, because both are safe and both look like bugs:
 *
 * - `1` and `1.0` produce the same bytes, because JavaScript cannot tell them
 *   apart after `JSON.parse`. They are the same JSON number, so any consumer
 *   downstream treats them identically too.
 * - A property whose value is `undefined` is dropped, matching `JSON.stringify`
 *   and therefore matching what a client could actually have transmitted.
 *
 * Anything that is not JSON — a `Date`, a `Map`, a class instance, a `bigint`,
 * a function — is **refused**, not coerced. `JSON.stringify` turns a `Map` into
 * `{}`, which would hash a request whose parameters silently vanished.
 *
 * ## A constraint this places on whatever forwards the request
 *
 * The hash is over the **parsed** value, so distinct wire representations
 * legitimately collapse onto one digest: `{"a":1,"a":2}` parses to `{a:2}`,
 * `10000000000000000001` and `…002` are one double, `-0` is `0`. That is
 * harmless *only while the request executed upstream is rebuilt from the same
 * parsed value*.
 *
 * A proxy that forwards the **original raw bytes** breaks it. A provider whose
 * JSON parser takes the first duplicate key — the usual behaviour in Go and
 * several JVM stacks, where V8 takes the last — would then execute `a=1` while
 * the agent signed for `a=2`: a request other than the one authorised, with a
 * valid voucher. The rule for the forwarding layer is therefore: **hash the
 * parsed value and forward the re-serialised parsed value, never the raw
 * body.**
 */
export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      // `JSON.stringify` on a string is the JSON string grammar, escapes and
      // all, and is specified — not a place to hand-roll an encoder.
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(path, 'non-finite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(path, `${typeof value} is not JSON`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(
      path,
      `${(value as object).constructor?.name ?? 'object'} is not a plain object`,
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`)}`)
    .join(',')}}`;
}
