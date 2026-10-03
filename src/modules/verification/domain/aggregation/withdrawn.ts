/**
 * The verdict of a call whose policy was pulled.
 *
 * When the kill switch covers a policy version, the aggregator does **not**
 * evaluate its clauses and mark the result inert. It does not evaluate them at
 * all. The difference matters for exactly the reason the switch exists: an
 * operator who pulls a policy at 3am is asserting *"this policy's judgement is
 * wrong and must stop being applied"*, and a system that keeps applying it and
 * files the answer under shadow has not done what it was told. It has also left
 * a receipt saying the response failed, which a provider will read.
 *
 * ```text
 *   verdict  DEGRADED     — the check could not be completed
 *   outcome  SETTLE       — the provider is credited
 *   strike   false        — nobody is struck for our withdrawal
 *   verifiers []          — the policy's clauses were never evaluated
 * ```
 *
 * `DEGRADED` rather than a new status because the vocabulary already has the
 * right word: `../verdict.ts` defines it as the cheap stages passing and an
 * expensive stage being unavailable, and *"unavailability of our own
 * infrastructure must not become a provider's loss"* is exactly the situation.
 * A withdrawn policy is our infrastructure being unavailable by choice. It also
 * means the `DEGRADED` rate — which is already alerted on at < 1% —
 * moves when a policy is pulled, without anybody wiring a new alert.
 */

import { PolicyLifecycle } from './decision-policy.types';
import { KillRecord } from '../lifecycle/kill-switch';
import { VerdictStatus } from '../verdict';
import { AggregatedVerdict, VoteTally } from './aggregate';

const NO_VOTES: VoteTally = Object.freeze({
  declared: 0,
  votes: 0,
  passed: 0,
  failed: 0,
  misapplied: 0,
  unavailable: 0,
  abstained: 0,
  failedFraction: null,
  unregistered: 0,
});

export interface WithdrawnVerdictInput {
  readonly intentId: string;
  readonly toolId: string;
  readonly decisionPolicyId: string;
  readonly decisionPolicyVersion: number;
  readonly withdrawal: KillRecord;
  readonly evaluatedAt: Date;
}

export function withdrawnVerdict(input: WithdrawnVerdictInput): AggregatedVerdict {
  return {
    intentId: input.intentId,
    toolId: input.toolId,
    policyId: null,
    policyVersion: null,
    // Recorded even though nothing was applied. A verdict must
    // name the policy version it was decided under, and "this call was decided
    // by the withdrawal of v4" is a fact about v4 — it is how an incident
    // review counts what the pull affected.
    decisionPolicyId: input.decisionPolicyId,
    decisionPolicyVersion: input.decisionPolicyVersion,
    lifecycle: PolicyLifecycle.WITHDRAWN,
    status: VerdictStatus.DEGRADED,
    reasonCode: 'policy_withdrawn',
    reason: input.withdrawal.reason,
    score: null,
    costUsd: 0,
    tally: NO_VOTES,
    decidedBy: { clauseIndex: null, trigger: null, label: null },
    verifiers: [],
    shadow: true,
    evaluatedAt: input.evaluatedAt,
  };
}
