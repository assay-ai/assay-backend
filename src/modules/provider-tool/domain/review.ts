import { createHash } from 'node:crypto';

import { canonicalJson } from '@shared/crypto/canonical-json';

/**
 * The review of a provider tool (design spec §7.6). Pure.
 *
 * ```text
 * PRIVATE ── publish gate ──► UNLISTED ("Not reviewed")
 *        └──────── submit ──► PENDING ──► APPROVED: LISTED (catalogue, /, /c/…, /@handle)
 *                                    └──► REJECTED, with a note: fix and resubmit
 *
 * LISTED + a new version ──► PENDING (the approved version keeps serving)
 * ```
 *
 * A review is for **content**, not for a number: the submission records the
 * SHA-256 of everything it covers, the operator's decision names the hash it
 * read, and the approval is refused if either differs from the content now
 * stored. That is what makes a bait-and-switch (edit after the operator read
 * it, before the click) impossible rather than unlikely.
 */

export enum ReviewStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/** What a review is for. */
export enum ReviewKind {
  /** The tool has never been approved: every version it serves is reviewed. */
  FIRST = 'FIRST',
  /** A LISTED tool's new version: reviewed before it serves. */
  CHANGE = 'CHANGE',
}

/** The provider console's review state (§7.6 "Review states"). */
export enum ReviewDisplayState {
  NOT_SUBMITTED = 'NOT_SUBMITTED',
  IN_REVIEW = 'IN_REVIEW',
  CHANGES_IN_REVIEW = 'CHANGES_IN_REVIEW',
  REJECTED = 'REJECTED',
  CHANGES_REJECTED = 'CHANGES_REJECTED',
  LISTED = 'LISTED',
}

export interface ReviewRow {
  readonly reviewStatus: string | null;
  readonly approvedVersion: number | null;
  readonly reviewVersion: number | null;
}

export interface ReviewDisplay {
  readonly state: ReviewDisplayState;
  /** The words the console shows. */
  readonly label: string;
}

/** The review state and its label, from the row alone. */
export function reviewDisplayOf(
  row: ReviewRow,
  semverOf: (version: number | null) => string | null = () => null,
): ReviewDisplay {
  const approved = row.approvedVersion !== null;
  const serving = semverOf(row.approvedVersion);
  const still = serving ? `v${serving} still serving` : 'the approved version still serving';
  switch (row.reviewStatus) {
    case ReviewStatus.PENDING:
      return approved
        ? { state: ReviewDisplayState.CHANGES_IN_REVIEW, label: `Changes in review; ${still}` }
        : { state: ReviewDisplayState.IN_REVIEW, label: 'In review' };
    case ReviewStatus.REJECTED:
      return approved
        ? {
            state: ReviewDisplayState.CHANGES_REJECTED,
            label: `Changes rejected; ${still}. Fix and resubmit`,
          }
        : { state: ReviewDisplayState.REJECTED, label: 'Rejected. Fix and resubmit' };
    case ReviewStatus.APPROVED:
      return { state: ReviewDisplayState.LISTED, label: 'Listed' };
    default:
      return approved
        ? { state: ReviewDisplayState.LISTED, label: 'Listed' }
        : { state: ReviewDisplayState.NOT_SUBMITTED, label: 'Not reviewed' };
  }
}

/** The kind of a review submitted now. */
export function reviewKindOf(row: Pick<ReviewRow, 'approvedVersion'>): ReviewKind {
  return row.approvedVersion === null ? ReviewKind.FIRST : ReviewKind.CHANGE;
}

/** One version as a review covers it: every word a model reads, and the rules. */
export interface ReviewedVersion {
  readonly version: number;
  readonly semver: string;
  readonly summary: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly optionalInputFields: readonly string[];
  readonly optionalOutputFields: readonly string[];
  readonly examples: readonly unknown[];
  readonly declaredRules: readonly unknown[];
}

/** SHA-256 over the versions a review covers, in version order: what an approval is for. */
export function reviewContentHash(name: string, versions: readonly ReviewedVersion[]): string {
  const ordered = [...versions]
    .sort((a, b) => a.version - b.version)
    .map((version) => ({
      version: version.version,
      semver: version.semver,
      summary: version.summary,
      description: version.description,
      inputSchema: version.inputSchema ?? null,
      outputSchema: version.outputSchema ?? null,
      optionalInputFields: [...(version.optionalInputFields ?? [])],
      optionalOutputFields: [...(version.optionalOutputFields ?? [])],
      examples: [...(version.examples ?? [])],
      declaredRules: [...(version.declaredRules ?? [])],
    }));
  return createHash('sha256')
    .update(canonicalJson({ name, versions: ordered }), 'utf8')
    .digest('hex');
}
