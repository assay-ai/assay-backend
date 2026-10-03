import { JsonValue } from './mapping.types';

/**
 * The selector dialect.
 *
 * A deliberately small subset of JSONPath — enough to address any real
 * provider response, small enough that a provider can learn it from three
 * examples in the binding editor and small enough that every selector can be
 * parsed, validated and explained without executing it.
 *
 * ```text
 * $                       the root
 * $.a.b.c                 dotted member access, any depth
 * $['a-b']  $["a b"]      bracketed member access, for keys dots cannot spell
 * $.items[0]              array index
 * $.items[*]              wildcard — every element, flattened
 * @                       inside `$item`, the current element
 * ```
 *
 * What is deliberately absent: filters (`[?(@.x > 1)]`), slices, recursive
 * descent (`..`), and expressions. Each of those turns a selector into a small
 * program, and the whole premise of the format is that a mapping is data. A
 * provider who needs a filter needs a transform, and transforms are named.
 */

/** One parsed step of a selector. */
export type PathSegment =
  | { readonly kind: 'KEY'; readonly key: string }
  | { readonly kind: 'INDEX'; readonly index: number }
  | { readonly kind: 'WILDCARD' };

export interface ParsedPath {
  /** `true` when the selector was rooted at `@` rather than `$`. */
  readonly relative: boolean;
  readonly segments: readonly PathSegment[];
  /** `true` when any segment is `[*]` — such a selector reads many values, not one. */
  readonly hasWildcard: boolean;
}

/**
 * The three outcomes of reading a selector, and they are three rather than two
 * on purpose.
 *
 * `NULL` and `MISSING` are different facts. A provider that returns
 * `{"publishedAt": null}` is telling us it has no publication date for this
 * item; a provider whose response has no `publishedAt` key at all may be
 * telling us the same thing — or may be telling us our selector is pointed at
 * the wrong field. Only the second is evidence about our mapping. Every engine
 * that returns `undefined` for both throws that distinction away at the one
 * moment it is free to keep, and then cannot recover it downstream when a
 * receipt or a dispute needs it.
 */
export type PathRead =
  /** The selector resolved to a value that is not `null`. */
  | { readonly kind: 'FOUND'; readonly value: JsonValue }
  /** The selector resolved, and the value is explicitly `null`. */
  | { readonly kind: 'NULL' }
  /** The selector did not resolve. Some segment of it does not exist. */
  | { readonly kind: 'MISSING' };

/** Reading a wildcard selector: many values, or no collection at all. */
export type CollectionRead =
  /** The selector resolved to a list. May be empty — that is data, not a failure. */
  | { readonly kind: 'FOUND'; readonly items: readonly JsonValue[] }
  /** The selector resolved to an explicit `null` where a collection was expected. */
  | { readonly kind: 'NULL' }
  /** The selector did not resolve. */
  | { readonly kind: 'MISSING' }
  /** The selector resolved to something that is not a list. */
  | { readonly kind: 'NOT_ARRAY'; readonly value: JsonValue };

export class PathSyntaxError extends Error {}

const ROOT_ABSOLUTE = '$';
const ROOT_RELATIVE = '@';

/**
 * Parses a selector into segments, or throws {@link PathSyntaxError}.
 *
 * Parsing is separate from reading so the binding editor can reject a
 * malformed selector at Save, with the offending character named, rather than
 * at 3am on the first call that happens to use that binding.
 */
export function parsePath(selector: string): ParsedPath {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new PathSyntaxError('Selector must be a non-empty string');
  }

  const root = selector[0];
  if (root !== ROOT_ABSOLUTE && root !== ROOT_RELATIVE) {
    throw new PathSyntaxError(`Selector must start with "$" or "@": ${selector}`);
  }

  const segments: PathSegment[] = [];
  let cursor = 1;

  while (cursor < selector.length) {
    const char = selector[cursor];

    if (char === '.') {
      cursor += 1;
      const start = cursor;
      while (cursor < selector.length && !'.['.includes(selector[cursor])) {
        cursor += 1;
      }
      const key = selector.slice(start, cursor);
      if (key.length === 0) {
        throw new PathSyntaxError(`Empty member name at position ${start}: ${selector}`);
      }
      segments.push({ kind: 'KEY', key });
      continue;
    }

    if (char === '[') {
      const close = selector.indexOf(']', cursor);
      if (close === -1) {
        throw new PathSyntaxError(`Unclosed "[" at position ${cursor}: ${selector}`);
      }
      const inner = selector.slice(cursor + 1, close);
      segments.push(parseBracket(inner, selector, cursor));
      cursor = close + 1;
      continue;
    }

    throw new PathSyntaxError(`Unexpected "${char}" at position ${cursor}: ${selector}`);
  }

  return {
    relative: root === ROOT_RELATIVE,
    segments,
    hasWildcard: segments.some((segment) => segment.kind === 'WILDCARD'),
  };
}

