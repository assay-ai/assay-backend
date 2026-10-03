/**
 * The promote gate.
 *
 * The rule and the reason fit in four sentences: every new or changed policy
 * starts in `SHADOW`; it is promoted to `ACTIVE` only when its measured
 * false-positive rate against **manually labelled** samples is below 2%; policy
 * changes are the highest-risk deploys in the system; shadow mode is mandatory,
 * not advisory.
 *
 * "Mandatory, not advisory" is a claim about a mechanism, not about a team
 * norm, so this file is that mechanism and it is written three times over:
 *
 * 1. **Here**, as a pure function that says whether the evidence clears the
 *    bar and, when it does not, exactly which bars it missed.
 * 2. **In the store**, which refuses to write `lifecycle = ACTIVE` without a
 *    promotion record.
 * 3. **In the schema**, as a CHECK constraint — see the
 *    `create-verification-policies` migration. An `ACTIVE` row with a null
 *    `promoted_at` cannot exist in the table, which is
 *    the one layer a future service, a migration script or a hand-typed
 *    `UPDATE` cannot route around.
 *
 * A policy that has not passed is not blocked from production. It runs in
 * `SHADOW` against real traffic, which is the only way to obtain the evidence
 * this gate asks for. It just cannot take anybody's money while it does.
 */

import { PolicyLifecycle } from '../aggregation/decision-policy.types';

/**
 * The bar: three numbers.
 */
export const PROMOTION_GATE = Object.freeze({
  /**
   * The false-positive rate is *"the only metric that can destroy supply"*,
   * target < 2%.
   *
   * Strictly below, not at — a policy sitting exactly on the number has not
   * demonstrated it is under it.
   */
  maxFalsePositiveRate: 0.02,

  /**
   * Labelled samples required before that rate means anything.
   *
   * 100 is the smallest count at which a 2% bar is measurable at all: below it,
   * a single mislabelled sample moves the measured rate by more than the whole
   * threshold, so a policy could clear the gate on one lucky reviewer.
   */
  minLabelledSamples: 100,

  /**
   * Shadow calls the policy must have judged, labelled or not.
   *
   * Separate from the labelled count because they answer different questions.
   * Labelled samples ask *is the policy right*; shadow volume asks *has the
   * policy seen the shape of real traffic* — the empty result sets, the odd
   * encodings, the provider that returns `results: null` on Sundays. A policy
   * promoted on 100 hand-picked samples and 100 calls has been tested against a
   * curated world.
   */
  minShadowCalls: 500,
});

/** What an operator submits when asking for a policy version to go live. */
export interface PromotionEvidence {
  /** Calls this policy version judged while in `SHADOW`. */
  readonly shadowCalls: number;
  /** Of those, how many a human labelled pass/fail by hand. */
  readonly labelledSamples: number;
  /**
   * Labelled samples the policy called a failure and the human called a pass.
   *
   * The numerator of the only metric that can destroy supply. Deliberately
   * *not* symmetric with false negatives, which are not gated at all: a missed
   * bad response costs one quality signal out of thousands, and a false
   * positive costs an honest provider money plus a reputation with no refund.
   */
  readonly falsePositives: number;
  /** Who asked. */
  readonly requestedBy: string;
  /**
   * Who approved.
   *
   * Must differ from {@link requestedBy}. The author of a policy is the person
   * least able to see its blind spot, and a gate one person can walk through
   * alone is a gate that is open.
   */
  readonly approvedBy: string;
  /** Free text: the ticket, the shadow dashboard, what changed and why. */
  readonly note?: string;
}

export enum PromotionRefusal {
  NOT_IN_SHADOW = 'NOT_IN_SHADOW',
  INSUFFICIENT_SHADOW_CALLS = 'INSUFFICIENT_SHADOW_CALLS',
  INSUFFICIENT_LABELLED_SAMPLES = 'INSUFFICIENT_LABELLED_SAMPLES',
  FALSE_POSITIVE_RATE_TOO_HIGH = 'FALSE_POSITIVE_RATE_TOO_HIGH',
  SELF_APPROVED = 'SELF_APPROVED',
  EVIDENCE_INCOHERENT = 'EVIDENCE_INCOHERENT',
}

export interface PromotionFailure {
  readonly code: PromotionRefusal;
  readonly detail: string;
}

