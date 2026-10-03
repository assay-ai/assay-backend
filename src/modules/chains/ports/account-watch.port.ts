import { AccountId } from './caip.types';

/** Stops a watch. Idempotent — calling it twice is not an error. */
export type StopWatching = () => void;

/**
 * A live subscription to changes on one on-chain account.
 *
 * ## What this port is, and deliberately is not
 *
 * It is a **wake-up signal**, not a data source. `onChange` is told *that* the
 * account moved, never what it moved to and never by which transaction. A
 * caller must go and read whatever it actually needs, from the same authority
 * it would have read without this port at all.
 *
 * That restriction is the whole design. A notification is unauthenticated
 * relative to our own records — it arrives over a socket held open by a third
 * party, out of order, possibly duplicated, possibly not at all — so anything
 * derived from its *contents* would be a second, weaker source of truth about
 * money. Reduced to "look again now", it can be wrong in every one of those
 * ways without a wrong balance being reachable: at worst the caller looks and
 * finds nothing, and the periodic path it is layered over still runs.
 *
 * ## Why a port
 *
 * The subscription is a chain SDK and a websocket, and `chains/` is where both
 * are allowed to exist (`docs/architecture.md` §Module Structure Pattern). A
 * domain service holds this interface and a token; it does not know that
 * Solana, Helius or a websocket are involved, the same way it does not know
 * them for `VaultPort`.
 */
export interface AccountWatchPort {
  /**
   * Calls `onChange` whenever `account` changes at finalized commitment.
   *
   * Resolves once the subscription is open. Reconnection is the
   * implementation's problem, not the caller's: a caller that has to
   * distinguish "connected" from "reconnecting" would be a caller depending on
   * delivery, which this port does not promise.
   */
  watch(account: AccountId, onChange: () => void): Promise<StopWatching>;
}

export const ACCOUNT_WATCH_PORT = 'ACCOUNT_WATCH_PORT';
