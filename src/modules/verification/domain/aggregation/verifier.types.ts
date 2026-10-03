/**
 * What a verifier hands the aggregator.
 *
 * The pipeline is one shape of verification: four *stages*, ordered
 * cheapest-first, early exit at the first that does not pass. That shape has a
 * property aggregation has to give up — **it cannot count**. A rule like *"2 of
 * 4 verifiers failing is a `FAIL`"* is unsatisfiable under early exit, because
 * the pipeline stops after the first failure and there is never a second one to
 * count.
 *
 * So the aggregator does not consume stages. It consumes **votes**, and a vote
 * is deliberately a smaller thing than a stage result:
 *
 * ```text
 * StageResult   stage (a closed enum of 4) · status (8) · code · detail · score · rules
 * VerifierResult  verifierId (an open string) · outcome (5) · code · detail · score · costUsd
 * ```
 *
 * Two of those differences are the whole point of aggregation:
 *
 * **`verifierId` is a string, not an enum.** A genuinely distributed quorum —
 * *"a second verifier that we do not operate"* — is out of scope for now, and
 * aggregation leaves room for it. A closed enum is
 * exactly the thing that would not leave room: adding a fifth member is a
 * change to a type that settlement, receipts and metrics all read. A string id
 * means a third-party verifier is a row in a policy document, not a deploy.
 *
 * **`outcome` has five members where `StageStatus` has eight.** Four of the
 * eight statuses (`NOT_REACHED`, `NOT_APPLICABLE`, `NOT_IMPLEMENTED`,
 * `SKIPPED`) are different answers to *why* a check produced no opinion, and
 * the receipt must keep all four — see `../stage.ts`. The *vote* must not: a
 * quorum that treated "not applicable" and "timed out" as different kinds of
 * silence would be counting our own operational history into a judgement about
 * a provider. The detail survives on the receipt; the vote is coarse on
 * purpose.
 */

import { StageEvaluation, StageStatus, VerificationStage } from '../stage';
// Type-only, so importing the verdict vocabulary here adds no module edge.
import type { VerdictStatus } from '../verdict';

/**
 * How one verifier voted.
 *
 * Ordered by how much they say about the provider: two are opinions about the
 * response, one is an opinion about the *check*, and two are silence.
 */
export enum VerifierOutcome {
  /** Checked, and satisfied. Counts in the quorum denominator. */
  PASS = 'PASS',

  /**
   * Checked, and the response did not satisfy it.
   *
   * The only outcome a quorum can count toward a `FAIL`, and therefore the only
   * one that can ever reach a provider's stake.
   */
  FAIL = 'FAIL',

  /**
   * Checked, and the check did not fit what it was pointed at.
   *
   * **Not a vote about the provider**, so it is excluded from the quorum
   * denominator entirely rather than counted as a pass. A misapplied check has
   * no opinion on whether the response was good; averaging it in either
   * direction invents one.
   */
  MISAPPLIED = 'MISAPPLIED',

  /**
   * Should have voted and could not — a timeout, a transport failure, an
   * unimplemented verifier, a killed policy.
   *
   * Our problem, never the provider's. Counted only by the participation
   * clause, which is how a policy says "too few verifiers spoke to trust the
   * result".
   */
  UNAVAILABLE = 'UNAVAILABLE',

  /**
   * Had no opinion by design — inapplicable to this tool, or not sampled for
   * this call.
   *
   * Distinct from `UNAVAILABLE` because nothing is wrong. An abstention is not
   * an outage and must not raise a `DEGRADED` rate that pages somebody.
   */
  ABSTAIN = 'ABSTAIN',
}

/**
 * Did this verifier express an opinion about the response?
 *
 * The quorum denominator, in one function. Call it rather than testing
 * `!== ABSTAIN`, which silently counts `UNAVAILABLE` — and a verifier that
 * timed out is not a verifier that passed the response.
 */
export function isVote(outcome: VerifierOutcome): boolean {
  return outcome === VerifierOutcome.PASS || outcome === VerifierOutcome.FAIL;
}

