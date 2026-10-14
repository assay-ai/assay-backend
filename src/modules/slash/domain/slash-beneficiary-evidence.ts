import { allocateLargestRemainder, normalizeAgentAccount } from './prorata-slash';

/**
 * What one payer paid for the failed calls of a window (follow-up C5), from
 * `sla_window_calls` joined to their `payment_intents`.
 *
 * - `paidMinor`: the voucher amounts the payer signed for those calls (the
 *   price of each failed call). Failed calls are refunded off chain, so this is
 *   what the payer committed, not what stayed charged.
 * - `redeemedMinor`: the part of it whose intent settled (was redeemed).
 */
export interface FailedCallPayment {
  readonly agentAccount: string;
  readonly failedCalls: number;
  readonly paidMinor: bigint;
  readonly redeemedMinor: bigint;
}

/** One part, as the check and the arbiter page read it. */
export interface BeneficiaryEvidence {
  readonly requestId: string;
  readonly beneficiary: string;
  /** The payer of the failed calls' vouchers this beneficiary stands for, or null. */
  readonly payer: string | null;
  readonly failedCalls: number;
  readonly paidMinor: string;
  readonly redeemedMinor: string;
  /**
   * What the penalty formula gives this payer: its pro-rata share, by failed
   * spend, of the case penalty (`excess bad calls × average price ×
   * multiplier`). The part may not exceed it (plus one minor unit of rounding).
   */
  readonly formulaShareMinor: string;
  /** The beneficiary's payout from the part: `penalty × agentBps / 10 000`, floored like the contract. */
  readonly shareMinor: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

/**
 * Follow-up C5 (audit C, "farming the 60% share"): before a part is signed,
 *
 * 1. its beneficiary must be a payer of the window's failed calls — the agent
 *    account their vouchers were signed from; and
 * 2. its part must not exceed that payer's pro-rata share of the formula
 *    penalty (the case penalty split by failed spend), with a tolerance of one
 *    minor unit for rounding. It is NOT compared with the raw spend: the
 *    formula multiplies the excess (`SLA_PENALTY_MULTIPLIER`), so the 60%
 *    share of a genuine case is routinely more than the payer paid (owner
 *    decision on C5).
 *
 * `paidMinor` counts the signed voucher amounts of the failed calls, which
 * are refunded off chain. `payments` is keyed by the normalised agent account.
 */
export function beneficiaryEvidence(
  parts: readonly {
    readonly chainRequestId: string;
    readonly agentAccount: string;
    readonly beneficiaryAccount: string;
    readonly penaltyAmount: string;
  }[],
  payments: ReadonlyMap<string, FailedCallPayment>,
  casePenalty: bigint,
  agentBps: number,
): BeneficiaryEvidence[] {
  const formula = allocateLargestRemainder(
    casePenalty,
    [...payments.values()].map((payment) => ({
      key: normalizeAgentAccount(payment.agentAccount),
      weight: payment.paidMinor,
    })),
  );
  return parts.map((part) => {
    const beneficiary = normalizeAgentAccount(part.beneficiaryAccount);
    const payment = payments.get(beneficiary) ?? null;
    const share = (BigInt(part.penaltyAmount) * BigInt(agentBps)) / 10_000n;
    const paid = payment?.paidMinor ?? 0n;
    const formulaShare = formula.get(beneficiary) ?? 0n;
    const penalty = BigInt(part.penaltyAmount);
    let reason: string | null = null;
    if (beneficiary !== normalizeAgentAccount(part.agentAccount)) {
      reason = `the beneficiary ${part.beneficiaryAccount} is not the part's agent ${part.agentAccount}`;
    } else if (!payment || payment.failedCalls === 0) {
      reason = `${part.beneficiaryAccount} paid no voucher for a failed call in this window`;
    } else if (penalty > formulaShare + 1n) {
      reason =
        `${part.beneficiaryAccount}'s part ${penalty} is more than the ${formulaShare} the ` +
        `penalty formula gives it for ${payment.failedCalls} failed call(s)`;
    }
    return {
      requestId: part.chainRequestId,
      beneficiary: part.beneficiaryAccount,
      payer: payment ? payment.agentAccount : null,
      failedCalls: payment?.failedCalls ?? 0,
      paidMinor: paid.toString(),
      formulaShareMinor: formulaShare.toString(),
      redeemedMinor: (payment?.redeemedMinor ?? 0n).toString(),
      shareMinor: share.toString(),
      ok: reason === null,
      reason,
    };
  });
}
