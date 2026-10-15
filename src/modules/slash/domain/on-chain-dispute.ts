import { ChainProposalStatus } from './chain-slash-outcome';

/**
 * The on-chain dispute, as the only dispute (owner decision, 2026-10-14).
 *
 * On EVM the provider disputes with `disputeSlash` / `disputeSlashBatch` from
 * its own stake wallet, the person-held arbiter rules on chain (`upholdSlash`
 * / `cancelSlash`), an unruled dispute expires after 30 days, and the record's
 * `executableAt` is the only deadline. No in-app objection, platform deadline,
 * extension or off-chain decision applies to such a case. Solana cases keep
 * the in-app objection: that program has no dispute.
 *
 * Pure: the watcher mirrors the chain's events onto the case, and this reads
 * the mirror.
 */

/** The CAIP-2 namespace of {@link disputesOnChain}, for SQL `LIKE` (`eip155:%`). */
export const ON_CHAIN_DISPUTE_ASSET_PREFIX = 'eip155:';

export function disputesOnChain(assetId: string): boolean {
  return assetId.startsWith(ON_CHAIN_DISPUTE_ASSET_PREFIX);
}

/** Where the case's on-chain record stands, in the provider's words. */
export enum OnChainDisputeState {
  /** Standing; the provider can dispute it until `chainExecutableAt`. */
  PENDING = 'PENDING',
  /** Frozen by the provider's dispute until the arbiter rules or it expires. */
  DISPUTED = 'DISPUTED',
  /** The arbiter upheld the dispute; it can be executed and not disputed again. */
  UPHELD = 'UPHELD',
  /** Cancelled on chain (the arbiter or admin), nothing taken. */
  CANCELLED = 'CANCELLED',
  /** Executed on chain: the penalty was taken. */
  EXECUTED = 'EXECUTED',
  /** The dispute went unruled for its 30 days and was expired; nothing taken. */
  EXPIRED = 'EXPIRED',
  /**
   * Review N-4: never disputed and never executed, then expired (the
   * execution grace ran out, or the verifier key stopped being valid). Nobody
   * ruled for the provider; nothing was taken.
   */
  LAPSED = 'LAPSED',
}

/** One on-chain record of the case (a part of the current epoch), as mirrored. */
export interface OnChainRecordMirror {
  readonly chainStatus: string;
  readonly chainDisputedAt: Date | null;
  readonly chainExecutableAt: Date | null;
  /** `SlashCancelled.reason`, for a cancelled record. */
  readonly cancelReason: string | null;
}

export interface OnChainDisputeMirror {
  readonly assetId: string;
  readonly chainStatus: string;
  readonly chainDisputedAt: Date | null;
  readonly chainDisputeWonAt: Date | null;
  readonly chainDisputedParts: number;
  /** The case's current-epoch records; when given, the state is derived from them. */
  readonly records?: readonly OnChainRecordMirror[];
}

/**
 * Review N-4: the case's state from its records, never from one case-level
 * timestamp. DISPUTED while any record is; UPHELD only when every pending
 * record was disputed before (it can only be executed now); PENDING while a
 * record stands undisputed; EXECUTED once nothing stands and a record
 * executed; otherwise by the cancel reasons: EXPIRED (a dispute nobody ruled
 * on), CANCELLED (the arbiter's or admin's cancelSlash), LAPSED (expired
 * undisputed).
 */
function stateOfRecords(records: readonly OnChainRecordMirror[]): OnChainDisputeState | null {
  const with_ = (status: string) => records.filter((record) => record.chainStatus === status);
  const pending = with_('PENDING');
  if (with_('DISPUTED').length > 0) return OnChainDisputeState.DISPUTED;
  if (pending.length > 0) {
    return pending.every((record) => record.chainDisputedAt)
      ? OnChainDisputeState.UPHELD
      : OnChainDisputeState.PENDING;
  }
  if (with_('EXECUTED').length > 0) return OnChainDisputeState.EXECUTED;
  const cancelled = with_('CANCELLED');
  if (cancelled.length === 0) return null;
  if (cancelled.some((record) => record.cancelReason === 'DISPUTE_UNRESOLVED')) {
    return OnChainDisputeState.EXPIRED;
  }
  if (cancelled.some((record) => record.cancelReason === 'WITHDRAWN' || !record.cancelReason)) {
    return OnChainDisputeState.CANCELLED;
  }
  return OnChainDisputeState.LAPSED;
}

/**
 * Review N-4: the provider may dispute on chain until the earliest door of a
 * record still pending and never disputed (a record is disputed at most
 * once), whatever its siblings or the case status say. `null` when none.
 */
export function disputeByOf(records: readonly OnChainRecordMirror[]): Date | null {
  const doors = records
    .filter((record) => record.chainStatus === 'PENDING' && !record.chainDisputedAt)
    .map((record) => record.chainExecutableAt)
    .filter((date): date is Date => date instanceof Date)
    .map((date) => date.getTime());
  return doors.length > 0 ? new Date(Math.min(...doors)) : null;
}

/**
 * The record's state from the watcher-mirrored columns, or `null` when the
 * case is not an EVM case or no record stands on chain yet.
 *
 * - With the case's records ({@link OnChainDisputeMirror.records}) the state
 *   is derived per record (review N-4); the rules below are the fallback for
 *   a case whose records are not at hand.
 * - `EXPIRED` is told from `CANCELLED` by its timing: the provider's win
 *   (`chainDisputeWonAt`) landed at least `disputeTimeoutMs` after the
 *   dispute. A record that lapsed undisputed reads `CANCELLED`.
 * - A record disputed once and standing again was upheld: a record is
 *   disputed at most once.
 */
export function onChainDisputeState(
  mirror: OnChainDisputeMirror,
  disputeTimeoutMs: number,
): OnChainDisputeState | null {
  if (!disputesOnChain(mirror.assetId)) return null;
  if (mirror.records && mirror.records.length > 0) {
    const derived = stateOfRecords(mirror.records);
    if (derived) return derived;
  }
  switch (mirror.chainStatus) {
    case ChainProposalStatus.EXECUTED:
      return OnChainDisputeState.EXECUTED;
    case ChainProposalStatus.CANCELLED: {
      const { chainDisputedAt: disputedAt, chainDisputeWonAt: wonAt } = mirror;
      return disputedAt && wonAt && wonAt.getTime() - disputedAt.getTime() >= disputeTimeoutMs
        ? OnChainDisputeState.EXPIRED
        : OnChainDisputeState.CANCELLED;
    }
    case ChainProposalStatus.DISPUTED:
      return OnChainDisputeState.DISPUTED;
    case ChainProposalStatus.PENDING:
    case ChainProposalStatus.CANCEL_REQUESTED:
      if (mirror.chainDisputedParts > 0) return OnChainDisputeState.DISPUTED;
      return mirror.chainDisputedAt ? OnChainDisputeState.UPHELD : OnChainDisputeState.PENDING;
    default:
      return null;
  }
}