/** One verifier's contribution to one call's judgement. */
export interface VerifierResult {
  /**
   * Stable, and it appears verbatim in the decision policy document.
   *
   * `schema`, `rules`, `cross_check`, `semantic` for the four built in;
   * anything for a verifier we do not operate. It is what a clause names when
   * it grants one verifier a veto, so renaming one silently disarms every
   * clause that mentions it — {@link validateDecisionPolicy} is what catches
   * that, at registration rather than at settlement.
   */
  readonly verifierId: string;
  readonly outcome: VerifierOutcome;
  /** Stable machine-readable reason. `null` on a pass. Metrics group by it. */
  readonly code: string | null;
  /** One human sentence, for the receipt. */
  readonly detail: string | null;
  /** `0..1`, or `null` where the verifier does not score. */
  readonly score: number | null;
  /** What obtaining this vote cost. Zero for the cheap deterministic layers. */
  readonly costUsd: number;
  /**
   * The pipeline stage this vote came from, where it came from one.
   *
   * `null` for a verifier that is not one of the four built-in stages — which
   * is the case the open `verifierId` exists for. Carried so the receipt can
   * keep printing four stage rows without the aggregator having to reconstruct
   * the mapping.
   */
  readonly stage: VerificationStage | null;
  /**
   * A **passing** verdict this verifier settles on its own.
   *
   * Exists for one fact the vote vocabulary cannot carry: the deterministic
   * stage that passes an *empty result set* is `PASS` as a vote and
   * `EMPTY_CONFIRMED` or `EMPTY_UNVERIFIED` as a verdict, and those two
   * statuses are the whole of the verdict vocabulary's coverage signal.
   * Aggregating them down to a plain `PASS` would pay the provider correctly
   * and throw away the reason — the metric that says how often we pay for an
   * unconfirmed empty answer.
   *
   * **May never be a striking status.** Only a clause can make a policy strike,
   * because only a clause is versioned, promoted and killable; a verifier that
   * could settle a `FAIL` by itself would be a verifier with a veto nobody
   * granted it. `aggregate` drops a striking `decides` rather than honouring it.
   */
  readonly decides?: VerdictStatus | null;
}

/** The four built-in verifiers, as ids. */
export const BUILT_IN_VERIFIER_ID: Readonly<Record<VerificationStage, string>> = Object.freeze({
  [VerificationStage.SCHEMA]: 'schema',
  [VerificationStage.DETERMINISTIC_RULES]: 'rules',
  [VerificationStage.CROSS_CHECK]: 'cross_check',
  [VerificationStage.SEMANTIC]: 'semantic',
});

/**
 * `StageStatus` (8) → `VerifierOutcome` (5).
 *
 * The lossy direction, and the losses are chosen rather than incidental:
 *
 * - `NOT_REACHED` cannot appear at all under quorum aggregation, because every
 *   verifier runs. It maps to `UNAVAILABLE` so that a caller who *did* early
 *   exit and then asked for a quorum gets a participation failure — a loud,
 *   correct complaint — instead of a quietly-shrunk denominator that would let
 *   one failing verifier out of four satisfy a "2 of 4" rule.
 * - `NOT_IMPLEMENTED` is `UNAVAILABLE`: the policy asked for a check we have
 *   not built, which is our gap and should show up in the availability metric.
 * - `NOT_APPLICABLE` and `SKIPPED` are `ABSTAIN`: nothing is wrong in either.
 */
export const STAGE_STATUS_VOTE: Readonly<Record<StageStatus, VerifierOutcome>> = Object.freeze({
  [StageStatus.PASSED]: VerifierOutcome.PASS,
  [StageStatus.FAILED]: VerifierOutcome.FAIL,
  [StageStatus.MISAPPLIED]: VerifierOutcome.MISAPPLIED,
  [StageStatus.NOT_REACHED]: VerifierOutcome.UNAVAILABLE,
  [StageStatus.NOT_IMPLEMENTED]: VerifierOutcome.UNAVAILABLE,
  [StageStatus.UNAVAILABLE]: VerifierOutcome.UNAVAILABLE,
  [StageStatus.NOT_APPLICABLE]: VerifierOutcome.ABSTAIN,
  [StageStatus.SKIPPED]: VerifierOutcome.ABSTAIN,
});

/** One pipeline stage's evaluation, as a vote. */
export function voteFromStage(evaluation: StageEvaluation, costUsd = 0): VerifierResult {
  const { result } = evaluation;

  return {
    verifierId: BUILT_IN_VERIFIER_ID[result.stage],
    outcome: STAGE_STATUS_VOTE[result.status],
    code: result.code,
    detail: result.detail,
    score: result.score,
    costUsd,
    stage: result.stage,
    decides: evaluation.decidedVerdict,
  };
}
