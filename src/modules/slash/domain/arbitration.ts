/**
 * The adjudication vocabulary, and the consequences each member carries.
 *
 * Pure: no imports, no I/O, no dates read from the clock. Everything here is a
 * statement about what a word means, so that the services below it cannot mean
 * something slightly different in two places.
 *
 * ## Six outcomes, not two
 *
 * *"'Uphold or overturn' is an underspecified outcome space."* By the time a
 * case arrives, thousands of calls have been judged by an automated pipeline
 * and a window has been aggregated. The human is deciding **causal attribution
 * over an aggregate**, and there are six distinguishable answers, each with a
 * different downstream automation. Collapsing them to a binary throws away
 * exactly the information that makes the system self-correcting.
 *
 * The table below is that argument as data. Every consequence in it is read off
 * `OUTCOME_CONSEQUENCE` rather than restated at a call site, for the same
 * reason `VERDICT_CONSEQUENCE` exists one domain over: a seventh outcome should
 * be classified by adding a row, not by finding every `switch`.
 */

/** What an adjudicator concluded. Six outcomes, and only these six. */
export enum ArbitrationOutcome {
  /** The provider genuinely served below its published rate. */
  UPHELD = 'UPHELD',
  /** Genuine, but the penalty arithmetic was wrong. */
  UPHELD_RECALCULATED = 'UPHELD_RECALCULATED',
  /** Our mapping, classifier or routing changed and caused it. */
  OVERTURNED_PLATFORM_DEFECT = 'OVERTURNED_PLATFORM_DEFECT',
  /** The verification policy is wrong for this class of input. */
  OVERTURNED_POLICY_DEFECT = 'OVERTURNED_POLICY_DEFECT',
  /** One or a few agents manufactured the failures. */
  OVERTURNED_GRIEFING = 'OVERTURNED_GRIEFING',
  /** The sample was too small and this is noise. */
  OVERTURNED_INSUFFICIENT_EVIDENCE = 'OVERTURNED_INSUFFICIENT_EVIDENCE',
}

/**
 * How a case ended.
 *
 * Four of the five are automatic, and none of those four *writes* an
 * `ArbitrationOutcome` — see `chk_slash_proposals_outcome_needs_adjudicator`
 * and the migration header. A decision nobody made must not appear in the
 * taxonomy the false-positive metric reads.
 *
 * `AUTO_CHAIN_VOIDED` is the one that can *land on* a row that already carries
 * an outcome, because it closes a case at any point in its life — including one
 * an adjudicator had already upheld. It never writes an outcome of its own, and
 * the constraint admits exactly the two upholding outcomes beside it.
 */
export enum ResolutionKind {
  /** A human decided, under a rubric, with a reason. */
  ADJUDICATOR = 'ADJUDICATOR',
  /** The provider's window elapsed without an objection. */
  AUTO_UNDISPUTED = 'AUTO_UNDISPUTED',
  /** **Our** window elapsed without a decision. The one symmetric rule (platform miss). */
  AUTO_PLATFORM_MISS = 'AUTO_PLATFORM_MISS',
  /** Below the de-minimis floor; recorded for routing, never levied. */
  AUTO_DE_MINIMIS = 'AUTO_DE_MINIMIS',
  /**
   * The chain refused the judgement permanently — a revoked or expired verifier
   * key, a record somebody else already cancelled or expired, a penalty above
   * the provider's contract.
   *
   * Nobody decided it, so it is automatic and names no adjudicator. It does not
   * count as a false positive either: a revoked key voids a judgement for
   * reasons that say nothing about whether the provider failed.
   */
  AUTO_CHAIN_VOIDED = 'AUTO_CHAIN_VOIDED',
  /**
   * The chain executed the judgement before anybody here decided the
   * objection — `executeSlash` is permissionless (BUG-R13-D-03). Written on
   * the open dispute row only, which closes as an upheld decision would
   * (objection `REJECTED`, outcome `UPHELD`); it names no adjudicator.
   */
  AUTO_CHAIN_EXECUTED = 'AUTO_CHAIN_EXECUTED',
  /**
   * EVM: the arbiter ruled on chain (`upholdSlash`), the one decision for a
   * disputed record. The arbiter is a person-held wallet and not an operator
   * row, so it names no adjudicator and writes no outcome on the case.
   */
  CHAIN_ARBITER = 'CHAIN_ARBITER',
}

