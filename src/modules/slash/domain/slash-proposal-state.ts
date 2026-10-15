import { ArbitrationOutcome, isOverturn, ResolutionKind } from './arbitration';

/**
 * The case's state machine, as a value.
 *
 * Pure. The transitions are a table rather than a set of `if`s in the service
 * for one reason that matters more here than anywhere else in the codebase: the
 * question "can this case still be executed?" has to have exactly one answer,
 * and a service that decides it inline will eventually decide it twice.
 */
export enum SlashProposalStatus {
  /**
   * Issued. The provider may object until `respondByAt` (Solana) or dispute
   * on chain until the record's `chainExecutableAt` (EVM).
   */
  PROPOSED = 'PROPOSED',
  /** The provider objected inside their window. Our clock starts here. */
  DISPUTED = 'DISPUTED',
  /** An operator claimed it. Still ours to decide. */
  UNDER_REVIEW = 'UNDER_REVIEW',
  /** An adjudicator decided; the required second signature is outstanding. */
  AWAITING_SECOND = 'AWAITING_SECOND',
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
 * - **`AWAITING_SECOND → UNDER_REVIEW`.** A second reader who objects does not
 *   overturn the first decision; the case goes back to being undecided.
 *   The rule is that disagreement escalates to an independent third
 *   reader, *not* to a negotiation between the first two — sending it back to
 *   the queue is the honest MVP of that, and it never lets an objection become
 *   a silent veto that resolves the case some other way.
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
  // `DISPUTED` reaches a decision directly, as well as through `UNDER_REVIEW`.
  //
  // Claiming a case is not a precondition for deciding it, and that is a
  // deliberate reading of the adjudication queue. Its red `unassigned` is about a
  // case with a *running clock and nobody watching it* — an adjudicator who
  // opens an unclaimed case and decides it there and then has not left it
  // unowned, and the override log names them on the decision either way.
  // Requiring a claim first would add a click that produces no record anybody
  // reads, and its only effect on a busy queue would be cases decided under
  // somebody else's name because claiming was the step that got skipped.
  [SlashProposalStatus.DISPUTED]: [
    SlashProposalStatus.UNDER_REVIEW,
    SlashProposalStatus.AWAITING_SECOND,
    SlashProposalStatus.UPHELD,
    SlashProposalStatus.OVERTURNED,
    SlashProposalStatus.CANCELLED,
  ],
  [SlashProposalStatus.UNDER_REVIEW]: [
    SlashProposalStatus.AWAITING_SECOND,
    SlashProposalStatus.UPHELD, // EVM: the arbiter upheld on chain (CHAIN_ARBITER)
    SlashProposalStatus.OVERTURNED, // we missed our own deadline
    SlashProposalStatus.CANCELLED,
  ],
  [SlashProposalStatus.AWAITING_SECOND]: [
    SlashProposalStatus.UPHELD,
    SlashProposalStatus.OVERTURNED,
    SlashProposalStatus.UNDER_REVIEW, // the second objected
    SlashProposalStatus.CANCELLED,
  ],
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

/**
 * The statuses no *decision* moves a case out of.
 *
 * `OVERTURNED` is on this list and has one outgoing edge, which is not a
 * contradiction: `OVERTURNED → REVERSED` returns money a stranger took after
 * the case was closed, and closing a case is the thing this list is about.
 * Nothing consumes it today; a consumer that means "has no outgoing edge"
 * must build that from `SLASH_PROPOSAL_TRANSITIONS` instead of from here.
 */
export const TERMINAL_SLASH_PROPOSAL_STATUSES: readonly SlashProposalStatus[] = Object.freeze([
  SlashProposalStatus.OVERTURNED,
  SlashProposalStatus.REVERSED,
  SlashProposalStatus.WAIVED,
  SlashProposalStatus.CANCELLED,
]);

/** The three states the adjudication queue draws from. */
export const QUEUEABLE_SLASH_PROPOSAL_STATUSES: readonly SlashProposalStatus[] = Object.freeze([
  SlashProposalStatus.DISPUTED,
  SlashProposalStatus.UNDER_REVIEW,
  SlashProposalStatus.AWAITING_SECOND,
]);

/** The status a decision lands the case in, before any second signature. */
export function statusForOutcome(outcome: ArbitrationOutcome): SlashProposalStatus {
  return isOverturn(outcome) ? SlashProposalStatus.OVERTURNED : SlashProposalStatus.UPHELD;
}

/**
 * Whether a decision needs a second signature before it binds.
 *
 * Two triggers, both from the `S-3` override-register row:
 *
 * 1. **Any overturn that opens a fleet sweep.** The conclusion is about to be
 *    applied to providers who never complained and never saw the evidence;
 *    that is the largest blast radius any single decision in this system has.
 * 2. **Any penalty at or above the materiality threshold.** The rule puts
 *    double-review above a threshold on penalty size, and single review with a
 *    sampled audit below it.
 *
 * Below both, a single adjudicator decides. The arithmetic is why: a
 * 30-minute human review costs $25–50 fully loaded against a penalty capped at
 * $5, so requiring two humans on every case would be 10–20× loss-making and
 * would guarantee the queue times out — which, under the platform-miss rule,
 * overturns the cases automatically anyway. A control that cannot be staffed is
 * not a control.
 */
export function requiresSecondSignature(
  outcome: ArbitrationOutcome,
  penaltyAmountMinor: bigint,
  materialityThresholdMinor: bigint,
  opensFleetSweep: boolean,
): boolean {
  if (opensFleetSweep) return true;
  return penaltyAmountMinor >= materialityThresholdMinor;
}

/**
 * The resolution kinds that may write a `resolvedAt` without a human.
 *
 * **Nothing reads this yet.** It was written for a consistency check that would
 * assert the converse — an `ADJUDICATOR` resolution reaching the database
 * without an override-log entry — and that check was never built:
 * `OverrideLogService` names neither `resolutionKind` nor `ADJUDICATOR`. Kept,
 * and kept complete, so that the check can be written against a list that is
 * already right rather than against one assembled from memory three kinds later.
 */
export const AUTOMATIC_RESOLUTION_KINDS: readonly ResolutionKind[] = Object.freeze([
  ResolutionKind.AUTO_UNDISPUTED,
  ResolutionKind.AUTO_PLATFORM_MISS,
  ResolutionKind.AUTO_DE_MINIMIS,
  // The chain closed it. Nobody read the case, so there is no adjudicator to
  // name on it.
  ResolutionKind.AUTO_CHAIN_VOIDED,
]);