export interface PromotionDecision {
  readonly promotable: boolean;
  /** Empty exactly when {@link promotable}. Every unmet bar, not just the first. */
  readonly failures: readonly PromotionFailure[];
  /** `falsePositives / labelledSamples`, or `null` when nothing was labelled. */
  readonly falsePositiveRate: number | null;
}

/**
 * Does this evidence clear the gate?
 *
 * Reports **every** failure rather than short-circuiting at the first. An
 * operator who is told "not enough labelled samples", fixes it, and is then
 * told "self-approved" has been made to do two rounds for information we had
 * on the first — and the friction of a gate is what gets gates disabled.
 */
export function evaluatePromotion(
  lifecycle: PolicyLifecycle,
  evidence: PromotionEvidence,
): PromotionDecision {
  const failures: PromotionFailure[] = [];

  if (lifecycle !== PolicyLifecycle.SHADOW) {
    failures.push({
      code: PromotionRefusal.NOT_IN_SHADOW,
      detail:
        `A policy is promoted from SHADOW, and this one is ${lifecycle}. ` +
        (lifecycle === PolicyLifecycle.DRAFT
          ? 'Put it into shadow first — the evidence this gate asks for can only be collected against real traffic.'
          : 'Only a shadowing version can be promoted.'),
    });
  }

  // Checked before the rate, because an incoherent count makes the rate a
  // number with no meaning rather than a number that is too high.
  if (
    !Number.isInteger(evidence.shadowCalls) ||
    !Number.isInteger(evidence.labelledSamples) ||
    !Number.isInteger(evidence.falsePositives) ||
    evidence.shadowCalls < 0 ||
    evidence.labelledSamples < 0 ||
    evidence.falsePositives < 0 ||
    evidence.labelledSamples > evidence.shadowCalls ||
    evidence.falsePositives > evidence.labelledSamples
  ) {
    failures.push({
      code: PromotionRefusal.EVIDENCE_INCOHERENT,
      detail:
        'Counts must be non-negative integers with falsePositives <= labelledSamples <= shadowCalls. ' +
        `Got shadowCalls=${evidence.shadowCalls}, labelledSamples=${evidence.labelledSamples}, ` +
        `falsePositives=${evidence.falsePositives}.`,
    });
  }

  if (evidence.shadowCalls < PROMOTION_GATE.minShadowCalls) {
    failures.push({
      code: PromotionRefusal.INSUFFICIENT_SHADOW_CALLS,
      detail: `${evidence.shadowCalls} shadow calls; ${PROMOTION_GATE.minShadowCalls} required.`,
    });
  }

  if (evidence.labelledSamples < PROMOTION_GATE.minLabelledSamples) {
    failures.push({
      code: PromotionRefusal.INSUFFICIENT_LABELLED_SAMPLES,
      detail: `${evidence.labelledSamples} labelled samples; ${PROMOTION_GATE.minLabelledSamples} required.`,
    });
  }

  const falsePositiveRate = falsePositiveRateOf(evidence);
  if (falsePositiveRate !== null && falsePositiveRate >= PROMOTION_GATE.maxFalsePositiveRate) {
    failures.push({
      code: PromotionRefusal.FALSE_POSITIVE_RATE_TOO_HIGH,
      detail:
        `Measured false-positive rate ${(falsePositiveRate * 100).toFixed(2)}%; ` +
        `the bar is below ${(PROMOTION_GATE.maxFalsePositiveRate * 100).toFixed(0)}%.`,
    });
  }

  if (
    evidence.approvedBy.trim() === '' ||
    evidence.requestedBy.trim() === '' ||
    evidence.approvedBy.trim().toLowerCase() === evidence.requestedBy.trim().toLowerCase()
  ) {
    failures.push({
      code: PromotionRefusal.SELF_APPROVED,
      detail: 'A policy must be approved by somebody other than the person who requested it.',
    });
  }

  return {
    promotable: failures.length === 0,
    failures,
    falsePositiveRate,
  };
}

/** `null` rather than `0` when nothing was labelled — see the gate's own note. */
export function falsePositiveRateOf(evidence: PromotionEvidence): number | null {
  if (evidence.labelledSamples <= 0) return null;
  return evidence.falsePositives / evidence.labelledSamples;
}