/** What follows from an outcome, automatically and without a second decision. */
export interface OutcomeConsequence {
  /** Does the penalty stand? */
  readonly penaltyStands: boolean;
  /** Is the amount recomputed before it executes? */
  readonly recalculated: boolean;
  /** Do the window's strikes survive? */
  readonly strikesStand: boolean;
  /** Does the binding's routing weight survive? */
  readonly routingWeightStands: boolean;
  /**
   * Does this open a fleet sweep — the same conclusion applied to every binding
   * the defect touched, complained or not?
   *
   * True for exactly the two outcomes that are findings about **us**. The other
   * four are findings about one provider, one agent or one window, and do not
   * generalise; `chk_fleet_sweeps_outcome` refuses them at the database too.
   */
  readonly opensFleetSweep: boolean;
  /**
   * Does this count against **our** false-positive rate, rather than
   * against the provider?
   *
   * `OVERTURNED_INSUFFICIENT_EVIDENCE` counts, and this is the non-obvious one:
   * The rule is that it is *"counted against our process-error metric, not
   * against the provider"*. We proposed a penalty on evidence that could not
   * support it, and the provider was not shown to have done anything. That is
   * our error even though nobody's code was wrong.
   *
   * `OVERTURNED_GRIEFING` does **not** count. The measurement was correct, the
   * calls really did fail, and the cause was a third party — counting it as a
   * false positive would make our own metric move whenever someone attacked a
   * provider, which is the one thing it must not do.
   */
  readonly countsAsFalsePositive: boolean;
  /**
   * The binding's sampling is raised to 100% and the window is merged forward
   * rather than judged. Only `OVERTURNED_INSUFFICIENT_EVIDENCE`: the answer to
   * "we could not tell" is to look harder, not to look away.
   */
  readonly raisesSamplingToFull: boolean;
}

export const OUTCOME_CONSEQUENCE: Readonly<Record<ArbitrationOutcome, OutcomeConsequence>> =
  Object.freeze({
    [ArbitrationOutcome.UPHELD]: {
      penaltyStands: true,
      recalculated: false,
      strikesStand: true,
      routingWeightStands: true,
      opensFleetSweep: false,
      countsAsFalsePositive: false,
      raisesSamplingToFull: false,
    },
    [ArbitrationOutcome.UPHELD_RECALCULATED]: {
      penaltyStands: true,
      recalculated: true,
      strikesStand: true,
      routingWeightStands: true,
      opensFleetSweep: false,
      // The finding held; only our arithmetic was wrong. That is a defect
      // against the window builder, logged as one — not a wrongful penalty.
      countsAsFalsePositive: false,
      raisesSamplingToFull: false,
    },
    [ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT]: {
      penaltyStands: false,
      recalculated: false,
      strikesStand: false,
      routingWeightStands: false,
      opensFleetSweep: true,
      countsAsFalsePositive: true,
      raisesSamplingToFull: false,
    },
    [ArbitrationOutcome.OVERTURNED_POLICY_DEFECT]: {
      penaltyStands: false,
      recalculated: false,
      strikesStand: false,
      routingWeightStands: false,
      opensFleetSweep: true,
      countsAsFalsePositive: true,
      raisesSamplingToFull: false,
    },
    [ArbitrationOutcome.OVERTURNED_GRIEFING]: {
      penaltyStands: false,
      recalculated: false,
      strikesStand: false,
      routingWeightStands: false,
      opensFleetSweep: false,
      countsAsFalsePositive: false,
      raisesSamplingToFull: false,
    },
    [ArbitrationOutcome.OVERTURNED_INSUFFICIENT_EVIDENCE]: {
      penaltyStands: false,
      recalculated: false,
      // The strikes stand: the calls really did fail, we simply could not say
      // at what rate. Removing them would erase an observation, not a verdict.
      strikesStand: true,
      routingWeightStands: true,
      opensFleetSweep: false,
      countsAsFalsePositive: true,
      raisesSamplingToFull: true,
    },
  });

