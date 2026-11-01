import {
  REFUND_ALREADY_REFUNDED,
  channelRefundPieceId,
  checksumAddress,
} from '../domain/channel/channel-voucher';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  ChannelTxKind,
  ChannelTxStatus,
  VoucherChannelStatus,
} from '@database/postgres/entities/voucher-channel.entity';
import {
  ChannelTxRecord,
  VoucherChannelRepository,
} from '@database/postgres/repositories/voucher-channel.repository';
import { AssetId, parseAccountId } from '@modules/chains/ports/caip.types';

import { nextRefundPiece } from '../domain/channel/channel-policy';
import {
  CHANNEL_DOOR,
  ChannelDoorPort,
  ChannelRefInput,
  channelSendNotSent,
  RefundLanding,
  RefundResult,
} from '../ports/channel-door.port';
import { DropWatch, droppedByNonce, recordSigned } from './channel-tx-attempts';

/** What a channel refund did (SPEC-W2 §5). */
export type ChannelRefundOutcome =
  | { readonly kind: 'REFUNDED'; readonly txRef: string }
  /** The money left the bucket for the provider before the refund could be sent. */
  | { readonly kind: 'COLLECTED' }
  /** Past `maturity + HELD_TIMEOUT`: the refund window is closed on chain. */
  | { readonly kind: 'TIMED_OUT' }
  /** Nothing sent this time (no bucket holds it, or an earlier send is unresolved): retried. */
  | { readonly kind: 'NOT_FOUND'; readonly reason: string };

interface RefundInput {
  readonly assetId: string;
  readonly channelRowId: string;
  /** The call's whole amount. */
  readonly amount: bigint;
  readonly intentId: string;
}

/** At most this many pieces per `refund()` (two buckets: at most two pieces are ever needed). */
const MAX_PIECES_PER_CALL = 3;

/** An unresolved refund this old is logged as stuck; it is never re-sent on a timer. */
const STUCK_AFTER_SECONDS = 900;
/**
 * How far back a refund's landing (`ChannelRefunded` with its `refundId`) is
 * looked for when the chain answers `AlreadyRefunded`: about a day of blocks
 * at Robinhood Chain's ~81 ms. Past it the refund is still booked LANDED,
 * with a note for the reconciler.
 */
const REFUND_LANDING_LOOKBACK_BLOCKS = 1_200_000n;

/**
 * Refunds one disputed (or blocked-provider) channel call out of its channel's
 * buckets (`refundChannels`, redeemer only, not pause-gated). The bucket is
 * the newest one that holds the amount and is still inside its refund window
 * (v3 §3.5: newest first). Once a dispute has kept money the channel is
 * ROTATED (v3 §5.5), so no fold can move it again.
 *
 * ## In pieces (final review 2026-11-01 MF-1 / X-1)
 *
 * A collect pays oldest first, so the money a dispute keeps may sit partly in
 * each bucket. When no single in-window bucket holds the rest of the call,
 * it is refunded in pieces: the newest bucket gives what it holds, then the
 * older one, ONE PIECE PER TRANSACTION, piece `k` with its own id
 * (`channelRefundPieceId(intentId, k)`; piece 0 is the single-piece id). A
 * piece is only started when the open buckets together hold the rest. A
 * landed piece that does not complete the call is recorded `PARTIAL`; the
 * next piece follows (in the same call, or on the caller's retry). The call
 * counts as refunded (`REFUNDED`) only once its landed pieces sum to its
 * amount.
 *
 * ## Idempotent per piece (review 2026-10-31 H1, sec-audit 2026-11-01 M-1)
 *
 * Every send of a piece carries the same `refundId`; the chain refunds an id at most once per lane
 * and answers a repeat with `ChannelRefundSkipped(AlreadyRefunded)`, moving
 * no money. That answer means the piece landed earlier: it is booked at what
 * THAT send moved (its `ChannelRefunded` log, else its record) and never sent
 * again. A piece's index advances only once the previous piece is booked
 * landed, so a re-send after a wrong "dropped" verdict reuses the same id. On top of
 * that backstop the backend still avoids repeats: each call's refund is
 * piece is recorded (`channel_txs`, one live per call) BEFORE it is sent, its hash
 * recorded before the broadcast, and a retry first reads that hash back:
 * landed → booked from it; mined without refunding, never broadcast, or
 * dropped (the sender's confirmed nonce passed it with no receipt) → sent
 * again; anything else → nothing is sent ("retried").
 *
 * Booking stays with the caller (`PaymentIntentService.refundHeldForDispute`,
 * or the blocked-provider pass): this only moves the money and says what
 * happened.
 */
