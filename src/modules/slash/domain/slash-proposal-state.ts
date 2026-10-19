/**
 * The case's state machine, as a value.
 *
 * Pure. The transitions are a table rather than a set of `if`s in the service
 * for one reason that matters more here than anywhere else in the codebase: the
 * question "can this case still be executed?" has to have exactly one answer,
 * and a service that decides it inline will eventually decide it twice.
 */
export enum SlashProposalStatus {
  /** Issued. The provider may dispute on chain until the record's `chainExecutableAt`. */
  PROPOSED = 'PROPOSED',
  /** Disputed on chain (`disputeSlash`); the arbiter rules on chain. */
  DISPUTED = 'DISPUTED',
  /** The penalty stands. Not yet on chain. */
  UPHELD = 'UPHELD',
  /**
   * The penalty is cancelled.
   *
   * Terminal **as a decision** — nothing an adjudicator or this platform does
   * moves a case out of here. The one edge out is `REVERSED`, and it is not a
   * second decision: `execute_slash` is permissionless, so a stranger can spend
   * the standing record after the overturn, and the reversal is how that money
   * goes back. See `SLASH_PROPOSAL_TRANSITIONS`.
   */
  OVERTURNED = 'OVERTURNED',
  /** An attestation is signed and a transaction is in flight. */
  EXECUTING = 'EXECUTING',
  /** The slash landed. Money moved. */
  EXECUTED = 'EXECUTED',
  /** An executed slash was reversed on chain. Terminal. */
  REVERSED = 'REVERSED',
  /** Below the de-minimis floor. Recorded for routing, never levied. Terminal. */
  WAIVED = 'WAIVED',
  /**
   * Closed without a penalty and without an overturn. Terminal.
   *
   * Two ways in, and they are not the same event. An operator suspends a case
   * (`S-1`), or the chain refuses the judgement permanently and the case is
   * voided from wherever it stood, `EXECUTING` included. `resolution_kind` is
   * what tells them apart: null for the first (a suspension is not a
   * judgement), `AUTO_CHAIN_VOIDED` for the second.
   *
   * A suspended case may still have a record standing on chain. The
   * suspension asks for its cancel (`chain_status = CANCEL_REQUESTED`); until
   * the settlement admin signs it the record can be executed by anyone once
   * its timelock passes, and such an execution is recorded on the row beside
   * this status — see `SlashExecutionService.recordAnExecutionNobodyAskedFor`.
   * There is no edge from here to `REVERSED`.
   */
  CANCELLED = 'CANCELLED',
}

/**
 * Legal transitions. Anything not listed is refused by
 * `SlashProposalService.transition`, which is the only writer of this column.
 *
 * Three edges are worth reading twice:
 *
 * - **`EXECUTED → REVERSED`, and nothing else out of `EXECUTED`.** Once money
 *   has moved, the only correction is the on-chain reversal. There is no path
 *   back to `UPHELD`, no re-execution, and no second reversal.
 * - **`OVERTURNED → REVERSED`.** The same edge, from the other status that can
 *   carry an `executed_at`. `execute_slash` is permissionless once
 *   `executable_at` passes, so between an adjudicator overturning a case and
 *   `cancel_slash` confirming, any stranger may spend the standing record;
 *   `SlashExecutionService.recordAnExecutionNobodyAskedFor` writes the money
 *   columns and deliberately leaves `status = 'OVERTURNED'`, because a chain
 *   event must not overwrite a human. That row is the *only* overturned case a
 *   reversal exists for — the provider is out of pocket for a judgement that
 *   was overturned — and this edge is what lets `reverse()` reach it. It is not
 *   a licence to reverse an overturn: `reverse()` gates on the money columns,
 *   not on the status, so an overturn that took nothing is still refused.
 * - **`EXECUTING → CANCELLED`.** `execute_slash` re-checks the
 *   verifier key, so a key revoked during the 72-hour wait voids every
 *   judgement it signed that is still in flight. That is the program working as
 *   designed rather than a transport fault, and it is terminal — the case has
 *   to leave the retry loop rather than go back to `UPHELD`.
 */
export const SLASH_PROPOSAL_TRANSITIONS: Readonly<
  Record<SlashProposalStatus, readonly SlashProposalStatus[]>
> = Object.freeze({
  [SlashProposalStatus.PROPOSED]: [
    SlashProposalStatus.DISPUTED,
    SlashProposalStatus.UPHELD, // nobody objected — AUTO_UNDISPUTED
    SlashProposalStatus.WAIVED,
    SlashProposalStatus.CANCELLED,
  ],
  // The arbiter's on-chain ruling: `upholdSlash` (`UPHELD`, `CHAIN_ARBITER`),
  // or `cancelSlash` / an expiry (`CANCELLED`).
  [SlashProposalStatus.DISPUTED]: [SlashProposalStatus.UPHELD, SlashProposalStatus.CANCELLED],
  [SlashProposalStatus.UPHELD]: [
    SlashProposalStatus.EXECUTING,
    SlashProposalStatus.CANCELLED,
    // EVM only (review R2-2): a case labelled AUTO_UNDISPUTED whose dispute on
    // chain was mirrored only after the label, with nothing executed. Not a
    // second decision: nobody had decided it.
    SlashProposalStatus.DISPUTED,
  ],
  [SlashProposalStatus.EXECUTING]: [
    SlashProposalStatus.EXECUTED,
    SlashProposalStatus.UPHELD, // the transaction failed; the case is executable again
    // The chain says this judgement will never pay — a revoked verifier key, or
    // a record somebody else already cancelled or expired. Returning it to
    // `UPHELD` would retry a dead judgement every tick until the seven-day
    // execution grace ran out, and then discharge it silently.
    SlashProposalStatus.CANCELLED,
  ],
  [SlashProposalStatus.EXECUTED]: [SlashProposalStatus.REVERSED],
  // Only where the chain took the penalty anyway — see the header.
  [SlashProposalStatus.OVERTURNED]: [SlashProposalStatus.REVERSED],
  [SlashProposalStatus.REVERSED]: [],
  [SlashProposalStatus.WAIVED]: [],
  [SlashProposalStatus.CANCELLED]: [],
});

export function canTransition(from: SlashProposalStatus, to: SlashProposalStatus): boolean {
  return SLASH_PROPOSAL_TRANSITIONS[from].includes(to);
}
