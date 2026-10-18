import {
  ContractChange,
  ContractShape,
  VersionBump,
  bumpSemver,
  compareSemverText,
  diffContracts,
  formatSemver,
  parseSemver,
} from '@modules/tool/domain/contract';
import { ToolVersionStatus } from '@modules/tool/ports/tool.types';

import { canonicalJson } from '@shared/crypto/canonical-json';

/**
 * Semver for a provider's own contract (design spec §7.5 "Version rules",
 * applied to provider tools). Pure; the same bump rules as the operator
 * editor:
 *
 * ```text
 * summary, description, examples, declared rules     patch
 * an optional field added                            minor
 * a field removed, renamed, promoted; a type change  major
 * ```
 *
 * A draft is bumped from the newest published version (or from the newest
 * version of the major it names); a new major only from the newest major,
 * and a deprecated or retired major takes no new version.
 */

export interface VersionRow {
  readonly version: number;
  readonly semver: string;
  readonly major: number;
  readonly status: string;
}

export interface ProviderDraftShape extends ContractShape {
  readonly declaredRules: readonly unknown[];
}

export interface DraftDiff {
  readonly bump: VersionBump | null;
  readonly changes: readonly ContractChange[];
}

/** The newest of `versions` by semver. */
export function newestOf<T extends VersionRow>(versions: readonly T[]): T | null {
  return [...versions].sort((a, b) => compareSemverText(b.semver, a.semver))[0] ?? null;
}

/** The diff a draft makes against its base, declared rules included (a patch). */
export function diffDraft(base: ProviderDraftShape | null, draft: ProviderDraftShape): DraftDiff {
  if (!base) return { bump: VersionBump.MAJOR, changes: [] };
  const diff = diffContracts(base, draft);
  const rulesChanged =
    canonicalJson([...(base.declaredRules ?? [])]) !==
    canonicalJson([...(draft.declaredRules ?? [])]);
  if (!rulesChanged) return diff;
  return {
    bump: diff.bump ?? VersionBump.PATCH,
    changes: [
      ...diff.changes,
      {
        kind: 'DOCS_CHANGED' as ContractChange['kind'],
        side: null,
        field: null,
        bump: VersionBump.PATCH,
        detail: 'declared verification rules changed',
      },
    ],
  };
}

export type SemverRefusal =
  | { readonly kind: 'NO_CHANGES'; readonly base: string }
  | { readonly kind: 'STATE'; readonly reason: string };

/**
 * The semver a draft against `base` publishes as, or why it cannot: `1.0.0`
 * for a first version.
 */
export function nextDraftSemver(
  base: VersionRow | null,
  bump: VersionBump | null,
  published: readonly VersionRow[],
  options: { readonly allowNoChange?: boolean } = {},
): { readonly semver: string } | { readonly refusal: SemverRefusal } {
  if (!base) return { semver: '1.0.0' };
  if (!bump && !options.allowNoChange) {
    return { refusal: { kind: 'NO_CHANGES', base: base.semver } };
  }
  const effective = bump ?? VersionBump.PATCH;
  const highest = published.reduce((max, version) => Math.max(max, version.major), 0);
  if (effective === VersionBump.MAJOR && base.major !== highest) {
    return {
      refusal: {
        kind: 'STATE',
        reason: `a new major is drafted against the newest version (v${highest}), not v${base.semver}`,
      },
    };
  }
  if (
    effective !== VersionBump.MAJOR &&
    published.some(
      (version) =>
        version.major === base.major &&
        (version.status === ToolVersionStatus.DEPRECATED ||
          version.status === ToolVersionStatus.RETIRED),
    )
  ) {
    return {
      refusal: {
        kind: 'STATE',
        reason: `v${base.major} is deprecated; change the newest major instead`,
      },
    };
  }
  const next = formatSemver(bumpSemver(parseSemver(base.semver), effective));
  if (published.some((version) => version.semver === next)) {
    return {
      refusal: {
        kind: 'STATE',
        reason: `v${next} already exists; draft against the newest version of v${parseSemver(next)?.major}`,
      },
    };
  }
  return { semver: next };
}

/** The newest published version below a draft's semver: what it was bumped from. */
export function baseForDraft<T extends VersionRow>(
  published: readonly T[],
  draftSemver: string,
): T | null {
  return newestOf(
    published.filter((version) => compareSemverText(version.semver, draftSemver) < 0),
  );
}