@Injectable()
export class ChannelRefundService {
  private readonly logger = new Logger(ChannelRefundService.name);

  /** A DROPPED verdict must hold this long before a re-send (M-1). */
  private readonly drops: DropWatch;

  constructor(
    private readonly channels: VoucherChannelRepository,
    @Inject(CHANNEL_DOOR) private readonly door: ChannelDoorPort,
    @Optional() now?: () => number,
  ) {
    this.drops = new DropWatch(now ?? (() => Date.now()));
  }

  async refund(input: {
    readonly assetId: string;
    readonly channelRowId: string;
    readonly amount: bigint;
    /** The refunded call: at most one refund of it is ever live. */
    readonly intentId: string;
  }): Promise<ChannelRefundOutcome> {
    // One owner per call, across every caller and process (re-review F1): the
    // dispute job and the blocked-provider pass both come through here.
    const owned = await this.channels.withRefundLock(input.intentId, () => this.owned(input));
    return owned ?? { kind: 'NOT_FOUND', reason: 'a refund of this call is in flight' };
  }

  private async owned(input: RefundInput): Promise<ChannelRefundOutcome> {
    const asset = input.assetId as AssetId;
    const channel = await this.channels.findById(input.channelRowId);
    if (!channel) return { kind: 'NOT_FOUND', reason: 'no such channel' };

    // 1. An earlier refund of this call: read it back before anything else.
    const earlier = await this.channels.findLiveRefund(input.intentId);
    if (earlier) {
      const resolved = await this.readBack(asset, channel.channelKey, earlier, input);
      if (resolved !== null) return resolved;
    }

    const ref: ChannelRefInput = {
      payer: checksumAddress(parseAccountId(channel.payer as never).address),
      signer: checksumAddress(parseAccountId(channel.signer as never).address),
      provider: checksumAddress(parseAccountId(channel.providerAccount as never).address),
      channelId: channel.channelId as `0x${string}`,
    };
    // 2. One piece per transaction until the call is refunded in full (MF-1).
    for (let n = 0; n < MAX_PIECES_PER_CALL; n += 1) {
      const done = await this.nextPiece(asset, channel, ref, input);
      if (done !== null) return done;
    }
    return { kind: 'NOT_FOUND', reason: 'partially refunded; the rest is retried' };
  }

