import { canonicalJson } from '@shared/crypto/canonical-json';

/**
 * What the mapping tester actually exercises: the fields of a revision that
 * change **the call** — what the endpoint is asked, how long it is given, what
 * is read back, and the contract it is checked against (BUG-PRV-CATALOG-02).
 *
 * A passing run at one revision vouches for every revision whose call is the
 * same. The price, the pricing mode, the asset it is priced in and the chains
 * it settles on are terms of the offer, not of the call: the tester sends none
 * of them, so changing them (choosing Paid and a price at Go live) still makes
 * a new revision to publish, but does not ask for the test again. Anything
 * listed here does.
 */
export interface TestedCallTerms {
  readonly endpoint: string;
  readonly requestMapping: unknown;
  readonly responseMapping: unknown;
  readonly timeoutMs: number;
  readonly toolVersionRange?: string | null;
  readonly providesOutputFields?: readonly string[] | null;
  readonly supportsInputFields?: readonly string[] | null;
}

/** One comparable string of {@link TestedCallTerms}; `jsonb` key order does not matter. */
export function testedCallKey(source: TestedCallTerms): string {
  return canonicalJson([
    source.endpoint ?? null,
    source.requestMapping ?? null,
    source.responseMapping ?? null,
    Number(source.timeoutMs),
    source.toolVersionRange ?? '^1',
    [...(source.providesOutputFields ?? [])].sort(),
    [...(source.supportsInputFields ?? [])].sort(),
  ]);
}

/**
 * The revisions whose call is the current one's — `current` always, plus every
 * recorded revision (a `binding_versions` snapshot) with the same
 * {@link testedCallKey}. A tester run at any of them counts for `current`.
 */
export function revisionsWithSameCall(
  current: TestedCallTerms & { readonly mappingVersion: number },
  snapshots: readonly (TestedCallTerms & { readonly mappingVersion: number })[],
): number[] {
  const same = new Set<number>([current.mappingVersion]);
  // A term that cannot be compared is a call that is not the same.
  const keyOf = (source: TestedCallTerms): string | null => {
    try {
      return testedCallKey(source);
    } catch {
      return null;
    }
  };
  const key = keyOf(current);
  if (key === null) return [current.mappingVersion];
  for (const snapshot of snapshots) {
    if (snapshot.mappingVersion < current.mappingVersion && keyOf(snapshot) === key) {
      same.add(snapshot.mappingVersion);
    }
  }
  return [...same].sort((a, b) => b - a);
}
