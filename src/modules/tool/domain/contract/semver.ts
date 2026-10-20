/**
 * Contract versions, `MAJOR.MINOR.PATCH` (design spec §7.5).
 *
 * Only the three numbers: no pre-release or build tags. A contract version is
 * what a binding's range and a URL's `@N` pin are compared against, and a tag
 * would make "is 2.0.0-rc1 in ^2" a question nobody needs answered. Each part
 * is at most four digits so the whole fits `tool_versions.semver`.
 */

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** How a new version differs from the one before it (§7.5 "Version rules"). */
export enum VersionBump {
  PATCH = 'PATCH',
  MINOR = 'MINOR',
  MAJOR = 'MAJOR',
}

const SEMVER_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

export function parseSemver(text: string): Semver | null {
  const match = SEMVER_RE.exec(text);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatSemver(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** Negative when `a` is older than `b`. */
export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `text`'s ordering against `other`'s; an unparsable string sorts first. */
export function compareSemverText(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  return compareSemver(left, right);
}

/** The version after `from` for `bump`; `null` from means the first version, 1.0.0. */
export function bumpSemver(from: Semver | null, bump: VersionBump): Semver {
  if (!from) return { major: 1, minor: 0, patch: 0 };
  switch (bump) {
    case VersionBump.MAJOR:
      return { major: from.major + 1, minor: 0, patch: 0 };
    case VersionBump.MINOR:
      return { major: from.major, minor: from.minor + 1, patch: 0 };
    default:
      return { major: from.major, minor: from.minor, patch: from.patch + 1 };
  }
}

/** The larger of two bumps. */
export function maxBump(a: VersionBump | null, b: VersionBump | null): VersionBump | null {
  const rank = (bump: VersionBump | null) =>
    bump === VersionBump.MAJOR ? 3 : bump === VersionBump.MINOR ? 2 : bump ? 1 : 0;
  return rank(a) >= rank(b) ? a : b;
}