  /**
   * Sends the call's next refund piece and resolves it: the final outcome, or
   * `null` when a piece landed and the call is not refunded in full yet.
   */
  private async nextPiece(
    asset: AssetId,
    channel: { id: string; channelKey: string },
    ref: ChannelRefInput,
    input: RefundInput,
  ): Promise<ChannelRefundOutcome | null> {
    const records = await this.channels.refundRecords(input.intentId);
    const { refunded, index, lastTxRef } = progressOf(records);
    const remaining = input.amount - refunded;
    if (remaining <= 0n) return { kind: 'REFUNDED', txRef: lastTxRef ?? 'recorded' };
    const refundId = channelRefundPieceId(input.intentId, index);
    const [books, now] = await Promise.all([
      this.door.readBooks(asset, channel.channelKey as `0x${string}`),
      this.door.chainNow(asset),
    ]);
    if (!books) return { kind: 'NOT_FOUND', reason: 'the escrow has no channel door' };
    const piece = nextRefundPiece(books.slot, remaining, now);
    if (!piece) {
      // The open buckets together hold less than what is left: part of it was
      // paid to the provider, or its window closed.
      const outcome: ChannelRefundOutcome =
        books.slot.h1 + books.slot.h2 < remaining ? { kind: 'COLLECTED' } : { kind: 'TIMED_OUT' };
      // Before a final answer: an earlier send of this piece may have landed
      // after all (and drained the bucket). Its log with this piece's
      // refundId says so (M-1).
      const landing = await this.landing(asset, channel.channelKey, refundId);
      if (landing) {
        const id = await this.channels.insertTx({
          kind: ChannelTxKind.REFUND,
          assetId: input.assetId,
          intentId: input.intentId,
          channelRowIds: [channel.id],
          amount: landing.amount ?? recordedAmount(records, index) ?? remaining,
          pieceIndex: index,
        });
        if (id === null) return { kind: 'NOT_FOUND', reason: 'a refund of this call is in flight' };
        return this.booked(id, channel, input, refunded, {
          amount: landing.amount ?? recordedAmount(records, index) ?? remaining,
          txRef: landing.txRef,
          detail: 'found by refundId',
        });
      }
      if (refunded > 0n) {
        this.logger.error(
          `refund of ${input.intentId}: ${refunded} of ${input.amount} landed in pieces, the rest ` +
            `can no longer be refunded (${outcome.kind}); the reconciler must check this lane`,
        );
      }
      return outcome;
    }

    // Recorded, then sent with its hash recorded before the broadcast.
    const id = await this.channels.insertTx({
      kind: ChannelTxKind.REFUND,
      assetId: input.assetId,
      intentId: input.intentId,
      channelRowIds: [channel.id],
      amount: piece.amount,
      pieceIndex: index,
    });
    if (id === null) return { kind: 'NOT_FOUND', reason: 'a refund of this call is in flight' };
    let result;
    try {
      result = await this.door.refund(
        asset,
        [
          {
            ref,
            maturityHour: piece.maturityHour,
            takeRateBps: piece.takeRateBps,
            amount: piece.amount,
            refundId,
          },
        ],
        {
          beforeBroadcast: async (hash, signed) => {
            await recordSigned(this.channels, hash, signed);
            await this.channels.appendTxRef(id, hash);
          },
        },
      );
    } catch (error) {
      if (channelSendNotSent(error)) {
        await this.channels.finishTx(id, ChannelTxStatus.DROPPED, 'not sent');
      }
      // Otherwise the outcome is unknown: the record stays SENT and the next
      // attempt reads its hash back instead of sending again.
      throw error;
    }
    const found = await this.pieceLanded(
      asset,
      channel.channelKey,
      { index, amount: piece.amount, refundId, records },
      result.refunded,
      result.skipped,
      result.txRef,
      // Another skip (the chain may check the bucket before the id): an
      // earlier send that landed still shows by its log.
      true,
    );
    if (!found) {
      await this.channels.finishTx(
        id,
        ChannelTxStatus.DROPPED,
        `skipped:${result.skipped[0]?.reason ?? '?'}`,
        result.txRef,
      );
      return { kind: 'NOT_FOUND', reason: result.skipped[0]?.reason ?? 'skipped' };
    }
    return this.booked(id, channel, input, refunded, found);
  }

  /**
   * Whether this piece's refund landed, by the transaction's events: its own
   * `ChannelRefunded`; or `AlreadyRefunded` for its id (an earlier send of
   * the same piece landed: booked at what THAT send moved, from its log or
   * its record); or, when `lookUp`, its log found by refundId.
   */
  private async pieceLanded(
    asset: AssetId,
    key: string,
    piece: {
      readonly index: number;
      readonly amount: bigint;
      readonly refundId: `0x${string}`;
      readonly records: readonly ChannelTxRecord[];
      readonly excludeRecordId?: string;
    },
    refundedEvents: RefundResult['refunded'],
    skippedEvents: RefundResult['skipped'],
    answeredBy: string,
    lookUp: boolean,
  ): Promise<{ amount: bigint; txRef: string; detail: string | null } | null> {
    const own = refundedEvents.find((r) => ours(r, key, piece.refundId));
    if (own) return { amount: own.amount ?? piece.amount, txRef: answeredBy, detail: null };
    if (skippedEvents.some((r) => alreadyRefunded(r, key))) {
      const landing = await this.landing(asset, key, piece.refundId);
      const amount =
        landing?.amount ??
        recordedAmount(piece.records, piece.index, piece.excludeRecordId) ??
        piece.amount;
      if (!landing) {
        this.logger.warn(
          `refund piece ${piece.index} (${piece.refundId}): the chain says it was refunded already ` +
            `(${answeredBy}); its landing log was not found within the lookback — booked for the reconciler`,
        );
      }
      return {
        amount,
        txRef: landing?.txRef ?? answeredBy,
        detail: landing ? 'already refunded' : 'already refunded; landing tx not found',
      };
    }
    if (!lookUp) return null;
    const landing = await this.landing(asset, key, piece.refundId);
    return landing
      ? {
          amount: landing.amount ?? piece.amount,
          txRef: landing.txRef,
          detail: 'found by refundId',
        }
      : null;
  }

