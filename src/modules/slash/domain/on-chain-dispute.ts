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
}

export interface OnChainDisputeMirror {
  readonly assetId: string;
  readonly chainStatus: string;
  readonly chainDisputedAt: Date | null;
  readonly chainDisputeWonAt: Date | null;
  readonly chainDisputedParts: number;
}

/**
 * The record's state from the watcher-mirrored columns, or `null` when the
 * case is not an EVM case or no record stands on chain yet.
 *
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
