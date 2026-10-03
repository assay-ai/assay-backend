/**
 * The queue's state machine, as a value — modelled on
 * `SlashProposalStatus` / `SLASH_PROPOSAL_TRANSITIONS`
 * (`src/modules/slash/domain/slash-proposal-state.ts`).
 *
 * Pure. `ToolRequestQueueService.answer` is the only writer of `status`, and
 * it asks this table rather than deciding inline, for the same reason the
 * slash domain does: "can this request still move to X" needs exactly one
 * answer, and a service that decides it with an `if` will eventually decide it
 * twice and disagree with itself.
 *
 * ## Four states, not six
 *
 * This is a ticket queue, not a review pipeline: a proposal workflow should not
 * ship before the reviewers exist. There is no `UNDER_REVIEW`, no revision round, no
 * second signature. `chk_tool_requests_status` on the migration is the same
 * four values this enum has, in the same order, and neither may grow without
 * the other moving too.
 *
 * ## `first_responded_at` is not one of these states
 *
 * It is a fact about the *first* transition out of `OPEN`, not about the
 * current one — the migration's own docstring: "a status column can only
 * remember the last one." `isFirstResponse` below is what tells the service
 * whether to stamp it; the state machine only says which moves are legal.
 */
export enum ToolRequestStatus {
  /** Filed. Nobody has responded yet. */
  OPEN = 'OPEN',
  /** An operator has looked at it, and has not yet decided. Not terminal. */
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  /** We will build it. Terminal — carries `closedAt` and `resolutionNote`. */
  ACCEPTED = 'ACCEPTED',
  /** We will not, right now. Terminal — carries `closedAt` and `resolutionNote`. */
  DECLINED = 'DECLINED',
}

/**
 * Legal transitions. Anything not listed is refused by
 * `ToolRequestQueueService.answer`, the only writer of this column.
 *
 * `OPEN` may go straight to `ACCEPTED` or `DECLINED` as well as through
 * `ACKNOWLEDGED` — acknowledging is not a precondition for deciding, the same
 * reading `slash-proposal-state.ts` gives `DISPUTED → UPHELD` without passing
 * through `UNDER_REVIEW`: an owner who answers a ticket definitively on first
 * read has not skipped a step, and requiring the extra click first would only
 * ever produce requests acknowledged and decided in the same second by the
 * same person, which records nothing a reader could not already see from the
 * two timestamps.
 */
export const TOOL_REQUEST_TRANSITIONS: Readonly<
  Record<ToolRequestStatus, readonly ToolRequestStatus[]>
> = Object.freeze({
  [ToolRequestStatus.OPEN]: [
    ToolRequestStatus.ACKNOWLEDGED,
    ToolRequestStatus.ACCEPTED,
    ToolRequestStatus.DECLINED,
  ],
  [ToolRequestStatus.ACKNOWLEDGED]: [ToolRequestStatus.ACCEPTED, ToolRequestStatus.DECLINED],
  [ToolRequestStatus.ACCEPTED]: [],
  [ToolRequestStatus.DECLINED]: [],
});

export function canTransition(from: ToolRequestStatus, to: ToolRequestStatus): boolean {
  return TOOL_REQUEST_TRANSITIONS[from].includes(to);
}

export const TERMINAL_TOOL_REQUEST_STATUSES: readonly ToolRequestStatus[] = Object.freeze([
  ToolRequestStatus.ACCEPTED,
  ToolRequestStatus.DECLINED,
]);

export function isTerminal(status: ToolRequestStatus): boolean {
  return TERMINAL_TOOL_REQUEST_STATUSES.includes(status);
}

/**
 * `chk_tool_requests_closed_is_whole`, read as a predicate rather than a
 * constraint: does landing in `status` require `closedAt` and
 * `resolutionNote`?
 *
 * Same set as {@link isTerminal} today — every terminal state in this small a
 * machine happens to be a closed one — but named separately because the two
 * questions are different ("can nothing leave here" versus "does this carry a
 * reason"), and a future state that is terminal without being a resolution
 * (there is none today) would only need this one to change.
 */
export function requiresClosure(status: ToolRequestStatus): boolean {
  return status === ToolRequestStatus.ACCEPTED || status === ToolRequestStatus.DECLINED;
}

/**
 * `chk_tool_requests_answered_is_timed`: does moving to `status` need
 * `first_responded_at` stamped?
 *
 * True for every status except `OPEN` — leaving `OPEN` *is* the first
 * response, whichever of the three outcomes it lands on. The caller only
 * stamps the column when it is still null (see the migration's docstring:
 * "set on the first transition and never cleared"); this function says
 * whether the destination state requires it to be set at all, not whether
 * this particular call is the one that sets it.
 */
export function requiresFirstResponseStamp(status: ToolRequestStatus): boolean {
  return status !== ToolRequestStatus.OPEN;
}