  /**
   * Books a landed piece on its record: `LANDED` when the call is now refunded
   * in full (its final answer), `PARTIAL` otherwise (`null`: the next piece
   * follows).
   */
  private async booked(
    recordId: string,
    channel: { id: string; channelKey: string },
    input: RefundInput,
    before: bigint,
    landed: { amount: bigint; txRef: string; detail: string | null },
  ): Promise<ChannelRefundOutcome | null> {
    const complete = before + landed.amount >= input.amount;
    await this.channels.finishTx(
      recordId,
      complete ? ChannelTxStatus.LANDED : ChannelTxStatus.PARTIAL,
      landed.detail,
      landed.txRef,
      landed.amount,
    );
    await this.landed(channel.id, channel.channelKey, landed.amount, landed.txRef);
    return complete ? { kind: 'REFUNDED', txRef: landed.txRef } : null;
  }

  /** The `ChannelRefunded` log of `refundId` on lane `key`, if found. */
  private async landing(
    asset: AssetId,
    key: string,
    refundId: `0x${string}`,
  ): Promise<RefundLanding | null> {
    if (typeof this.door.findRefundLanding !== 'function') return null;
    try {
      return await this.door.findRefundLanding(
        asset,
        key as `0x${string}`,
        refundId,
        REFUND_LANDING_LOOKBACK_BLOCKS,
      );
    } catch {
      return null;
    }
  }

  /**
   * What an earlier recorded refund of the call did, or `null` when it did not
   * land and a new one may be sent (it was marked DROPPED).
   */
  private async readBack(
    asset: AssetId,
    key: string,
    earlier: ChannelTxRecord,
    input: RefundInput,
  ): Promise<ChannelRefundOutcome | null> {
    if (earlier.status === ChannelTxStatus.LANDED) {
      return { kind: 'REFUNDED', txRef: earlier.txRefs[earlier.txRefs.length - 1] ?? 'recorded' };
    }
    const age = (Date.now() - earlier.createdAt.getTime()) / 1000;
    if (earlier.txRefs.length === 0) {
      // We hold the call's refund lock, so its earlier owner has finished (or
      // its process died): with no hash recorded, nothing was broadcast — and
      // `appendTxRef` now refuses a hash for a record no longer live (F1).
      await this.channels.finishTx(earlier.id, ChannelTxStatus.DROPPED, 'never broadcast');
      return null;
    }
    let pending = false;
    for (const txRef of earlier.txRefs) {
      const receipt = await this.door.txReceipt(asset, txRef);
      if (receipt.state === 'PENDING') {
        pending = true;
        continue;
      }
      if (receipt.state !== 'MINED') continue;
      const index = earlier.pieceIndex ?? 0;
      const records = await this.channels.refundRecords(input.intentId);
      const before = progressOf(records.filter((r) => r.id !== earlier.id)).refunded;
      const found = receipt.success
        ? await this.pieceLanded(
            asset,
            key,
            {
              index,
              amount: earlier.amount ?? input.amount - before,
              refundId: channelRefundPieceId(input.intentId, index),
              records,
              excludeRecordId: earlier.id,
            },
            receipt.refunded,
            receipt.refundSkipped,
            txRef,
            false,
          )
        : null;
      this.drops.forget(earlier.id);
      if (found) {
        return this.booked(
          earlier.id,
          { id: earlier.channelRowIds[0] ?? '', channelKey: key },
          input,
          before,
          found,
        );
      }
      // Mined and refunded nothing (reverted or skipped): it did not move money.
      await this.channels.finishTx(earlier.id, ChannelTxStatus.DROPPED, 'mined, not refunded');
      return null;
    }
    // Never on a timer (it could still land and refund twice): dropped only
    // once the sender's confirmed nonce is past every recorded hash, none mined.
    const drop = pending
      ? { verdict: 'IN_FLIGHT' as const }
      : await droppedByNonce(this.door, this.channels, asset, earlier.txRefs);
    // The verdict must hold for a wall-time gap (M-1) — a lagging node behind
    // a load balancer catches up within it — and at two different blocks (F2).
    const held = this.drops.confirm(earlier.id, drop.verdict);
    if (drop.verdict === 'DROPPED') {
      const block = await this.door.latestBlock(asset);
      const first = await this.channels.noteDropSeen(earlier.id, block);
      if (block <= first || !held) {
        return { kind: 'NOT_FOUND', reason: 'confirming that an earlier refund was dropped' };
      }
    }
    if (drop.verdict !== 'DROPPED') {
      if (age > STUCK_AFTER_SECONDS) {
        this.logger.warn(
          `refund ${earlier.id} of ${earlier.intentId} unresolved for ${Math.round(age)} s; not re-sent`,
        );
      }
      return { kind: 'NOT_FOUND', reason: 'an earlier refund of this call is unresolved' };
    }
    await this.channels.finishTx(earlier.id, ChannelTxStatus.DROPPED, 'nonce taken, no receipt');
    this.logger.warn(
      `refund ${earlier.id} of ${earlier.intentId}: its nonce was taken by another transaction; sent again`,
    );
    return null;
  }

