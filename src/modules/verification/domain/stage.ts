/**
 * Pipeline stages and their results, and the receipt half of them.
 *
 * The pipeline is ordered cheapest-first and **stops at the first stage that
 * fails**. That is a cost decision — a response with an invalid schema is never
 * sent to a model, because the answer is already known and the model call would
 * be pure spend — but it has a consequence that is not about cost at all:
 *
 * > **After a failure, the later stages have no result. Not a good result. No
 * > result.**
 *
 * The receipt must then say: *not reached — checks stop at the
 * first failure*. Never *passed*, and never omitted, which reads as passed to
 * anyone scanning a list of ticks. This is a statement about money: a reader who
 * believes the relevance judgement passed believes we charged them for a
 * response we vouched for, and we did not.
 *
 * So the vocabulary below has five ways to say "did not pass" and exactly one
 * way to say "passed", {@link StageStatus.PASSED}, which is only ever written by
 * a stage that ran to completion and was satisfied.
 */

import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { RuleResult } from './rules/rule.types';
// Type-only — see the matching note in `./verdict.ts`.
import type { VerdictStatus } from './verdict';

/**
 * The four stages of the verification pipeline.
 *
 * All four are enumerated even though not every stage is implemented. A
 * pipeline that only names the stages it can run produces a receipt that grows
 * new rows as stages land, which makes two receipts from different weeks
 * incomparable — and a verdict that never reached a stage genuinely does have
 * something to say about it: that it did not happen.
 */
export enum VerificationStage {
  /** ~0.1ms. Does the response have the shape the tool contract promises? */
  SCHEMA = 'SCHEMA',
  /** ~1ms. Counts, required fields, freshness, ranges, URLs, duplicates. */
  DETERMINISTIC_RULES = 'DETERMINISTIC_RULES',
  /** ~50ms. Compare against a second provider or an independent source. */
  CROSS_CHECK = 'CROSS_CHECK',
  /** ~800ms, sampled. Relevance and usefulness, judged by a model. */
  SEMANTIC = 'SEMANTIC',
}

/** Pipeline order. The engine emits exactly one result per entry, in this order. */
export const VERIFICATION_PIPELINE: readonly VerificationStage[] = Object.freeze([
  VerificationStage.SCHEMA,
  VerificationStage.DETERMINISTIC_RULES,
  VerificationStage.CROSS_CHECK,
  VerificationStage.SEMANTIC,
]);

/**
 * The stages that run on **every** call, unsampled.
 *
 * The every-call requirement in one constant. A sampler that ever tried to skip
 * one of these would be skipping the layers that catch the most failures for
 * the least money, which is the whole argument for the ordering.
 */
export const UNSAMPLED_STAGES: readonly VerificationStage[] = Object.freeze([
  VerificationStage.SCHEMA,
  VerificationStage.DETERMINISTIC_RULES,
]);

export enum StageStatus {
  /**
   * The stage ran, completed, and was satisfied.
   *
   * The only value that may ever be rendered as a tick. See
   * {@link isStagePass}, and do not compare against this member by hand.
   */
  PASSED = 'PASSED',

  /** The stage ran and the response did not satisfy it. Stops the pipeline. */
  FAILED = 'FAILED',

  /**
   * The pipeline stopped before this stage. **Nothing is known about it.**
   *
   * The status this whole file exists for.
   */
  NOT_REACHED = 'NOT_REACHED',

  /**
   * Reached, and the policy declares this stage meaningless for this tool.
   *
   * Distinct from `NOT_REACHED` because the reasons a reader would act on are
   * opposite: `NOT_REACHED` means "run it and you would learn something",
   * `NOT_APPLICABLE` means "there is nothing here to learn". A policy with no
   * `crossCheck` block and a policy where cross-check is *meaningless* look
   * identical unless inapplicability is stated.
   */
  NOT_APPLICABLE = 'NOT_APPLICABLE',

  /**
   * Reached, configured by the policy, and no implementation exists yet.
   *
   * The honest thing to write for a stage, such as `CROSS_CHECK`, that is not
   * built yet. Marking it `PASSED` would claim a judgement nobody made;
   * marking it `NOT_APPLICABLE` would claim the policy author was wrong to
   * ask. This says what actually happened, and it disappears as those
   * stages land.
   */
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',

  /**
   * The stage ran and could not judge this response, because what it was
   * pointed at is not what it knows how to judge.
   *
   * Never the provider's fault. Produces a `MISAPPLIED` verdict.
   */
  MISAPPLIED = 'MISAPPLIED',

  /**
   * Reached, and the sampling draw did not select this call.
   *
   * Only the semantic stage can be `SKIPPED` — `UNSAMPLED_STAGES` runs on every
   * call by construction. Distinct from `NOT_REACHED` because the pipeline
   * *did* get here and the omission is deliberate and priced: the receipt says
   * "not checked — 1 in 125 calls at this price", which is a different
   * statement from "we stopped before this".
   */
  SKIPPED = 'SKIPPED',

  /**
   * Reached, selected, and the check could not be completed — a timeout, a
   * transport failure, or a judgement refused as unreproducible.
   *
   * Our failure, never the provider's, and it credits them. Distinct from
   * `NOT_IMPLEMENTED` because that one says the check does not exist yet, while
   * this one says it exists and was unavailable *for this call* — a rate worth
   * alerting on rather than a permanent state of the world.
   */
  UNAVAILABLE = 'UNAVAILABLE',
}

