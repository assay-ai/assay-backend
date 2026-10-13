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

export interface SlashChainRulingsPort {
  /** Returns whether the request id belongs to a case this platform planned. */
  recordDisputed(event: SlashChainDisputedEvent): Promise<boolean>;
  recordUpheld(event: SlashChainUpheldEvent): Promise<boolean>;
}

export const SLASH_CHAIN_RULINGS = 'SLASH_CHAIN_RULINGS';