  private async landed(
    channelRowId: string,
    key: string,
    amount: bigint,
    txRef: string,
  ): Promise<void> {
    // A dispute's money left the bucket: the lane takes no new voucher (v3 §5.5).
    if (channelRowId) {
      await this.channels.setStatus(channelRowId, VoucherChannelStatus.ROTATED, 'DISPUTE_KEPT');
    }
    this.logger.log(`channel ${key}: refunded ${amount} (${txRef})`);
  }
}

/** A `ChannelRefunded` of lane `key` with this call's `refundId` (an older log without one counts). */
function ours(
  refunded: { key: string; refundId?: string },
  key: string,
  refundId: `0x${string}`,
): boolean {
  return (
    refunded.key.toLowerCase() === key.toLowerCase() &&
    (refunded.refundId === undefined || refunded.refundId.toLowerCase() === refundId.toLowerCase())
  );
}

/** A `ChannelRefundSkipped(AlreadyRefunded)` of lane `key`: one refund item per transaction, so ours. */
function alreadyRefunded(skipped: { key: string; reason: string }, key: string): boolean {
  return (
    skipped.key.toLowerCase() === key.toLowerCase() && skipped.reason === REFUND_ALREADY_REFUNDED
  );
}

/**
 * A call's refund progress from its records (MF-1): what its landed pieces
 * (`PARTIAL`, `LANDED`) refunded, the next piece's index, and the last
 * landing's hash. A record without a piece index is piece 0.
 */
function progressOf(records: readonly ChannelTxRecord[]): {
  refunded: bigint;
  index: number;
  lastTxRef: string | null;
} {
  const landed = records.filter(
    (r) => r.status === ChannelTxStatus.PARTIAL || r.status === ChannelTxStatus.LANDED,
  );
  const refunded = landed.reduce((sum, r) => sum + (r.amount ?? 0n), 0n);
  const index = landed.length ? Math.max(...landed.map((r) => r.pieceIndex ?? 0)) + 1 : 0;
  const last = landed[landed.length - 1];
  return { refunded, index, lastTxRef: last?.txRefs[last.txRefs.length - 1] ?? null };
}

/** The amount the newest record of piece `index` (other than `excludeId`) carried, if any. */
function recordedAmount(
  records: readonly ChannelTxRecord[],
  index: number,
  excludeId?: string,
): bigint | null {
  const matching = records.filter((r) => (r.pieceIndex ?? 0) === index && r.id !== excludeId);
  return matching[matching.length - 1]?.amount ?? null;
}
