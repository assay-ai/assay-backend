/**
 * The verification pipeline.
 *
 * ```text
 * mapped DATA_RESULT
 *        │
 *        ▼
 *   1. SCHEMA               ~0.1ms   every call, unsampled
 *        │ pass
 *        ▼
 *   2. DETERMINISTIC_RULES  ~1ms     every call, unsampled
 *        │ pass
 *        ▼
 *   3. CROSS_CHECK          ~50ms    not built yet
 *        │ pass
 *        ▼
 *   4. SEMANTIC             ~800ms   sampled
 *        │
 *        ▼
 *      verdict
 * ```
 *
 * Three properties, and each one is a requirement rather than a design taste:
 *
 * **The first two stages run on every call.** There is no sampler here and no
 * seam to add one. They run on **every** call — the cheap layers catch the most
 * failures for the least money, so sampling them would trade away the bulk of
 * the engine's value to save nothing. Sampling starts at stage 4, where a call
 * actually costs something.
 *
 * **Checking stops at the first stage that does not pass, and the stages after
 * it are recorded `NOT_REACHED`.** Never omitted, never `PASSED`. The receipt
 * requires it, and the reason is not cosmetic: a reader who believes the
 * relevance judgement passed believes we vouched for a response we never looked
 * at. That is a misunderstanding about money.
 *
 * **Every ambiguity resolves away from `FAIL`.** A `FAIL` is the only verdict
 * that strikes a provider and the only road to a slash, so it is reserved for
 * the case where the response provably broke the contract *and* the provider is
 * who broke it. Our own mapping gap, our own policy bug, our own crash and a
 * legitimately empty answer each get a verdict of their own — see
 * `./verdict.ts`.
 *
 * Pure. No clock, no repository, no HTTP: `evaluatedAt` is a parameter and the
 * policy is a value. A call disputed months later has to re-evaluate to the
 * same verdict from its stored receipt, which an engine that read `Date.now()`
 * or a live policy row could not promise.
 *
 * The caller is responsible for only reaching here on a `DATA_RESULT` —
 * `SYSTEM_ERROR` and `REQUEST_ERROR` never touch stake, and verifying them
 * would be the one way to make them do so.
 */

import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';
import { PolicyMode, VerificationPolicy } from './policy.types';
import {
  StageInput,
  StageResult,
  StageStatus,
  VERIFICATION_PIPELINE,
  VerificationStage,
  notReached,
} from './stage';
import { SemanticJudgement } from './semantic.types';
import { runDeterministicStage } from './stages/deterministic-stage';
import { runSchemaStage } from './stages/schema-stage';
import { runSemanticStage } from './stages/semantic-stage';
import { Verdict, VerdictStatus } from './verdict';

export interface VerificationInput {
  readonly intentId: string;
  readonly policy: VerificationPolicy;
  /**
   * The tool's `outputSchema`, used when the policy declares no schema of its
   * own — which should be the usual case. See `VerificationPolicy.schema` for
   * why a policy carrying its own copy is a liability.
   */
  readonly outputSchema?: JsonSchema;
  /** The response **after** the binding's response mapping. */
  readonly response: JsonValue;
  /** The tool arguments the agent sent. Read only by rules gated on the request. */
  readonly request?: JsonValue;
  /**
   * The semantic judgement for this call, obtained before `verify` was called.
   *
   * A value rather than a callback, because the model call is the one part of
   * verification that is neither pure nor reproducible on demand: it costs
   * money, it can time out, and the model behind it changes. The caller —
   * `SemanticVerificationService`, driven by the verification worker — decides
   * sampling, calls the model and hands the result here; the engine only
   * *judges* it. A dispute months later replays the stored judgement through
   * this same argument and reaches the same verdict.
   *
   * Absent means nobody judged: the stage records `NOT_IMPLEMENTED` if the
   * policy asked for it, `NOT_APPLICABLE` if it did not.
   */
  readonly semantic?: SemanticJudgement;
  readonly evaluatedAt: Date;
}

/**
 * The two cheap stages cost nothing to run. Stated as a constant rather than a
 * literal `0` so the receipt's cost line has a single origin — the semantic
 * stage's cost is added to it, and only when that stage was actually reached.
 */
const CHEAP_STAGE_COST_USD = 0;