function parseBracket(inner: string, selector: string, at: number): PathSegment {
  if (inner === '*') {
    return { kind: 'WILDCARD' };
  }

  const quoted = /^'(.*)'$|^"(.*)"$/.exec(inner);
  if (quoted) {
    const key = quoted[1] ?? quoted[2] ?? '';
    if (key.length === 0) {
      throw new PathSyntaxError(`Empty quoted member name at position ${at}: ${selector}`);
    }
    return { kind: 'KEY', key };
  }

  if (/^\d+$/.test(inner)) {
    return { kind: 'INDEX', index: Number.parseInt(inner, 10) };
  }

  throw new PathSyntaxError(
    `Bracket must contain an index, a quoted member name or "*", got "${inner}": ${selector}`,
  );
}

/** `true` when `selector` parses. Used by the static validator; never swallows the reason. */
export function isValidPath(selector: string): boolean {
  try {
    parsePath(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a single value.
 *
 * A wildcard selector reaching here is a programming error rather than a data
 * error — the static validator rejects wildcards outside `$from`, so by the
 * time a spec executes this cannot happen. If it does, the first match is
 * taken rather than guessing, and the caller sees a normal read.
 */
export function readPath(root: JsonValue, selector: string): PathRead {
  const parsed = parsePath(selector);
  return readParsed(root, parsed.segments);
}

function readParsed(root: JsonValue, segments: readonly PathSegment[]): PathRead {
  let current: JsonValue = root;

  for (const segment of segments) {
    if (current === null) {
      // A `null` partway down is not the value we were asked for; the rest of
      // the selector has nothing to walk. This is a miss, not a null result —
      // the null was at `$.a`, and we were asked for `$.a.b.c`.
      return { kind: 'MISSING' };
    }

    if (segment.kind === 'KEY') {
      if (typeof current !== 'object' || Array.isArray(current)) {
        return { kind: 'MISSING' };
      }
      if (!Object.prototype.hasOwnProperty.call(current, segment.key)) {
        return { kind: 'MISSING' };
      }
      current = current[segment.key];
      continue;
    }

    if (segment.kind === 'INDEX') {
      if (!Array.isArray(current) || segment.index >= current.length) {
        return { kind: 'MISSING' };
      }
      current = current[segment.index];
      continue;
    }

    // WILDCARD in a scalar read: take the first element, which is the only
    // reading that is not a guess. Rejected statically, so unreachable in a
    // validated spec.
    if (!Array.isArray(current) || current.length === 0) {
      return { kind: 'MISSING' };
    }
    current = current[0];
  }

  return current === null ? { kind: 'NULL' } : { kind: 'FOUND', value: current };
}

/**
 * Reads a collection — the `$from` selector of a projection.
 *
 * The four outcomes are all distinguishable because a projection has four
 * genuinely different things to say, and the caller's policy differs for each:
 * an empty list is usually a valid answer, a missing branch is usually our
 * mapping, an explicit `null` is usually the provider's data, and a non-array
 * is usually a shape we misread.
 */
export function readCollection(root: JsonValue, selector: string): CollectionRead {
  const parsed = parsePath(selector);

  if (!parsed.hasWildcard) {
    const read = readParsed(root, parsed.segments);
    if (read.kind === 'MISSING') return { kind: 'MISSING' };
    if (read.kind === 'NULL') return { kind: 'NULL' };
    if (!Array.isArray(read.value)) return { kind: 'NOT_ARRAY', value: read.value };
    return { kind: 'FOUND', items: read.value };
  }

  return expand(root, parsed.segments);
}

/**
 * Walks segments, fanning out at each wildcard.
 *
 * `resolved` tracks whether any wildcard actually found an array to expand. A
 * wildcard over a missing branch yields no items — but so does a wildcard over
 * a genuinely empty array, and those must not report the same thing. The flag
 * is the only way to tell them apart after the fan-out has flattened
 * everything.
 */
function expand(root: JsonValue, segments: readonly PathSegment[]): CollectionRead {
  let frontier: JsonValue[] = [root];
  let fannedOut = false;

  for (const segment of segments) {
    if (segment.kind === 'WILDCARD') {
      const next: JsonValue[] = [];
      let sawArray = false;
      let sawNull = false;

      for (const node of frontier) {
        if (node === null) {
          sawNull = true;
          continue;
        }
        if (!Array.isArray(node)) continue;
        sawArray = true;
        next.push(...node);
      }

      if (!sawArray) {
        if (sawNull && !fannedOut) return { kind: 'NULL' };
        if (!fannedOut) {
          const only = frontier.length === 1 ? frontier[0] : undefined;
          return only === undefined || only === null
            ? { kind: 'MISSING' }
            : { kind: 'NOT_ARRAY', value: only };
        }
        // Already inside a fan-out: an element without the array is simply a
        // element that contributes nothing, not a failure of the selector.
        return { kind: 'FOUND', items: [] };
      }

      fannedOut = true;
      frontier = next;
      continue;
    }

    const next: JsonValue[] = [];
    let anyResolved = false;

    for (const node of frontier) {
      const read = readParsed(node, [segment]);
      if (read.kind === 'MISSING') continue;
      anyResolved = true;
      next.push(read.kind === 'NULL' ? null : read.value);
    }

    if (!anyResolved && !fannedOut) {
      return { kind: 'MISSING' };
    }

    frontier = next;
  }

  return { kind: 'FOUND', items: frontier };
}
