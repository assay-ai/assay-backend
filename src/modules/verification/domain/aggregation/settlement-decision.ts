/**
 * The boundary settlement reads.
 *
 * A genuinely distributed quorum is out of scope for now, but the aggregation
 * architecture must leave room for it — *"a second verifier that we do not
 * operate"*. Leaving room is not a matter of intent; it is a
 * matter of what settlement is allowed to look at. If the module that moves
 * money reads `verdict.verifiers[3].score`, then adding a fifth verifier is a
 * change to settlement, and the seam exists only in the diagram.
 *
 * So the seam is a type, and it is deliberately small:
 *
 * ```text
 *   AggregatedVerdict                   SettlementDecision
 *   ├─ status                    ──▶    ├─ status
 *   ├─ decisionPolicy{Id,Version}──▶    ├─ decisionPolicy{Id,Version}
 *   ├─ verifiers[]  ✗                   ├─ outcome / settle / strike / slashable
 *   ├─ tally        ✗                   └─ reason, reasonCode
 *   ├─ decidedBy    ✗
 *   └─ score        ✗
 * ```
 *
 * Everything on the left that is missing on the right is *evidence*: it belongs
 * on the receipt, in the evidence pack and in the dispute, and it is none of
 * settlement's business. Everything on the right is an instruction or the
 * identity of the policy that issued it.
 *
 * `SETTLEMENT_DECISION_FIELDS` is asserted against `Object.keys` in
 * `test/unit/verification/settlement-boundary.spec.ts`, so widening this object
 * is a test failure rather than a code review someone might wave through.
 */

import {
  VerdictConsequence,
  VerdictOutcome,
  VerdictStatus,
  effectiveConsequence,
} from '../verdict';
import { AggregatedVerdict } from './aggregate';

/**
 * Everything settlement is allowed to know about a verdict.
 *
 * Note what `settle`, `strike` and `slashable` are: they are already *resolved*
 * through {@link effectiveConsequence}, so a shadow or withdrawn policy arrives
 * here as a decision that pays rather than as a `FAIL` plus a flag settlement
 * has to remember to honour. A call site cannot forget a rule it is never
 * shown.
 */
export interface SettlementDecision {
  readonly intentId: string;
  readonly status: VerdictStatus;
  readonly outcome: VerdictOutcome;
  /** Charge the agent and credit the provider? */
  readonly settle: boolean;
  /** Record a strike against the provider? */
  readonly strike: boolean;
  /** May this, downstream, reach the provider's stake? */
  readonly slashable: boolean;
  /** The exact policy version that decided it. Recorded on the settlement. */
  readonly decisionPolicyId: string;
  readonly decisionPolicyVersion: number;
  /** Stable code for the settlement record and its metrics. */
  readonly reasonCode: string | null;
  /** One sentence, for the refund notice and the receipt. */
  readonly reason: string | null;
  readonly evaluatedAt: Date;
}

/** The exact key set of a {@link SettlementDecision}. Asserted by a test. */
export const SETTLEMENT_DECISION_FIELDS: readonly string[] = Object.freeze([
  'intentId',
  'status',
  'outcome',
  'settle',
  'strike',
  'slashable',
  'decisionPolicyId',
  'decisionPolicyVersion',
  'reasonCode',
  'reason',
  'evaluatedAt',
]);

/**
 * Narrows an aggregated verdict to what settlement may act on.
 *
 * Frozen, because the object crosses a module boundary and the receiving module
 * has no business editing a judgement. Constructed field by field rather than
 * by spreading and deleting: a spread would silently carry any field added to
 * `AggregatedVerdict` later, which is exactly the leak this file exists to
 * prevent.
 */
export function settlementDecision(verdict: AggregatedVerdict): SettlementDecision {
  const consequence: VerdictConsequence = effectiveConsequence(verdict);

  return Object.freeze({
    intentId: verdict.intentId,
    status: verdict.status,
    outcome: consequence.outcome,
    settle: consequence.settle,
    strike: consequence.strike,
    slashable: consequence.slashable,
    decisionPolicyId: verdict.decisionPolicyId,
    decisionPolicyVersion: verdict.decisionPolicyVersion,
    reasonCode: verdict.reasonCode,
    reason: verdict.reason,
    evaluatedAt: verdict.evaluatedAt,
  });
}
