import { ChainId } from '@modules/chains/ports/caip.types';

/**
 * What the chain watcher hands the slash domain when it sees the dispute
 * upgrade's two events (assay-evm D-19). Both are idempotent: the watcher
 * re-reads a range after any failure, so the same event may arrive twice.
 *
 * `executableAt` is ALWAYS the chain's — read off the event — and never
 * derived: an uphold does not necessarily make a record executable at once.
 */
export interface SlashChainDisputedEvent {
  readonly chainId: ChainId;
  /** 64 lower-case hex characters, no `0x`. */
  readonly requestId: string;
  readonly provider: string;
  readonly disputedAt: Date;
  readonly executableAt: Date;
  readonly transactionHash: string | null;
}

export interface SlashChainUpheldEvent {
  readonly chainId: ChainId;
  readonly requestId: string;
  readonly arbiter: string;
  readonly executableAt: Date;
  readonly transactionHash: string | null;
}

/**
 * `SlashCancelled`: an arbiter's or admin's `cancelSlash(Batch)` (a ruling for
 * the provider), or an `expireSlash` by anyone. `reason` is the contract's
 * `CancelReason`, by name.
 */
export interface SlashChainCancelledEvent {
  readonly chainId: ChainId;
  readonly requestId: string;
  readonly reason: 'WITHDRAWN' | 'EXPIRED' | 'VERIFIER_UNAVAILABLE' | 'DISPUTE_UNRESOLVED';
  readonly cancelledAt: Date;
  readonly transactionHash: string | null;
}

/**
 * `SlashExecuted`, whoever sent it — the backend's own executor, a keeper, a
 * script or the provider (`executeSlash` is permissionless). Amounts are the
 * event's, in minor units.
 */
export interface SlashChainExecutedEvent {
  readonly chainId: ChainId;
  readonly requestId: string;
  readonly appliedMinor: string;
  readonly agentAmountMinor: string;
  readonly platformAmountMinor: string;
  readonly executedAt: Date;
  readonly transactionHash: string | null;
}

/**
 * `SlashProposed` at the request id of a part this platform had given up on
 * (`REFUSED`): a straggler whose transaction landed after the give-up (review
 * S-5). The record is re-read and the part re-adopted.
 */
export interface SlashChainProposedEvent {
  readonly chainId: ChainId;
  readonly requestId: string;
  readonly executableAt: Date;
  readonly transactionHash: string | null;
}

export interface SlashChainRulingsPort {
  /** Returns whether the request id belongs to a case this platform planned. */
  recordDisputed(event: SlashChainDisputedEvent): Promise<boolean>;
  recordUpheld(event: SlashChainUpheldEvent): Promise<boolean>;
  recordCancelled(event: SlashChainCancelledEvent): Promise<boolean>;
  recordExecuted(event: SlashChainExecutedEvent): Promise<boolean>;
  recordLateProposal(event: SlashChainProposedEvent): Promise<boolean>;
}

export const SLASH_CHAIN_RULINGS = 'SLASH_CHAIN_RULINGS';
