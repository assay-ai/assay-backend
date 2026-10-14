import { allocateLargestRemainder, normalizeAgentAccount } from './prorata-slash';

/** The stored fields of one part that the check reads. */
export interface StoredPlanPart {
  readonly agentAccount: string;
  readonly beneficiaryAccount: string;
  readonly weightAmount: string;
  readonly uncappedShareAmount: string;
  readonly penaltyAmount: string;
  readonly planPenaltyAmount: string;
}

/**
 * Why a stored pro-rata plan does not follow from the evidence, or `null`
 * (security review H-2).
 *
 * A plan is stored once and every later attempt signs exactly what the rows
 * say, so an edited row (a different beneficiary, a higher penalty) would be
 * signed and broadcast. This re-derives what can be re-derived and refuses
 * anything else:
 *
 * - every beneficiary is the harmed agent's own account (the EVM rule);
 * - every agent is in `evidence`: a payer whose failed, priced call to THIS
 *   provider is counted in the window, with the same weight;
 * - each uncapped share is the largest-remainder split of the plan penalty by
 *   those weights, and each signed penalty is at most that share (a cap only
 *   lowers it);
 * - the plan penalty, and the sum of every signed penalty, are at most the
 *   case penalty.
 *
 * What it cannot re-derive is the cap actually applied: the caps are read
 * from the chain at planning time and move afterwards, so a stored penalty
 * BELOW its share is accepted. Nor does it prove the evidence rows themselves
 * are genuine: `sla_window_calls` and `payment_intents` are rows too.
 *
 * `evidence` maps a normalised agent account to its weight (Σ price of its
 * failed calls in the window, minor units).
 */
export function planEvidenceMismatch(input: {
  readonly casePenalty: bigint;
  readonly evidence: ReadonlyMap<string, bigint>;
  readonly parts: readonly StoredPlanPart[];
}): string | null {
  const { casePenalty, evidence, parts } = input;
  if (parts.length === 0) return 'the plan has no parts';

  const planPenalty = BigInt(parts[0].planPenaltyAmount);
  if (parts.some((part) => BigInt(part.planPenaltyAmount) !== planPenalty)) {
    return 'the parts disagree on the plan penalty';
  }
  if (planPenalty > casePenalty) {
    return `the plan penalty ${planPenalty} is above the case penalty ${casePenalty}`;
  }

  const harmed = [...evidence]
    .filter(([, weight]) => weight > 0n)
    .map(([key, weight]) => ({ key, weight }));
  const shares = allocateLargestRemainder(planPenalty, harmed);

  const seen = new Set<string>();
  let total = 0n;
  for (const part of parts) {
    const agent = normalizeAgentAccount(part.agentAccount);
    if (seen.has(agent)) return `agent ${agent} appears twice in the plan`;
    seen.add(agent);

    if (normalizeAgentAccount(part.beneficiaryAccount) !== agent) {
      return `part for ${agent} names beneficiary ${part.beneficiaryAccount}, not the agent`;
    }
    const weight = evidence.get(agent);
    if (weight === undefined || weight <= 0n) {
      return `${agent} is not a payer with a failed, priced call to this provider in the window`;
    }
    if (BigInt(part.weightAmount) !== weight) {
      return `part for ${agent} has weight ${part.weightAmount}, the window shows ${weight}`;
    }
    const share = shares.get(agent) ?? 0n;
    if (BigInt(part.uncappedShareAmount) !== share) {
      return `part for ${agent} has share ${part.uncappedShareAmount}, the evidence gives ${share}`;
    }
    const penalty = BigInt(part.penaltyAmount);
    if (penalty < 0n || penalty > share) {
      return `part for ${agent} signs penalty ${penalty}, above its share ${share}`;
    }
    total += penalty;
  }

  if (total > casePenalty) {
    return `the parts sum to ${total}, above the case penalty ${casePenalty}`;
  }
  return null;
}
