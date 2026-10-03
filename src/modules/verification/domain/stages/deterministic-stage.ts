import { VerificationPolicy } from '../policy.types';
import { decideEmptyResult } from '../rules/empty-result';
import { evaluateRules } from '../rules/evaluate-rules';
import { RuleOutcome, RuleResult } from '../rules/rule.types';
import { StageEvaluation, StageInput, StageStatus, VerificationStage } from '../stage';
import { VerdictStatus } from '../verdict';

/**
 * The deterministic-rules stage (stage 2).
 *
 * Runs every rule in `policy.rules` unconditionally — the pipeline
 * short-circuits **between** stages (`stage.ts`), never within one, so a
 * receipt can show every rule that ran and not just the first that mattered.
 * That is the whole reason `evaluateRules` never stops early: this stage does
 * the stopping, once, after it has all the evidence.
 *
 * Three questions, asked of the whole rule set in this order, and the order
 * is load-bearing:
 *
 * 1. **Did anything come back empty?** `EMPTY_COLLECTION` outranks
 *    everything else, because an honest empty answer is not a quality
 *    question at all — see {@link decideEmptyResult}.
 * 2. **Did anything misapply?** A `MISAPPLIED` rule means the *policy*, not
 *    the response, was wrong. Outranks `FAILED`: if one rule could not be
 *    applied, this stage does not get to bill the provider for a different
 *    rule that could be.
 * 3. **Otherwise, score it.** Weighted pass rate over the rules that actually
 *    applied, compared against `policy.passThreshold`.
 */
export function runDeterministicStage(
  policy: VerificationPolicy,
  input: StageInput,
): StageEvaluation {
  const rules = evaluateRules(policy.rules, input);

  if (rules.some((rule) => rule.outcome === RuleOutcome.EMPTY_COLLECTION)) {
    return emptyResultEvaluation(policy, input, rules);
  }

  const firstMisapplied = rules.find((rule) => rule.outcome === RuleOutcome.MISAPPLIED);
  if (firstMisapplied) {
    return {
      result: {
        stage: VerificationStage.DETERMINISTIC_RULES,
        status: StageStatus.MISAPPLIED,
        code: firstMisapplied.code,
        detail: firstMisapplied.detail,
        score: null,
        rules,
      },
      decidedVerdict: VerdictStatus.MISAPPLIED,
    };
  }

  return decideScore(policy, rules);
}

/**
 * The empty-result branch.
 *
 * `MIN_ARRAY_LENGTH` is the only rule type that can produce
 * `EMPTY_COLLECTION`, and it means the collection genuinely resolved and has
 * zero elements — not a failure, but a fact that needs a disposition. The
 * disposition itself lives in `rules/empty-result.ts` rather than here, because
 * the schema stage reaches the same fact by a different route and the two must
 * not be able to disagree.
 */
function emptyResultEvaluation(
  policy: VerificationPolicy,
  input: StageInput,
  rules: readonly RuleResult[],
): StageEvaluation {
  const decision = decideEmptyResult(policy, input);

  return {
    result: {
      stage: VerificationStage.DETERMINISTIC_RULES,
      status: decision.status,
      code: decision.code,
      detail: decision.detail,
      score: decision.score,
      rules,
    },
    decidedVerdict: decision.verdict,
  };
}

/**
 * Weighted pass rate over the rules that applied.
 *
 * `NOT_APPLICABLE` rules are excluded from both the numerator and the
 * denominator — see `rule.types.ts`, `RuleOutcome.NOT_APPLICABLE`, for why an
 * inapplicable rule must never drag the score down. By the time this runs,
 * no rule is `EMPTY_COLLECTION` or `MISAPPLIED` (the caller already handled
 * both), so every entry here is `PASSED`, `FAILED`, or `NOT_APPLICABLE`.
 */
function decideScore(policy: VerificationPolicy, rules: readonly RuleResult[]): StageEvaluation {
  let passedWeight = 0;
  let consideredWeight = 0;
  let firstFailed: RuleResult | undefined;

  for (const rule of rules) {
    if (rule.outcome === RuleOutcome.NOT_APPLICABLE) continue;

    consideredWeight += rule.weight;
    if (rule.outcome === RuleOutcome.PASSED) {
      passedWeight += rule.weight;
    } else if (!firstFailed) {
      firstFailed = rule;
    }
  }

  // Nothing applied at all — every rule was gated off or vacuous. Nothing
  // objected, so nothing failed: the honest score is 1, not 0.
  const score = consideredWeight === 0 ? 1 : round4(passedWeight / consideredWeight);

  if (score >= policy.passThreshold) {
    return {
      result: {
        stage: VerificationStage.DETERMINISTIC_RULES,
        status: StageStatus.PASSED,
        code: null,
        detail: null,
        score,
        rules,
      },
      decidedVerdict: null,
    };
  }

  return {
    result: {
      stage: VerificationStage.DETERMINISTIC_RULES,
      status: StageStatus.FAILED,
      // The receipt shows one reason, not the whole failing set — the same
      // argument `schema-validator.ts` makes for stopping at the first violation.
      code: firstFailed?.code ?? null,
      detail: firstFailed?.detail ?? null,
      score,
      rules,
    },
    decidedVerdict: VerdictStatus.FAIL,
  };
}

/** 4 decimal places — enough precision for a threshold comparison, stable enough for a receipt. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
