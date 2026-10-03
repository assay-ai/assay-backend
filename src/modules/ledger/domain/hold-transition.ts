import { LedgerErrors } from '../errors/ledger.errors';
import { LedgerEntryType, LedgerHoldStatus } from '../ports/ledger.types';

/** The two ways a hold can end. */
export type HoldResolutionKind = LedgerHoldStatus.RELEASED | LedgerHoldStatus.COMMITTED;

export type HoldTransitionDecision =
  /** Write the journal entry and move the hold to `to`. */
  | { readonly kind: 'APPLY'; readonly to: HoldResolutionKind; readonly entryType: LedgerEntryType }
  /** Already in the requested state. Write nothing; report success. */
  | { readonly kind: 'NOOP' };

export const HOLD_RESOLUTION_ENTRY_TYPES: Readonly<Record<HoldResolutionKind, LedgerEntryType>> = {
  [LedgerHoldStatus.RELEASED]: LedgerEntryType.HOLD_RELEASE,
  [LedgerHoldStatus.COMMITTED]: LedgerEntryType.HOLD_COMMIT,
};

/**
 * The hold state machine, as a pure function of current state and requested
 * resolution.
 *
 * Two rules, and the difference between them is the whole point:
 *
 * - **Repeating a resolution is a no-op.** A worker that released a hold, lost
 *   its acknowledgement and retried is not asking for the money twice; it is
 *   asking whether the release happened. Answering with an error would push
 *   every caller into catching-and-ignoring a conflict code, and a caller that
 *   ignores `HOLD_ALREADY_RESOLVED` will ignore it after a `commit` too.
 * - **Changing a resolution is a conflict.** Committing a released hold, or
 *   releasing a committed one, asserts something false about where the money
 *   went. There is no safe interpretation of it, so it is refused and the
 *   caller finds out.
 *
 * The decision is pure so it can be tested exhaustively over
 * `status × resolution` without a database, and so the transactional code has
 * one thing left to get right: applying it atomically.
 */
export function decideHoldTransition(
  current: LedgerHoldStatus,
  requested: HoldResolutionKind,
  context: { readonly holdId: string; readonly intentId?: string },
): HoldTransitionDecision {
  if (current === LedgerHoldStatus.OPEN) {
    return { kind: 'APPLY', to: requested, entryType: HOLD_RESOLUTION_ENTRY_TYPES[requested] };
  }

  if (current === requested) {
    return { kind: 'NOOP' };
  }

  throw LedgerErrors.holdAlreadyResolved({
    holdId: context.holdId,
    intentId: context.intentId,
    resolution: current.toLowerCase(),
    requested: requested.toLowerCase(),
  });
}

export function isTerminal(status: LedgerHoldStatus): boolean {
  return status !== LedgerHoldStatus.OPEN;
}
