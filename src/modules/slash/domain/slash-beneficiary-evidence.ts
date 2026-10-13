import { normalizeAgentAccount } from './prorata-slash';

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
  /** The beneficiary's share of the part: `penalty × agentBps / 10 000`, floored like the contract. */
  readonly shareMinor: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

/**
 * Follow-up C5 (audit C, "farming the 60% share"): before a part is signed,
 *
 * 1. its beneficiary must be the payer of the failed calls' vouchers — the
 *    agent account the calls were paid from; and
 * 2. the beneficiary's share must be no more than what that payer paid for
 *    those calls (refund semantics: the share replaces a payment, it is not a
 *    prize).
 *
 * `payments` is keyed by the normalised agent account.
 */
export function beneficiaryEvidence(
  parts: readonly {
    readonly chainRequestId: string;
    readonly agentAccount: string;
    readonly beneficiaryAccount: string;
    readonly penaltyAmount: string;
  }[],
  payments: ReadonlyMap<string, FailedCallPayment>,
  agentBps: number,
): BeneficiaryEvidence[] {
  return parts.map((part) => {
    const beneficiary = normalizeAgentAccount(part.beneficiaryAccount);
    const payment = payments.get(beneficiary) ?? null;
    const share = (BigInt(part.penaltyAmount) * BigInt(agentBps)) / 10_000n;
    const paid = payment?.paidMinor ?? 0n;
    let reason: string | null = null;
    if (beneficiary !== normalizeAgentAccount(part.agentAccount)) {
      reason = `the beneficiary ${part.beneficiaryAccount} is not the part's agent ${part.agentAccount}`;
    } else if (!payment || payment.failedCalls === 0) {
      reason = `${part.beneficiaryAccount} paid no voucher for a failed call in this window`;
    } else if (share > paid) {
      reason =
        `${part.beneficiaryAccount}'s share ${share} is more than the ${paid} it paid for ` +
        `${payment.failedCalls} failed call(s)`;
    }
    return {
      requestId: part.chainRequestId,
      beneficiary: part.beneficiaryAccount,
      payer: payment ? payment.agentAccount : null,
      failedCalls: payment?.failedCalls ?? 0,
      paidMinor: paid.toString(),
      redeemedMinor: (payment?.redeemedMinor ?? 0n).toString(),
      shareMinor: share.toString(),
      ok: reason === null,
      reason,
    };
  });
}