export function verify(input: VerificationInput): Verdict {
  const { policy } = input;
  const stageInput: StageInput = {
    response: input.response,
    request: input.request,
    evaluatedAt: input.evaluatedAt,
  };

  const stages: StageResult[] = [];
  let decided: VerdictStatus | null = null;
  let deciding: StageResult | null = null;

  for (const stage of VERIFICATION_PIPELINE) {
    if (decided !== null) {
      stages.push(notReached(stage));
      continue;
    }

    const evaluation = runStage(stage, policy, stageInput, input);
    stages.push(evaluation.result);
    if (evaluation.decidedVerdict !== null) {
      decided = evaluation.decidedVerdict;
      // The stage that settled it, not the first stage that was not a pass.
      // Those differ whenever an earlier stage was inapplicable — a tool with
      // no declared schema, say — and taking the first non-pass would print
      // "no schema declared" on a receipt whose call actually failed a rule.
      deciding = evaluation.result;
    }
  }

  const status = decided ?? VerdictStatus.PASS;

  // Everything the semantic stage contributes to the verdict is conditional on
  // that stage having *used* the judgement. One handed to a call that failed at
  // stage 1 has no bearing on it: charging its cost would bill for a model we
  // never called, and setting `sampled` would claim the provider was judged on
  // a layer the pipeline stopped before.
  const semantic = semanticJudgementIfUsed(stages, input.semantic);

  return {
    intentId: input.intentId,
    policyId: policy.id,
    policyVersion: policy.version,
    status,
    score: lastScore(stages),
    stages,
    reasonCode: status === VerdictStatus.PASS ? null : (deciding?.code ?? null),
    reason: status === VerdictStatus.PASS ? null : (deciding?.detail ?? null),
    sampled: semantic?.sampling.sampled ?? false,
    sampleRate: semantic?.sampling.rate ?? null,
    semanticContext: semantic?.context ?? null,
    shadow: policy.mode === PolicyMode.SHADOW,
    costUsd: CHEAP_STAGE_COST_USD + (semantic?.costUsd ?? 0),
    evaluatedAt: input.evaluatedAt,
  };
}

/**
 * The judgement, or `null` when the semantic stage did not consume it.
 *
 * Three statuses mean it did not: `NOT_REACHED` (the pipeline stopped earlier),
 * `NOT_APPLICABLE` (the policy never asked for a relevance judgement) and
 * `NOT_IMPLEMENTED` (it asked and nothing ran). A judgement supplied under any
 * of them is a caller mistake, and the verdict must not inherit its cost, its
 * sampling flag or its model pin — all three would describe a judgement that
 * had no bearing on this verdict.
 */
function semanticJudgementIfUsed(
  stages: readonly StageResult[],
  judgement: SemanticJudgement | undefined,
): SemanticJudgement | null {
  if (!judgement) return null;

  const row = stages.find((stage) => stage.stage === VerificationStage.SEMANTIC);
  if (!row) return null;

  const unused =
    row.status === StageStatus.NOT_REACHED ||
    row.status === StageStatus.NOT_APPLICABLE ||
    row.status === StageStatus.NOT_IMPLEMENTED;

  return unused ? null : judgement;
}

function runStage(
  stage: VerificationStage,
  policy: VerificationPolicy,
  stageInput: StageInput,
  input: VerificationInput,
) {
  switch (stage) {
    case VerificationStage.SCHEMA:
      return runSchemaStage(policy, stageInput, policy.schema ?? input.outputSchema);
    case VerificationStage.DETERMINISTIC_RULES:
      return runDeterministicStage(policy, stageInput);
    case VerificationStage.CROSS_CHECK:
      return unbuiltStage(stage, policy.crossCheck?.enabled === true);
    case VerificationStage.SEMANTIC:
      return runSemanticStage(policy, input.semantic);
  }
}

/**
 * A stage that was reached and has no implementation behind it yet.
 *
 * The distinction it draws is the one every policy is asked to make: a stage
 * the policy never declared is `NOT_APPLICABLE` — there is nothing here worth
 * checking for this tool — while a stage the policy *did* declare is
 * `NOT_IMPLEMENTED`: worth checking, and we have not built it. Collapsing the
 * two would hide a real gap behind a status that reads as settled, and
 * `NOT_IMPLEMENTED` is what makes the gap countable on the day someone asks how
 * many calls were judged on the cheap layers alone.
 *
 * Neither one is a pass, and neither one scores.
 */
function unbuiltStage(stage: VerificationStage, declared: boolean) {
  return {
    result: {
      stage,
      status: declared ? StageStatus.NOT_IMPLEMENTED : StageStatus.NOT_APPLICABLE,
      code: declared ? 'stage_not_implemented' : 'stage_not_declared',
      detail: declared
        ? 'This check is not available yet.'
        : 'This check does not apply to this tool.',
      score: null,
    },
    decidedVerdict: null,
  };
}

/**
 * The verdict's headline score is the last score any stage produced.
 *
 * With early exit that is the deciding stage's score whenever a stage failed —
 * matching the receipt, which prints `score 0.31 · pass threshold 0.70` against
 * a failed rules stage — and the last cheap-layer score when everything passed.
 * Averaging across stages would be worse than useless: the stages are not
 * commensurable, and the mean of a 1.0 schema pass and a 0.31 rules failure is
 * a number that describes nothing that happened.
 *
 * `null` when no stage scored at all, which is the honest answer for a verdict
 * decided by a misapplied policy. A `0` there would read as "scored, and scored
 * badly".
 */
function lastScore(stages: readonly StageResult[]): number | null {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const { score } = stages[index];
    if (score !== null) return score;
  }
  return null;
}
