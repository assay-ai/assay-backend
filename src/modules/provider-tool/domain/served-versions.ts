import { compareSemverText } from '@modules/tool/domain/contract/semver';
import { bindingRange } from '@modules/tool/domain/contract/version-range';
import { BindingStatus, ToolVersionStatus } from '@modules/tool/ports/tool.types';

/** A version row, as far as serving reads it. */
interface ServedRow {
  readonly status: string;
  readonly major: number;
  readonly semver: string;
  readonly version: number;
}

export function isServedRow(row: Pick<ServedRow, 'status'>): boolean {
  return row.status === ToolVersionStatus.ACTIVE || row.status === ToolVersionStatus.DEPRECATED;
}

/**
 * The versions a tool can serve a call at: the newest ACTIVE or DEPRECATED
 * version of each major (§7.3 — within a range, a call is served at the
 * highest version; an older minor of the same major never answers). An
 * older minor the provider replaced is never sent to a model, so it never
 * blocks the tool.
 */
export function servedVersionsOf<T extends ServedRow>(rows: readonly T[]): T[] {
  const newest = new Map<number, T>();
  for (const row of rows.filter(isServedRow)) {
    const held = newest.get(row.major);
    if (!held || compareSemverText(row.semver, held.semver) > 0) newest.set(row.major, row);
  }
  return [...newest.values()].sort((a, b) => a.version - b.version);
}

/** The majors an ACTIVE or PAUSED binding serves (a paused one resumes without a re-publish). */
export function boundMajorsOf(
  bindings: readonly { readonly status: string; readonly toolVersionRange: string | null }[],
): Set<number> {
  return new Set(
    bindings
      .filter((row) => row.status === BindingStatus.ACTIVE || row.status === BindingStatus.PAUSED)
      .flatMap((row) => bindingRange(row.toolVersionRange)),
  );
}

/**
 * What the gate screens and a first review covers: of the served versions,
 * the majors of `keep` (the current version, a draft) and each major a
 * binding serves. A deprecated major no binding serves answers no call, so
 * a broken v1 never blocks the v2 that replaced it.
 */
export function screenedVersionsOf<T extends ServedRow>(
  rows: readonly T[],
  keep: readonly (number | null)[],
  boundMajors: ReadonlySet<number>,
): T[] {
  const kept = new Set(rows.filter((row) => keep.includes(row.version)).map((row) => row.major));
  return servedVersionsOf(rows).filter((row) => kept.has(row.major) || boundMajors.has(row.major));
}
