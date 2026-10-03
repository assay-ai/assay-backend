/**
 * The four built-in verifiers, run **without** early exit.
 *
 * `../engine.ts` runs the same four stages cheapest-first and stops at the
 * first that does not pass. That is right for a pipeline and fatal for a
 * quorum: a policy that says *"2 of 4 failing is a FAIL"* can never see a
 * second failure if the pipeline stopped at the first. So aggregation needs
 * every verifier's opinion, and this is where it gets them.
 *
 * **This does not cost more.** The expensive stage is the semantic one, and it
 * does not make a model call — the model call deliberately lives outside
 * the pure engine, so `runSemanticStage` consumes a `SemanticJudgement` the
 * caller already obtained (or did not). Sampling, budget and the daily cost cap
 * all still live where they lived. What the pipeline's early exit saves is a
 * few microseconds of JSON walking, and a quorum is worth that.
 *
 * What *is* given up is the pipeline's `NOT_REACHED` receipt row, which said
 * "we stopped before this and know nothing about it". Under aggregation every
 * stage ran, so the honest row is whatever that stage actually found —
 * including, for a response that failed the schema, a rules stage that also
 * failed on the same malformed body. The receipt renderer must therefore
 * be told which mode produced the verdict; `AggregatedVerdict.decidedBy` is
 * that signal, and it is `null` for a pipeline verdict.
 */

import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';

import { VerificationPolicy } from '../policy.types';
import { SemanticJudgement } from '../semantic.types';
import {
  StageEvaluation,
  StageInput,
  StageStatus,
  VERIFICATION_PIPELINE,
  VerificationStage,
} from '../stage';
import { runDeterministicStage } from '../stages/deterministic-stage';
import { runSchemaStage } from '../stages/schema-stage';
import { runSemanticStage } from '../stages/semantic-stage';
import { VerifierResult, voteFromStage } from './verifier.types';

export interface RunVerifiersInput {
  readonly policy: VerificationPolicy;
  readonly stageInput: StageInput;
  /** The tool's `outputSchema`, used when the policy declares none of its own. */
  readonly outputSchema?: JsonSchema;
  readonly semantic?: SemanticJudgement;
  /** What the semantic judgement cost, where one was made. */
  readonly semanticCostUsd?: number;
}

/**
 * All four stages, evaluated, in pipeline order.
 *
 * The receipt's source, and the reason it is separate from
 * {@link runBuiltInVerifiers}: a `VerifierResult` carries `VerifierOutcome`,
 * which has five members where `StageStatus` has eight. That narrowing is
 * correct for a quorum — see `./verifier.types.ts`, the vote is coarse on
 * purpose — and it is exactly wrong for a receipt. `SKIPPED` and
 * `NOT_IMPLEMENTED` both vote `ABSTAIN`/`UNAVAILABLE`, but one means *"this
 * check is sampled and this call was not drawn"* and the other means *"we have
 * not built this check"*. A receipt that printed the same words for both would
 * be telling an agent we sampled them when we did not.
 *
 * So the stage evaluations are produced once and consumed twice: narrowed to
 * votes for the aggregator, kept whole for the receipt. Running them twice
 * would be two judgements of one call, which can disagree.
 */
export function runBuiltInStages(input: RunVerifiersInput): readonly StageEvaluation[] {
  const { policy } = input;

  return [
    runSchemaStage(policy, input.stageInput, policy.schema ?? input.outputSchema),
    runDeterministicStage(policy, input.stageInput),
    crossCheckStage(policy),
    runSemanticStage(policy, input.semantic),
  ];
}

/**
 * Which stage carries the semantic cost, by index into {@link runBuiltInStages}.
 *
 * Named rather than written as `3` at the two call sites: the pipeline order is
 * a published constant (`VERIFICATION_PIPELINE`) and an index that drifts from
 * it would attribute a model call's cost to the schema check.
 */
const SEMANTIC_STAGE_INDEX = 3;

/**
 * One vote per built-in verifier, in pipeline order.
 *
 * Cross-check is not built yet and reports `NOT_IMPLEMENTED` / `NOT_APPLICABLE`
 * exactly as the pipeline does — both map to a non-vote, so a policy that
 * declares four verifiers today genuinely hears from three, and a
 * `VOTES_BELOW` clause is how it says whether three is enough.
 */
export function runBuiltInVerifiers(input: RunVerifiersInput): readonly VerifierResult[] {
  return votesFromStages(runBuiltInStages(input), input.semanticCostUsd ?? 0);
}

/**
 * Narrows already-evaluated stages to votes.
 *
 * The caller that needs both — `VerificationAggregatorService`, which settles on
 * the votes and puts the stages on the receipt — evaluates once and calls this,
 * so the two views of a call are guaranteed to describe the same evaluation.
 */
export function votesFromStages(
  stages: readonly StageEvaluation[],
  semanticCostUsd = 0,
): readonly VerifierResult[] {
  return stages.map((evaluation, index) =>
    voteFromStage(evaluation, index === SEMANTIC_STAGE_INDEX ? semanticCostUsd : 0),
  );
}

/**
 * Four stage rows for a call where no stage ran at all.
 *
 * Two situations reach it, and both are ours rather than the provider's: the
 * policy was withdrawn before any verifier was asked, or the tool has a decision
 * policy with no verification policy behind it. Either way the receipt still
 * owes the agent four rows — a receipt never omits a stage, because an absent
 * row reads as a tick to anyone scanning a list of them, and a tick here would
 * claim a check that nobody ran.
 *
 * `UNAVAILABLE` rather than `NOT_APPLICABLE`: the check was not inapplicable, it
 * was unavailable, and `STAGE_STATUS_NOTE` already prints the sentence that
 * matters — *"this check was unavailable — the provider was still credited"*.
 */
export function unrunStages(code: string, detail: string): readonly StageEvaluation[] {
  return VERIFICATION_PIPELINE.map((stage) => ({
    result: {
      stage,
      status: StageStatus.UNAVAILABLE,
      code,
      detail,
      score: null,
    },
    decidedVerdict: null,
  }));
}

/**
 * Cross-check, which does not exist yet.
 *
 * The same two-way distinction `../engine.ts` draws and for the same reason: a
 * stage the policy never declared is `NOT_APPLICABLE` — nothing here is worth
 * checking for this tool — while one it *did* declare is `NOT_IMPLEMENTED`,
 * which keeps the gap countable on the day somebody asks how many calls were
 * judged on the cheap layers alone.
 */
function crossCheckStage(policy: VerificationPolicy): StageEvaluation {
  const declared = policy.crossCheck?.enabled === true;

  return {
    result: {
      stage: VerificationStage.CROSS_CHECK,
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
