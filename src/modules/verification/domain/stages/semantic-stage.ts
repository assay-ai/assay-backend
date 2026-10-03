/**
 * The semantic stage (stage 4).
 *
 * Pure, like every other stage — the model call happens *outside* the engine
 * and arrives here as a {@link SemanticJudgement} value. That is not a purity
 * fetish: dispute arbitration re-evaluates a disputed call from its stored
 * receipt months later, and a stage that called a model would re-evaluate
 * against whatever the model has become since. Replaying the recorded judgement
 * is the only reading of "re-evaluates to the same verdict" that is true.
 *
 * ```text
 * policy.semantic absent      → NOT_APPLICABLE    nothing to judge here
 * no judgement supplied       → NOT_IMPLEMENTED   nobody looked
 * judgement NOT_SAMPLED       → SKIPPED           → verdict SKIPPED    pays
 * judgement UNAVAILABLE       → UNAVAILABLE       → verdict DEGRADED   pays
 * judgement JUDGED, below bar → FAILED            → verdict FAIL       strikes
 *          …and out of scope  → MISAPPLIED        → verdict MISAPPLIED voids
 * judgement JUDGED, above bar → PASSED            → continue
 * ```
 *
 * Three of those six credit the provider. That is the point: a verdict requires
 * positive evidence of failure before anyone loses money, and "we did not
 * look", "we could not look" and "we asked the wrong question" are none of them
 * evidence about the provider.
 */

import { VerificationErrors } from '../../errors/verification.errors';
import { VerificationPolicy } from '../policy.types';
import { sealSemanticContext } from '../semantic-context';
import {
  DEFAULT_MIN_RELEVANCE,
  SemanticJudgement,
  SemanticOutcome,
  SemanticPolicy,
  SemanticScores,
} from '../semantic.types';
import { describeSampleRate } from '../sampling';
import { StageEvaluation, StageStatus, VerificationStage } from '../stage';
import { VerdictStatus } from '../verdict';

export function runSemanticStage(
  policy: VerificationPolicy,
  judgement: SemanticJudgement | undefined,
): StageEvaluation {
  const semantic = policy.semantic;

  if (semantic?.enabled !== true) {
    return evaluation(
      StageStatus.NOT_APPLICABLE,
      'stage_not_declared',
      'This check does not apply to this tool.',
      null,
      null,
    );
  }

  if (!judgement) {
    // The policy asked for a relevance judgement and the caller ran the engine
    // without one. Honest reading: nobody looked. Not a pass, not a failure,
    // and countable — a rising `NOT_IMPLEMENTED` rate on a declared stage means
    // the worker that should be judging is not.
    return evaluation(
      StageStatus.NOT_IMPLEMENTED,
      'stage_not_run',
      'This check was not run for this call.',
      null,
      null,
    );
  }

  switch (judgement.outcome) {
    case SemanticOutcome.NOT_SAMPLED:
      return evaluation(
        StageStatus.SKIPPED,
        'not_sampled',
        // The published rate, verbatim — the receipt must carry it, and
        // silence here would read as a check that passed.
        describeSampleRate(judgement.sampling.rate),
        null,
        VerdictStatus.SKIPPED,
      );

    case SemanticOutcome.UNAVAILABLE:
      return evaluation(
        StageStatus.UNAVAILABLE,
        judgement.unavailableReason ?? 'semantic_unavailable',
        'This check was unavailable, so the deterministic result stands.',
        null,
        VerdictStatus.DEGRADED,
      );

    case SemanticOutcome.JUDGED:
      return judge(semantic, judgement);
  }
}

function judge(policy: SemanticPolicy, judgement: SemanticJudgement): StageEvaluation {
  // The gate, and the only place it can be enforced without a repository:
  // a judgement that cannot be re-derived does not become part of a verdict at
  // all. Throws — the caller's job is to degrade, not to record it anyway.
  sealSemanticContext(judgement.context ?? {});

  const scores = judgement.scores;
  if (!scores) {
    throw seal('scores', 'a JUDGED judgement carries no scores');
  }

  const failure = firstFailedAxis(policy, scores);
  const score = meanScore(scores);

  if (!failure) {
    return evaluation(StageStatus.PASSED, null, null, score, null);
  }

  // The response fell short *and* the model says the request was never
  // this tool's to answer — that is our routing or our tool description, and a
  // provider who answered the question they were given is not at fault for the
  // question. `MISAPPLIED` voids: nobody is charged, nobody is struck.
  if (!scores.requestInScope) {
    return evaluation(
      StageStatus.MISAPPLIED,
      'request_out_of_scope',
      scores.reason ?? 'The request was outside what this tool is meant to answer.',
      score,
      VerdictStatus.MISAPPLIED,
    );
  }

  return evaluation(
    StageStatus.FAILED,
    failure.code,
    scores.reason ?? failure.detail,
    score,
    VerdictStatus.FAIL,
  );
}

interface AxisFailure {
  readonly code: string;
  readonly detail: string;
}

/**
 * The first axis below its threshold, in relevance → completeness → coherence
 * order.
 *
 * Only `relevance` has a default. A policy that never set a completeness or
 * coherence bar gets no opinion from one — a threshold nobody chose is a
 * threshold nobody can defend when a provider disputes the strike it produced.
 */
function firstFailedAxis(policy: SemanticPolicy, scores: SemanticScores): AxisFailure | null {
  const minRelevance = policy.minRelevance ?? DEFAULT_MIN_RELEVANCE;

  if (scores.relevance < minRelevance) {
    return {
      code: 'irrelevant_response',
      detail: `Relevance ${scores.relevance.toFixed(2)} is below the required ${minRelevance.toFixed(2)}.`,
    };
  }
  if (policy.minCompleteness !== undefined && scores.completeness < policy.minCompleteness) {
    return {
      code: 'incomplete_response',
      detail: `Completeness ${scores.completeness.toFixed(2)} is below the required ${policy.minCompleteness.toFixed(2)}.`,
    };
  }
  if (policy.minCoherence !== undefined && scores.coherence < policy.minCoherence) {
    return {
      code: 'incoherent_response',
      detail: `Coherence ${scores.coherence.toFixed(2)} is below the required ${policy.minCoherence.toFixed(2)}.`,
    };
  }

  return null;
}

/**
 * The stage's score is the mean of the three axes.
 *
 * A mean is defensible *here* and not across stages (see `engine.ts`,
 * `lastScore`) because these three are commensurable by construction: one model
 * scored one response on three axes of the same 0–1 scale in a single call.
 */
function meanScore(scores: SemanticScores): number {
  const mean = (scores.relevance + scores.completeness + scores.coherence) / 3;
  return Math.round(mean * 10000) / 10000;
}

function evaluation(
  status: StageStatus,
  code: string | null,
  detail: string | null,
  score: number | null,
  decidedVerdict: VerdictStatus | null,
): StageEvaluation {
  return {
    result: { stage: VerificationStage.SEMANTIC, status, code, detail, score },
    decidedVerdict,
  };
}

/**
 * Routed through the same error as the context gate: from a caller's point of
 * view "the judgement is missing its scores" and "the judgement is missing its
 * model" are one condition — this judgement cannot be recorded.
 */
function seal(field: string, reason: string) {
  return VerificationErrors.semanticContextIncomplete({ field, reason });
}
