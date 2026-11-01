import { Inject, Injectable, Optional } from '@nestjs/common';

import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { CHANNEL_DOOR, ChannelDoorPort } from '@modules/payment/ports/channel-door.port';

import { OperatorErrors } from '../errors/operator.errors';

import { OperatorSession } from '../ports/operator-session.port';
import { OverrideLogService } from './override-log.service';

export interface ClaimUnpaidInput {
  readonly assetId: string;
  /** The payout address (0x hex) the escrow set money aside for. */
  readonly address: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly ticketRef?: string | null;
}

export interface ClearReconcileInput {
  /** The `voucher_channels` row the reconciler stopped. */
  readonly channelRowId: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly ticketRef?: string | null;
}

/** One lane the reconciler stopped, as `GET /operator/channels/stopped` lists it. */
export interface StoppedChannel {
  /** The `voucher_channels` row id: what `POST /operator/channels/clear-reconcile` takes. */
  readonly channelRowId: string;
  readonly channelKey: string;
  readonly chainId: string;
  readonly assetId: string;
  readonly providerId: string;
  /** The payer's CAIP-10 account. */
  readonly payer: string;
  /**
   * ISO-8601. When the lane row last changed, which the stop sets: the stop
   * itself unless a settlement already in flight landed on it afterwards.
   */
  readonly stoppedAt: string;
  /** `voucher_channels.status_reason`: `RECONCILE` (a reconciler stop). */
  readonly reason: string;
  /** Atomic decimal strings: what the platform accepted and booked as settled on the lane. */
  readonly accepted: string;
  readonly settled: string;
}

export interface DrainChannelsInput {
  readonly assetId: string | null;
  readonly reasonCode: string;
  readonly note: string;
  readonly ticketRef?: string | null;
}

/**
 * Override `M-2`: settle every pending payment channel now (v3 §5.4.9 — before
 * a redeemer rotation, a take-rate change or a domain-changing upgrade). Marks
 * each channel with value to settle for an urgent round the scheduler runs on
 * its next tick, past every rate limit and fee-spike postponement; nothing is
 * sent from here. The mark and its register entry commit together.
 * Idempotent: a second drain while the first is pending marks the same
 * channels again and changes nothing else.
 */
@Injectable()
export class OperatorChannelDrainService {
  constructor(
    private readonly overrides: OverrideLogService,
    private readonly channels: VoucherChannelRepository,
    // Re-checks chain vs database before `M-4` clears a stop. Absent (a
    // harness without chains): the operator's investigation stands alone.
    @Optional() @Inject(CHANNEL_DOOR) private readonly door: ChannelDoorPort | null = null,
  ) {}

  /**
   * The lanes the reconciler stopped (DESYNC / RECONCILE) and nobody cleared
   * yet, newest first. Read only: the operator card behind override `M-4`.
   */
  async listStopped(limit = 200): Promise<StoppedChannel[]> {
    const lanes = await this.channels.listReconcileStopped(limit);
    return lanes.map((lane) => ({
      channelRowId: lane.id,
      channelKey: lane.channelKey,
      chainId: lane.chainId,
      assetId: lane.assetId,
      providerId: lane.providerId,
      payer: lane.payer,
      stoppedAt: lane.updatedAt.toISOString(),
      reason: lane.statusReason ?? 'RECONCILE',
      accepted: String(lane.lastAcceptedCumulative),
      settled: String(lane.settledCumulative),
    }));
  }

