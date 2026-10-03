/**
 * The aggregator, wired.
 *
 * Everything impure about a verdict lives here and nowhere else: the policy
 * lookup, the kill-switch read, the clock. `../domain/aggregation/aggregate.ts`
 * stays a function of its arguments, so a dispute replays a stored
 * verdict without a database, a Redis or a date.
 *
 * ```text
 *   decide(call)
 *     │
 *     ├─ resolveForTraffic(toolId) ──▶ null       → no policy, unverified, settle
 *     │        │
 *     │        └─ kill switch covers it → withdrawnVerdict()  → DEGRADED, settle
 *     │
 *     ├─ runBuiltInStages() ─┬─ votesFromStages() ─┐
 *     │                      │                     │
 *     │                      └────── stages ───────┼─▶ receipt
 *     ├─ external verifiers ───────────────────────┤──▶ aggregate() ──▶ AggregatedVerdict
 *     │                                                     │
 *     └───────────────────────────── settlementDecision() ──┘  ← all settlement sees
 * ```
 *
 * The stages fork once and are never re-evaluated. The receipt needs the
 * eight-member `StageStatus`; the quorum needs the five-member
 * `VerifierOutcome`; and the one thing that must not happen is two evaluations
 * of one call, which can disagree.
 */

import { Injectable, Logger } from '@nestjs/common';

import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';

import {
  AggregatedVerdict,
  PolicyLifecycle,
  SettlementDecision,
  VerifierResult,
  aggregate,
  runBuiltInStages,
  settlementDecision,
  unrunStages,
  votesFromStages,
  withdrawnVerdict,
} from '../domain/aggregation';
import { SemanticJudgement } from '../domain/semantic.types';
import { StageResult } from '../domain/stage';
import { DecisionPolicyService } from './decision-policy.service';

export interface VerificationCall {
  readonly intentId: string;
  readonly toolId: string;
  /** The response **after** the binding's response mapping. */
  readonly response: JsonValue;
  /** The tool arguments the agent sent. Read only by rules gated on the request. */
  readonly request?: JsonValue;
  /** The tool's own `outputSchema`, used when the policy declares none. */
  readonly outputSchema?: JsonSchema;
  /** Obtained out of band by `SemanticVerificationService`, if at all. */
  readonly semantic?: SemanticJudgement;
  readonly semanticCostUsd?: number;
  /**
   * Verifiers we do not operate.
   *
   * The reason `verifierId` is an open string and the reason settlement is
   * given a narrowed type. A result here counts if and only if the policy
   * declares its `verifierId` — adding one is an edit to a versioned,
   * promotable, killable document, not a deploy and not a code change to
   * anything downstream.
   */
  readonly externalResults?: readonly VerifierResult[];
  readonly evaluatedAt: Date;
}

/**
 * A judged call.
 *
 * Two members with a deliberate asymmetry: `verdict` is the evidence, for the
 * receipt, the evidence pack and the dispute;
 * `settlement` is the instruction, and it is the only one the settlement module
 * is given. See `../domain/aggregation/settlement-decision.ts`.
 */
export interface VerificationOutcome {
  readonly verdict: AggregatedVerdict;
  readonly settlement: SettlementDecision;
  /**
   * All four pipeline stages, whole, in `VERIFICATION_PIPELINE` order.
   *
   * The receipt's rows. Present alongside `verdict.verifiers` rather
   * than derived from it because the vote vocabulary is deliberately coarser
   * than the stage vocabulary — five outcomes against eight statuses — and the
   * three distinctions it drops are precisely the ones a receipt must keep:
   * *not sampled*, *not built yet*, and *could not run*. See
   * `../domain/aggregation/run-verifiers.ts`.
   *
   * Always four entries, so a renderer can never meet a missing row.
   */
  readonly stages: readonly StageResult[];
}

@Injectable()
export class VerificationAggregatorService {
  private readonly logger = new Logger(VerificationAggregatorService.name);

