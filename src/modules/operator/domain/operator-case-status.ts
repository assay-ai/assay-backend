import { disputesOnChain } from '@modules/slash/domain/on-chain-dispute';

/**
 * Where a penalty stands, as the operator console's Penalties list groups it.
 *
 * Not a third state machine. It is a reading of the two columns that already
 * exist — the case `status` and the mirrored on-chain `chain_status` — in the
 * same precedence the console's case screen applies (`case-flow.ts`), so a
 * row in the list and the page it opens can never name the penalty
 * differently. {@link operatorCaseStatusOf} below is the definition; the SQL
 * that derives it for the list, `SlashProposalRepository.findOperatorCasePage`,
 * is held to it by an integration test.
 */
export enum OperatorCaseStatus {
  /** On chain (or being written there), not disputed: the provider's window, or executable. */
  PROPOSED = 'PROPOSED',
  /** A non-EVM case still in the off-chain objection process (EVM disputes on chain). */
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

/** The proposal columns {@link operatorCaseStatusOf} reads. */
export interface OperatorCaseFacts {
  readonly assetId: string;
  /** The case status (`SlashProposalStatus`). */
  readonly status: string;
  /** The mirrored on-chain status (`ChainProposalStatus`); `NONE` when none. */
  readonly chainStatus: string;
  readonly resolutionKind: string | null;
  readonly chainDisputedAt: Date | null;
  readonly chainDisputedParts: number;
  readonly chainExecutableAt: Date | null;
  readonly earliestExecutionAt: Date | null;
  readonly platformDecisionDueAt: Date | null;
}

/** The retired off-chain objection statuses. */
const LEGACY_DISPUTE_STATUSES: readonly string[] = ['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'];

/**
 * The definition of {@link OperatorCaseStatus}, in the console case screen's
 * precedence (`case-flow.ts` `caseFacts`). `SlashProposalRepository`'s
 * `OPERATOR_CASE_STATUS_SQL` is this function written in SQL, and the
 * integration test `operator-case-list.integration.spec.ts` holds the two to
 * the same answers. Change both or neither.
 *
 * - The case screen reads an EVM case by where its on-chain record stands, so
 *   a case left in an off-chain objection status with no part disputed any
 *   more (its only disputed part cancelled or expired while another stands
 *   pending) is `PROPOSED` — window open or executable — not `DISPUTED`
 *   (audit D1). Only a non-EVM case is in the off-chain process.
 * - A chain refusal (`REFUSED`) on a case that is still open is not a cancel:
 *   the screen reads it as not on chain, which this vocabulary files under
 *   `PROPOSED` (audit D4). A refused case is voided, and its `CANCELLED`
 *   status names it cancelled.
 */
export function operatorCaseStatusOf(facts: OperatorCaseFacts): OperatorCaseStatus {
  const { status, chainStatus: chain } = facts;
  if (status === 'REVERSED') return OperatorCaseStatus.COMPENSATED;
  if (chain === 'EXECUTED' || status === 'EXECUTED' || status === 'EXECUTING') {
    return OperatorCaseStatus.EXECUTED;
  }
  if (chain === 'CANCEL_REQUESTED') return OperatorCaseStatus.CANCEL_REQUESTED;
  if (
    status === 'CANCELLED' &&
    facts.resolutionKind === 'AUTO_CHAIN_VOIDED' &&
    chain === 'CANCELLED' &&
    facts.chainDisputedAt !== null
  ) {
    return OperatorCaseStatus.EXPIRED;
  }
  if (chain === 'CANCELLED' || ['OVERTURNED', 'WAIVED', 'CANCELLED'].includes(status)) {
    return OperatorCaseStatus.CANCELLED;
  }
  if (chain === 'DISPUTED' || (chain === 'PENDING' && facts.chainDisputedParts > 0)) {
    return OperatorCaseStatus.CHAIN_DISPUTED;
  }
  if (LEGACY_DISPUTE_STATUSES.includes(status) && !disputesOnChain(facts.assetId)) {
    return OperatorCaseStatus.DISPUTED;
  }
  return OperatorCaseStatus.PROPOSED;
}

/**
 * The next instant something happens to the penalty on its own, for a case in
 * `status` (`OPERATOR_CASE_DEADLINE_SQL` in SQL). A dispute lapses
 * `disputeTimeoutMs` after it was raised; a cancel under a disputed record
 * lapses the same way, and one under a `Pending` record must be signed before
 * the record turns executable. An undisputed penalty is executable from the
 * case screen's `executableAt`: the chain's own time when the record is on
 * chain, else Assay's `earliestExecutionAt` (audit D2). Closed penalties have
 * none.
 */
export function operatorCaseDeadlineOf(
  facts: OperatorCaseFacts,
  status: OperatorCaseStatus,
  disputeTimeoutMs: number,
): Date | null {
  const disputeLapses = () =>
    facts.chainDisputedAt ? new Date(facts.chainDisputedAt.getTime() + disputeTimeoutMs) : null;
  switch (status) {
    case OperatorCaseStatus.CHAIN_DISPUTED:
      return disputeLapses();
    case OperatorCaseStatus.CANCEL_REQUESTED:
      return facts.chainDisputedAt && facts.chainDisputedParts > 0
        ? disputeLapses()
        : facts.chainExecutableAt;
    case OperatorCaseStatus.PROPOSED:
      return facts.chainExecutableAt ?? facts.earliestExecutionAt;
    case OperatorCaseStatus.DISPUTED:
      return facts.platformDecisionDueAt;
    default:
      return null;
  }
}
