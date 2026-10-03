import { canonicalJson } from '@shared/crypto/canonical-json';

/**
 * A structural diff between two `verification_policies.decision_document`
 * values — the pending (`SHADOW`) version against whichever version is
 * currently `ACTIVE` (for the policy change notice).
 *
 * ## Why not a textual diff
 *
 * These are jsonb documents, read back from Postgres as ordinary JS objects
 * with no guaranteed key order. A line diff of two `JSON.stringify` calls
 * would report noise for a document whose keys were merely re-inserted in a
 * different order and no change at all, and would fail to localise a real
 * change to the one clause that moved — which is exactly the information a
 * provider needs to decide whether a pending version costs them money. So
 * this walks both documents in parallel and reports **paths**: which keys or
 * array positions were added, removed, or changed, with the before/after
 * value at each.
 *
 * ## Why `canonicalJson` and not a hand-rolled deep-equal
 *
 * `canonicalJson` (`@shared/crypto/canonical-json.ts`) already defines what
 * "the same document" means for this codebase — sorted keys, no
 * insignificant whitespace, arrays left in order — because it is the same
 * question a policy's own hash answers. Reusing it here as the equality
 * oracle at every node means this diff can never disagree with that
 * definition: two subtrees are "the same" exactly when their canonical
 * serialisation is byte-identical. It is used only as that oracle, not to
 * produce the diff itself — canonicalising both whole documents and
 * comparing the two strings would tell you *that* they differ, never
 * *where*.
 *
 * ## Array diffing is index-based, not a minimal edit script
 *
 * `before[i]` is compared against `after[i]`; a value inserted at the front
 * of an array shows every following element as "changed" rather than as one
 * insertion plus untouched neighbours. That is a known, deliberate
 * simplification for the MVP notice — a positional diff of `verifiers` /
 * `clauses` is legible for the array sizes a decision document actually has
 * (single digits), and an LCS-based "moved" detector is more diff engine
 * than a notice needs. Revisit if a policy ever grows an array long enough
 * for this to read as noisy.
 */

export type PolicyDiffChangeType = 'added' | 'removed' | 'changed';

export interface PolicyDiffEntry {
  /** `$`-rooted, e.g. `$.verifiers[0].verifierId` — the same path grammar `canonicalJson` uses in its own errors. */
  readonly path: string;
  readonly changeType: PolicyDiffChangeType;
  /** `undefined` when `changeType` is `'added'`. */
  readonly before: unknown;
  /** `undefined` when `changeType` is `'removed'`. */
  readonly after: unknown;
}

/**
 * Diffs two decision documents. Either side may be `null` — there is no
 * `ACTIVE` version for a tool that has never been promoted — in which case
 * that side is treated as an empty document `{}`, so every top-level path of
 * the other side reports as wholly `'added'` or wholly `'removed'`. That is a
 * real, useful answer ("this pending version would introduce all of this,
 * since nothing is currently enforcing"), not a placeholder for a missing
 * case.
 */
export function diffPolicyDocuments(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): PolicyDiffEntry[] {
  return diffValue(before ?? {}, after ?? {}, '$');
}

function diffValue(before: unknown, after: unknown, path: string): PolicyDiffEntry[] {
  if (canonicalJson(before) === canonicalJson(after)) {
    return [];
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    return diffObject(before, after, path);
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    return diffArray(before, after, path);
  }

  // Different kinds of value (object vs array, object vs primitive, or two
  // unequal primitives) — nothing further to localise, the whole node changed.
  return [{ path, changeType: 'changed', before, after }];
}

function diffObject(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
): PolicyDiffEntry[] {
  const entries: PolicyDiffEntry[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  for (const key of keys) {
    const childPath = `${path}.${key}`;
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);

    if (!hasBefore) {
      entries.push({ path: childPath, changeType: 'added', before: undefined, after: after[key] });
    } else if (!hasAfter) {
      entries.push({
        path: childPath,
        changeType: 'removed',
        before: before[key],
        after: undefined,
      });
    } else {
      entries.push(...diffValue(before[key], after[key], childPath));
    }
  }

  return entries;
}

function diffArray(before: unknown[], after: unknown[], path: string): PolicyDiffEntry[] {
  const entries: PolicyDiffEntry[] = [];
  const length = Math.max(before.length, after.length);

  for (let index = 0; index < length; index += 1) {
    const childPath = `${path}[${index}]`;

    if (index >= before.length) {
      entries.push({
        path: childPath,
        changeType: 'added',
        before: undefined,
        after: after[index],
      });
    } else if (index >= after.length) {
      entries.push({
        path: childPath,
        changeType: 'removed',
        before: before[index],
        after: undefined,
      });
    } else {
      entries.push(...diffValue(before[index], after[index], childPath));
    }
  }

  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
