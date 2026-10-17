/**
 * Contract version ranges: which majors a binding serves, or a toolset entry
 * routes to (design spec §7.2 `tool_version_range`, §7.3 "Contract version").
 *
 * A range is a set of majors, written `^1` or `^1 || ^2`. Majors are the only
 * grain: a minor version adds optional fields and never breaks a binding or a
 * buyer (§7.5), so a range that named minors would only ever be narrower than
 * it needs to be. A buyer who needs a field a minor added says so with
 * `require_output_fields`, which routing honours directly.
 */

export type VersionRange = readonly number[];

/** The column cap, `varchar(32)`. */
export const VERSION_RANGE_MAX_LENGTH = 32;

const RANGE_RE = /^\^\d{1,4}( \|\| \^\d{1,4})*$/;

/** The majors in `text`, ascending and distinct, or `null` when it is not a range. */
export function parseVersionRange(text: string | null | undefined): VersionRange | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/\s*\|\|\s*/g, ' || ');
  if (trimmed.length > VERSION_RANGE_MAX_LENGTH || !RANGE_RE.test(trimmed)) return null;
  const majors = trimmed.split(' || ').map((part) => Number(part.slice(1)));
  if (majors.some((major) => major < 1)) return null;
  return [...new Set(majors)].sort((a, b) => a - b);
}

/** The canonical spelling: `^1 || ^2`. */
export function formatVersionRange(range: VersionRange): string {
  return [...new Set(range)]
    .sort((a, b) => a - b)
    .map((major) => `^${major}`)
    .join(' || ');
}

/** The range of one major, `^N`. */
export function majorRange(major: number): VersionRange {
  return [major];
}

export function rangeCovers(range: VersionRange, major: number): boolean {
  return range.includes(major);
}

/** A binding's range; a missing or malformed one reads as the column default `^1`. */
export function bindingRange(text: string | null | undefined): VersionRange {
  return parseVersionRange(text ?? '^1') ?? [1];
}

/** The majors both ranges name; `null` stands for "unconstrained". */
export function intersectRanges(
  a: VersionRange | null,
  b: VersionRange | null,
): VersionRange | null {
  if (!a) return b;
  if (!b) return a;
  return a.filter((major) => b.includes(major));
}