  /**
   * Override `M-4` (final review 2026-11-01 backend F1 / ops F3): clears a
   * reconciler stop after an investigation. Only a lane in DESYNC with reason
   * RECONCILE, and only while the chain's settled value sits between what the
   * database booked as settled and what it accepted (the breach no longer
   * holds). The lane goes back to ROTATED, never OPEN: it takes no new
   * voucher, and the value already signed on it settles again. The change and
   * its register entry commit together; nothing is sent from here.
   */
  async clearReconcile(
    operator: OperatorSession,
    input: ClearReconcileInput,
    requestId: string | null,
  ): Promise<{ channelRowId: string; status: 'ROTATED' }> {
    const refuse = (detail: string) =>
      OperatorErrors.channelClearRefused({ detail, channelRowId: input.channelRowId });
    const lane = await this.channels.findById(input.channelRowId);
    if (!lane) throw refuse('no such channel');
    if (lane.status !== 'DESYNC' || lane.statusReason !== 'RECONCILE') {
      throw refuse(
        `the channel is ${lane.status}/${lane.statusReason ?? '-'}, not DESYNC/RECONCILE`,
      );
    }
    const accepted = BigInt(lane.lastAcceptedCumulative);
    const settled = BigInt(lane.settledCumulative);
    if (this.door) {
      let books;
      try {
        books = await this.door.readBooks(
          lane.assetId as AssetId,
          lane.channelKey as `0x${string}`,
        );
      } catch {
        throw refuse('the chain could not be read; try again');
      }
      if (!books) throw refuse('the escrow has no channel door');
      const chainSettled = books.slot.settled;
      if (chainSettled > accepted || chainSettled < settled) {
        throw refuse(
          `the chain still settled ${chainSettled}, outside booked ${settled} .. accepted ${accepted}`,
        );
      }
    }
    return this.overrides.perform(
      {
        code: 'M-4',
        actor: operator,
        targetType: 'voucher_channel',
        targetId: input.channelRowId,
        organizationId: null,
        reasonCode: input.reasonCode,
        reason: input.note,
        ticketRef: input.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const cleared = await this.channels.clearReconcile(queryRunner.manager, input.channelRowId);
        if (!cleared) throw refuse('the channel changed meanwhile');
        return {
          value: { channelRowId: input.channelRowId, status: 'ROTATED' as const },
          before: {
            status: 'DESYNC',
            statusReason: 'RECONCILE',
            settled: settled.toString(),
            accepted: accepted.toString(),
          },
          after: { status: 'ROTATED', statusReason: 'RECONCILE_CLEARED' },
        };
      },
    );
  }

  async drain(
    operator: OperatorSession,
    input: DrainChannelsInput,
    requestId: string | null,
  ): Promise<{ assetId: string | null; channels: number }> {
    return this.overrides.perform(
      {
        code: 'M-2',
        actor: operator,
        targetType: 'channel_drain',
        targetId: input.assetId ?? 'all',
        organizationId: null,
        reasonCode: input.reasonCode,
        reason: input.note,
        ticketRef: input.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const marked = await this.channels.requestDrain(queryRunner.manager, input.assetId);
        return {
          value: { assetId: input.assetId, channels: marked },
          before: { state: 'PENDING_SETTLEMENT', assetId: input.assetId },
          after: { state: 'DRAIN_REQUESTED', assetId: input.assetId, channels: marked },
        };
      },
    );
  }

  /**
   * Override `M-3`: asks the scheduler to claim an address's unpaid channel
   * payouts (`claimUnpaid`, review 2026-10-31 M4). Nothing is sent from here
   * (the API process holds no redeemer key); the mark and its register entry
   * commit together. Idempotent.
   */
  async claimUnpaid(
    operator: OperatorSession,
    input: ClaimUnpaidInput,
    requestId: string | null,
  ): Promise<{ assetId: string; address: string; payouts: number }> {
    return this.overrides.perform(
      {
        code: 'M-3',
        actor: operator,
        targetType: 'channel_unpaid',
        targetId: `${input.assetId}:${input.address.toLowerCase()}`,
        organizationId: null,
        reasonCode: input.reasonCode,
        reason: input.note,
        ticketRef: input.ticketRef ?? null,
        requestId,
      },
      async (queryRunner) => {
        const marked = await this.channels.requestClaim(
          queryRunner.manager,
          input.assetId,
          input.address,
        );
        return {
          value: { assetId: input.assetId, address: input.address.toLowerCase(), payouts: marked },
          before: { state: 'UNPAID', assetId: input.assetId, address: input.address.toLowerCase() },
          after: {
            state: 'CLAIM_REQUESTED',
            assetId: input.assetId,
            address: input.address.toLowerCase(),
            payouts: marked,
          },
        };
      },
    );
  }
}
