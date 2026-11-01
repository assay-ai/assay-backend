import type { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';
import type { AssetId } from '@modules/chains/ports/caip.types';

import type { ChannelDoorPort, ChannelTxSigned } from '../ports/channel-door.port';

/**
 * What the recorded hashes of one channel send say, once none of them has a
 * receipt:
 *
 * - `DROPPED`: every hash's sender has a CONFIRMED nonce past the hash's own
 *   nonce, and none has a receipt: another transaction took each nonce, so
 *   none of them can ever land. Only then may the send be released and sent
 *   again (coordinator rule 2026-10-31: never on a timer).
 * - `IN_FLIGHT`: at least one could still land (its nonce is not used yet), or
 *   a hash has no recorded sender/nonce, or the nonce could not be read. Kept
 *   in flight; nothing is re-sent.
 *
 * `replacedBy`: hashes whose nonce was taken by a transaction that is none of
 * this send's recorded hashes — the caller reports it (a nonce reused by
 * another of the redeemer's sends after a drop, or a foreign transaction).
 */
export interface DropVerdict {
  readonly verdict: 'DROPPED' | 'IN_FLIGHT';
  readonly replacedBy: readonly string[];
}

export async function droppedByNonce(
  door: Pick<ChannelDoorPort, 'confirmedNonce' | 'txReceipt' | 'nonceAndReceipts'>,
  channels: Pick<VoucherChannelRepository, 'attemptsOf'>,
  asset: AssetId,
  txRefs: readonly string[],
): Promise<DropVerdict> {
  const inFlight: DropVerdict = { verdict: 'IN_FLIGHT', replacedBy: [] };
  if (txRefs.length === 0 || typeof door.confirmedNonce !== 'function') return inFlight;
  let attempts: Map<string, { sender: string; nonce: bigint }>;
  try {
    attempts = await channels.attemptsOf(txRefs);
  } catch {
    return inFlight;
  }
  if (txRefs.some((txRef) => !attempts.has(txRef))) return inFlight;
  // One JSON-RPC batch where the client has it (sec-audit 2026-11-01 M-1):
  // the nonces and the receipts then come from ONE node, nonces first.
  if (typeof door.nonceAndReceipts === 'function') {
    let read: Awaited<ReturnType<NonNullable<ChannelDoorPort['nonceAndReceipts']>>>;
    try {
      read = await door.nonceAndReceipts(
        asset,
        [...new Set(txRefs.map((t) => attempts.get(t)!.sender as `0x${string}`))],
        txRefs,
      );
    } catch {
      return inFlight;
    }
    for (const txRef of txRefs) {
      const attempt = attempts.get(txRef)!;
      const next = read.nonces.get(attempt.sender.toLowerCase());
      if (next === undefined || next <= attempt.nonce) return inFlight;
      if (read.receipts.get(txRef) !== 'UNKNOWN') return inFlight;
    }
    return { verdict: 'DROPPED', replacedBy: [...txRefs] };
  }
  // 1. The confirmed nonces FIRST (re-review F2): a transaction sequenced
  //    between a receipt read and a later nonce read would otherwise look
  //    "nonce passed, no receipt" — dropped — while it landed.
  const confirmed = new Map<string, bigint>();
  for (const txRef of txRefs) {
    const attempt = attempts.get(txRef);
    if (!attempt) return inFlight;
    if (!confirmed.has(attempt.sender)) {
      try {
        confirmed.set(
          attempt.sender,
          await door.confirmedNonce(asset, attempt.sender as `0x${string}`),
        );
      } catch {
        return inFlight;
      }
    }
    // `confirmed` is the NEXT nonce: a nonce below it is used on chain.
    if ((confirmed.get(attempt.sender) as bigint) <= attempt.nonce) return inFlight;
  }
  // 2. THEN every receipt again: a nonce passed by one of OUR hashes shows here.
  for (const txRef of txRefs) {
    try {
      if ((await door.txReceipt(asset, txRef)).state !== 'UNKNOWN') return inFlight;
    } catch {
      return inFlight;
    }
  }
  return { verdict: 'DROPPED', replacedBy: [...txRefs] };
}

/** Records the sender and nonce `beforeBroadcast` handed over with a hash. */
export async function recordSigned(
  channels: Pick<VoucherChannelRepository, 'recordAttempt'>,
  hash: string,
  signed: ChannelTxSigned | undefined,
): Promise<void> {
  if (!signed || typeof channels.recordAttempt !== 'function') return;
  await channels.recordAttempt(hash, signed.from, signed.nonce);
}

/**
 * The minimum wall time a DROPPED verdict must hold before it is acted on
 * (sec-audit 2026-11-01 M-1 / B-S2), for every channel transaction kind
 * (settle, collect, refund): a verdict seen at two passes at least this far
 * apart, with no IN_FLIGHT answer in between. A lagging node behind a load
 * balancer catches up well within it; a block or two (about 0.1 s on this
 * chain) did not prove that.
 */
export const CHANNEL_DROP_CONFIRM_SECONDS = 30;
/** A first sighting older than this with no later check is forgotten (memory bound). */
const DROP_WATCH_FORGET_MS = 3_600_000;

/**
 * Remembers, per recorded send (settlement or `channel_txs` id), when its
 * DROPPED verdict was first seen. In process memory: a restart only starts
 * the wait again (the safe direction), and every process waits on its own.
 */
export class DropWatch {
  private readonly firstSeen = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly holdMs: number = CHANNEL_DROP_CONFIRM_SECONDS * 1000,
  ) {}

  /**
   * `true` only when `verdict` is DROPPED and DROPPED was first seen at least
   * the hold ago with no IN_FLIGHT since; an IN_FLIGHT verdict starts over.
   */
  confirm(id: string, verdict: DropVerdict['verdict']): boolean {
    const now = this.now();
    for (const [key, at] of this.firstSeen) {
      if (now - at > DROP_WATCH_FORGET_MS) this.firstSeen.delete(key);
    }
    if (verdict !== 'DROPPED') {
      this.firstSeen.delete(id);
      return false;
    }
    const first = this.firstSeen.get(id);
    if (first === undefined) {
      this.firstSeen.set(id, now);
      return false;
    }
    if (now - first < this.holdMs) return false;
    this.firstSeen.delete(id);
    return true;
  }

  /** The send resolved some other way: its sighting is dropped. */
  forget(id: string): void {
    this.firstSeen.delete(id);
  }
}
