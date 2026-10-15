/**
 * Where a penalty stands, as the operator console's Penalties list groups it.
 *
 * Not a third state machine. It is a reading of the two columns that already
 * exist — the case `status` and the mirrored on-chain `chain_status` — in the
 * same precedence the console's case screen applies (`case-flow.ts`), so a
 * row in the list and the page it opens can never name the penalty
 * differently. The SQL that derives it lives in
 * `SlashProposalRepository.findOperatorCasePage`; this file is the vocabulary.
 */
export enum OperatorCaseStatus {
  /** On chain (or being written there), not disputed: the provider's window, or executable. */
  PROPOSED = 'PROPOSED',
  /** A case still in the retired off-chain objection process. */
  DISPUTED = 'DISPUTED',
  /** Disputed on chain: frozen until the arbiter rules, or 30 days pass. */
  CHAIN_DISPUTED = 'CHAIN_DISPUTED',
  /** Closed here; the record on chain waits for the arbiter key to sign its cancel. */
  CANCEL_REQUESTED = 'CANCEL_REQUESTED',
  /** The stake was taken. */
  EXECUTED = 'EXECUTED',
  /** Cancelled, overturned, suspended or waived: nothing was taken. */
  CANCELLED = 'CANCELLED',
  /** Executed, then paid back into the provider's stake by the treasury. */
  COMPENSATED = 'COMPENSATED',
  /** Disputed on chain, unruled for 30 days, and expired: nothing was taken. */
  EXPIRED = 'EXPIRED',
}

export const OPERATOR_CASE_STATUSES: readonly OperatorCaseStatus[] =
  Object.values(OperatorCaseStatus);
