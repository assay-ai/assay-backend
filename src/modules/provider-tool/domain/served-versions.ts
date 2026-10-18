import { compareSemverText } from '@modules/tool/domain/contract/semver';
import { ToolVersionStatus } from '@modules/tool/ports/tool.types';

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
 * highest version; an older minor of the same major never answers). What
 * the gate screens and a first review covers: an older minor the provider
 * replaced is never sent to a model, so it never blocks the tool.
 */
export function servedVersionsOf<T extends ServedRow>(rows: readonly T[]): T[] {
  const newest = new Map<number, T>();
  for (const row of rows.filter(isServedRow)) {
    const held = newest.get(row.major);
    if (!held || compareSemverText(row.semver, held.semver) > 0) newest.set(row.major, row);
  }
  return [...newest.values()].sort((a, b) => a.version - b.version);
}