  constructor(private readonly policies: DecisionPolicyService) {}

  /**
   * Judges one call.
   *
   * `null` when the tool has no policy at all — the caller settles the call
   * unverified. Not an error and not a `FAIL`: a tool nobody wrote a policy for
   * is our gap, and charging a provider for it would be charging them for our
   * gap.
   */
  async decide(call: VerificationCall): Promise<VerificationOutcome | null> {
    const resolved = await this.policies.resolveForTraffic(call.toolId);
    if (!resolved) return null;

    const { decisionPolicy } = resolved;

    // The kill switch short-circuits before any verifier runs. Evaluating a
    // withdrawn policy's clauses and then marking the result inert would still
    // leave a receipt saying the response failed, which a provider reads — see
    // `../domain/aggregation/withdrawn.ts`.
    if (resolved.lifecycle === PolicyLifecycle.WITHDRAWN && resolved.withdrawal) {
      const verdict = withdrawnVerdict({
        intentId: call.intentId,
        toolId: call.toolId,
        decisionPolicyId: decisionPolicy.id,
        decisionPolicyVersion: decisionPolicy.version,
        withdrawal: resolved.withdrawal,
        evaluatedAt: call.evaluatedAt,
      });
      return {
        verdict,
        settlement: settlementDecision(verdict),
        stages: unrunStages(
          'policy_withdrawn',
          'This check was not run: the policy behind it was withdrawn.',
        ).map((evaluation) => evaluation.result),
      };
    }

    const declared = new Set(decisionPolicy.verifiers.map((verifier) => verifier.verifierId));

    // Evaluated once, read twice: narrowed to votes for the quorum below, kept
    // whole for the receipt. Two evaluations of one call could disagree, and a
    // receipt that disagreed with the settlement it explains is worse than no
    // receipt at all.
    const stages = resolved.verificationPolicy
      ? runBuiltInStages({
          policy: resolved.verificationPolicy,
          stageInput: {
            response: call.response,
            request: call.request,
            evaluatedAt: call.evaluatedAt,
          },
          outputSchema: call.outputSchema,
          semantic: call.semantic,
          semanticCostUsd: call.semanticCostUsd,
        })
      : unrunStages(
          'no_verification_policy',
          'This check was not run: no verification policy is configured for this tool.',
        );

    // Built-in results the policy does not declare are dropped *here* rather
    // than left for `aggregate` to discard. `aggregate` would discard them
    // correctly and count them as `unregistered`, and that counter means
    // something specific — a verifier is running that nobody wired into the
    // quorum, which is worth waking someone for. A policy that legitimately
    // votes on the two cheap layers alone is not that, and letting it raise
    // that alert on every call is how the alert stops being read.
    const builtIn = votesFromStages(stages, call.semanticCostUsd ?? 0).filter((result) =>
      declared.has(result.verifierId),
    );

    const verdict = aggregate({
      intentId: call.intentId,
      toolId: call.toolId,
      decisionPolicy,
      lifecycle: resolved.lifecycle,
      results: [...builtIn, ...(call.externalResults ?? [])],
      policyId: resolved.verificationPolicy?.id,
      policyVersion: resolved.verificationPolicy?.version,
      evaluatedAt: call.evaluatedAt,
    });

    if (verdict.tally.unregistered > 0) {
      // Some verifier is running and being ignored. Silent would be worse than
      // wrong: an operator would believe a check is in the quorum when it is
      // not, and read every verdict as if it had voted.
      this.logger.warn(
        `${verdict.tally.unregistered} verifier result(s) discarded for intent ${call.intentId}: ` +
          `not declared by ${decisionPolicy.id} v${decisionPolicy.version}`,
      );
    }

    return {
      verdict,
      settlement: settlementDecision(verdict),
      stages: stages.map((evaluation) => evaluation.result),
    };
  }
}