/** True for the four outcomes that cancel the penalty. */
export function isOverturn(outcome: ArbitrationOutcome): boolean {
  return !OUTCOME_CONSEQUENCE[outcome].penaltyStands;
}

/**
 * The states `disputes.state` may hold, unchanged from the dispute module.
 *
 * Kept as its own enum rather than imported from the dispute module so this
 * file stays free of module imports; a test asserts the two agree member for
 * member, which is the cheapest way to make a divergence loud.
 */
export enum DisputeResolutionState {
  OPEN = 'OPEN',
  UNDER_REVIEW = 'UNDER_REVIEW',
  UPHELD = 'UPHELD',
  PARTIALLY_UPHELD = 'PARTIALLY_UPHELD',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
}

/**
 * The one place the polarity flip is written down.
 *
 * `disputes.state` describes what happened to the **objection**;
 * `ArbitrationOutcome` describes what happened to the **proposal**. They point
 * in opposite directions, both are the settled usage in their own table, and
 * getting the mapping backwards would tell a provider they won a case they
 * lost.
 *
 * ```text
 *   proposal upheld                  → objection REJECTED
 *   proposal upheld, recalculated    → objection PARTIALLY_UPHELD
 *   proposal overturned (any of 4)   → objection UPHELD
 * ```
 */
export const ARBITRATION_STATE_MAP: Readonly<Record<ArbitrationOutcome, DisputeResolutionState>> =
  Object.freeze({
    [ArbitrationOutcome.UPHELD]: DisputeResolutionState.REJECTED,
    [ArbitrationOutcome.UPHELD_RECALCULATED]: DisputeResolutionState.PARTIALLY_UPHELD,
    [ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT]: DisputeResolutionState.UPHELD,
    [ArbitrationOutcome.OVERTURNED_POLICY_DEFECT]: DisputeResolutionState.UPHELD,
    [ArbitrationOutcome.OVERTURNED_GRIEFING]: DisputeResolutionState.UPHELD,
    [ArbitrationOutcome.OVERTURNED_INSUFFICIENT_EVIDENCE]: DisputeResolutionState.UPHELD,
  });

/**
 * What the provider is claiming, from the dispute form's radio list.
 *
 * The clearest lesson from other dispute systems, and the reason this is an
 * enum rather than a string: *"Structure the input, not just the output."*
 * Every dispute system with tolerable review consistency constrains what the
 * accused party may submit — a reason code, a form, a per-item review request.
 * Two adjudicators reading two essays about the same underlying situation will
 * not extract the same facts.
 *
 * Each member is pre-populated from evidence we already hold, which is the
 * other half of the dispute form's promise: *"we would rather find our own
 * defect than win a dispute about it."*
 */
export enum DisputeClaimType {
  /** "The failures were caused by a platform mapping change." */
  PLATFORM_MAPPING_CHANGE = 'PLATFORM_MAPPING_CHANGE',
  /** "The failures came from one agent's query pattern (griefing)." */
  AGENT_GRIEFING = 'AGENT_GRIEFING',
  /** "The policy misjudges a legitimate response (policy defect)." */
  POLICY_DEFECT = 'POLICY_DEFECT',
  /** "The sample is too small to support this conclusion." */
  INSUFFICIENT_SAMPLE = 'INSUFFICIENT_SAMPLE',
  /** "The failing calls' inputs came from another tool's output." */
  UPSTREAM_INDUCED = 'UPSTREAM_INDUCED',
  /** "We had a declared incident during this window." */
  DECLARED_INCIDENT = 'DECLARED_INCIDENT',
  OTHER = 'OTHER',
}