/**
 * Exactly one status is a pass.
 *
 * Every renderer, aggregator and metric must go through this rather than
 * testing `!== FAILED`, which quietly promotes all four of the did-not-run
 * statuses into passes — the precise bug a receipt must never have.
 */
export function isStagePass(status: StageStatus): boolean {
  return status === StageStatus.PASSED;
}

/** Did this stage actually execute and reach a judgement? */
export function stageRan(status: StageStatus): boolean {
  return (
    status === StageStatus.PASSED ||
    status === StageStatus.FAILED ||
    status === StageStatus.MISAPPLIED
  );
}

/**
 * The sentence a receipt prints in the status column.
 *
 * Kept beside the enum so the wording cannot drift per surface. The receipt,
 * the console and any support tool print the same words for
 * the same fact, and a change to the words is a change to this file.
 */
export const STAGE_STATUS_LABEL: Readonly<Record<StageStatus, string>> = Object.freeze({
  [StageStatus.PASSED]: 'passed',
  [StageStatus.FAILED]: 'failed',
  [StageStatus.NOT_REACHED]: 'not reached',
  [StageStatus.NOT_APPLICABLE]: 'not applicable',
  [StageStatus.NOT_IMPLEMENTED]: 'not run',
  [StageStatus.MISAPPLIED]: 'check did not fit',
  [StageStatus.SKIPPED]: 'not sampled',
  [StageStatus.UNAVAILABLE]: 'could not run',
});

/** The explanatory half of the receipt row, where there is one. */
export const STAGE_STATUS_NOTE: Readonly<Record<StageStatus, string | null>> = Object.freeze({
  [StageStatus.PASSED]: 'runs on every call',
  [StageStatus.FAILED]: 'runs on every call',
  [StageStatus.NOT_REACHED]: 'checks stop at the first failure',
  [StageStatus.NOT_APPLICABLE]: 'this check does not apply to this tool',
  [StageStatus.NOT_IMPLEMENTED]: 'this check is not available yet',
  [StageStatus.MISAPPLIED]: 'our check was pointed at the wrong thing — you were not charged',
  // The rate itself is per-call, so the row's `detail` carries the "1 in 125"
  // sentence. This is the part that is true of every unsampled call.
  [StageStatus.SKIPPED]: 'this check is sampled — the sample rate is set by the price',
  [StageStatus.UNAVAILABLE]: 'this check was unavailable — the provider was still credited',
});

export interface StageResult {
  readonly stage: VerificationStage;
  readonly status: StageStatus;
  /**
   * Stable machine-readable reason, e.g. `insufficient_results`. `null` on a
   * pass. Metrics group by this, so it never contains an id or a value.
   */
  readonly code: string | null;
  /** One human sentence with the specifics: "0 results returned, the minimum is 1". */
  readonly detail: string | null;
  /**
   * This stage's score, `0..1`, or `null` when the stage produced no score —
   * which includes every status except `PASSED` and `FAILED`.
   *
   * `null` rather than `0`, for the same reason `NOT_REACHED` is not `PASSED`:
   * a stage that did not run did not score zero.
   */
  readonly score: number | null;
  /** Per-rule breakdown. Only the deterministic stage sets it. */
  readonly rules?: readonly RuleResult[];
}

/**
 * A stage that never ran because an earlier one failed.
 *
 * A named constructor rather than an object literal at each call site: the
 * "later stages are `NOT_REACHED`, with no score" rule is then written once,
 * and the engine's fill-in loop cannot express any other shape.
 */
export function notReached(stage: VerificationStage): StageResult {
  return {
    stage,
    status: StageStatus.NOT_REACHED,
    code: null,
    detail: STAGE_STATUS_NOTE[StageStatus.NOT_REACHED],
    score: null,
  };
}

/**
 * What one stage hands back to the engine.
 *
 * A stage returns *both* its receipt row and, when it has one, the verdict it
 * determines — rather than the engine inferring a verdict from a status. The
 * inference would be lossy in the one place it matters: a deterministic stage
 * that passed with an empty result set is `PASSED` **and** decides
 * `EMPTY_CONFIRMED`, and no status could carry both facts.
 */
export interface StageEvaluation {
  readonly result: StageResult;
  /**
   * The verdict this stage settles, or `null` to continue down the pipeline.
   *
   * Non-null stops the pipeline and every later stage is recorded
   * {@link StageStatus.NOT_REACHED} — including when the decided verdict is a
   * passing one. An empty result set has nothing for a model to judge, so
   * running the semantic stage over it would be spend with a known answer.
   */
  readonly decidedVerdict: VerdictStatus | null;
}

/** What the stages read. Pure values — no clock, no socket, no repository. */
export interface StageInput {
  /** The response document **after** the binding's response mapping. */
  readonly response: JsonValue;
  /** The tool arguments the agent sent, for rules gated on the request. */
  readonly request?: JsonValue;
  /**
   * The instant verification ran, injected rather than read.
   *
   * Freshness rules need "now", and a disputed call has to re-evaluate to the
   * same verdict months later. A stage that called `Date.now()` could
   * not promise that.
   */
  readonly evaluatedAt: Date;
}