/**
 * The claim each outcome most directly answers, used to seed the case brief's
 * ordering — not to decide anything.
 *
 * An adjudicator may reach any outcome from any claim; the provider does not
 * get to pick their own verdict by picking a radio button. What this buys is
 * that the evidence panel a reviewer sees first is the one that settles the
 * claim actually made.
 */
export const CLAIM_SUGGESTS_OUTCOME: Readonly<Record<DisputeClaimType, ArbitrationOutcome | null>> =
  Object.freeze({
    [DisputeClaimType.PLATFORM_MAPPING_CHANGE]: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
    [DisputeClaimType.AGENT_GRIEFING]: ArbitrationOutcome.OVERTURNED_GRIEFING,
    [DisputeClaimType.POLICY_DEFECT]: ArbitrationOutcome.OVERTURNED_POLICY_DEFECT,
    [DisputeClaimType.INSUFFICIENT_SAMPLE]: ArbitrationOutcome.OVERTURNED_INSUFFICIENT_EVIDENCE,
    [DisputeClaimType.UPSTREAM_INDUCED]: ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
    [DisputeClaimType.DECLARED_INCIDENT]: null,
    [DisputeClaimType.OTHER]: null,
  });

/**
 * Reason codes, per outcome: *"A closed set of reason codes, not free text."*
 *
 * Deliberately short. This list is meant to grow from weekly
 * calibration on real disagreements, not from an upfront taxonomy — an
 * enumeration invented before the first hundred cases is one nobody uses, and
 * `OTHER` then absorbs everything, which is free text with extra steps. What
 * matters at this stage is that the *shape* is closed and versioned, so
 * additions are visible.
 */
export const REASON_CODES: Readonly<Record<ArbitrationOutcome, readonly string[]>> = Object.freeze({
  [ArbitrationOutcome.UPHELD]: [
    'RATE_GENUINELY_EXCEEDED',
    'UPSTREAM_QUALITY_DEGRADED',
    'PROVIDER_CONFIRMED',
  ],
  [ArbitrationOutcome.UPHELD_RECALCULATED]: [
    'EXCLUDED_CALLS_MISCOUNTED',
    'PRICE_BASIS_WRONG',
    'MULTIPLIER_MISAPPLIED',
  ],
  [ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT]: [
    'MAPPING_REGRESSION',
    'ROUTING_MISDIRECTED',
    'CLASSIFIER_MISLABELLED',
    'EGRESS_OR_TIMEOUT_OURS',
  ],
  [ArbitrationOutcome.OVERTURNED_POLICY_DEFECT]: [
    'RULE_TOO_STRICT_FOR_INPUT_CLASS',
    'SCHEMA_STALE',
    'SEMANTIC_PROMPT_REGRESSION',
  ],
  [ArbitrationOutcome.OVERTURNED_GRIEFING]: [
    'SINGLE_AGENT_CONCENTRATION',
    'ADVERSARIAL_QUERY_PATTERN',
  ],
  [ArbitrationOutcome.OVERTURNED_INSUFFICIENT_EVIDENCE]: [
    'SAMPLE_BELOW_GATE',
    'CONFIDENCE_INTERVAL_STRADDLES_THRESHOLD',
  ],
});

/** The minimum hand-written explanation on a decision, in characters. */
export const DECISION_NOTE_MIN_LENGTH = 120;

/**
 * The rubric a decision made today is recorded against.
 *
 * A constant, because a versioned, authored, approved rubric object does
 * not exist yet and pretending otherwise would put a version number on every
 * decision that points at nothing. What this does buy is that when the rubric
 * table ships, every case already carries the version it was decided under and
 * none has to be back-filled with a guess.
 */
export const CURRENT_RUBRIC_VERSION = 'v1';

/** True when `codes` are all valid for `outcome` and there is at least one. */
export function reasonCodesAreValid(
  outcome: ArbitrationOutcome,
  codes: readonly string[],
): boolean {
  if (codes.length === 0) return false;
  const allowed = new Set(REASON_CODES[outcome]);
  return codes.every((code) => allowed.has(code));
}
