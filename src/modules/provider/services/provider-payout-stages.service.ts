import { Inject, Injectable, Optional } from '@nestjs/common';

import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import {
  CHANNEL_POLICY,
  channelPolicyFromEnv,
  settleBoundSeconds,
} from '@modules/payment/constants/channel.constants';
import {
  COLLECT_GATHERING,
  COLLECT_GATHERING_FROM_ENV,
  GatheringPolicy,
  REDEEM_GATHERING,
  REDEEM_GATHERING_FROM_ENV,
} from '@modules/payment/constants/settlement-gathering.constants';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import {
  ChannelPolicy,
  DEFAULT_PAYOUT_CADENCE,
  nextPayoutAtByDoor,
  PAYOUT_CADENCES,
  PayoutCadence,
} from '@modules/payment/domain/channel/channel-policy';
import { Money } from '@modules/chains/ports/money.types';

import { ProviderErrors } from '../errors/provider.errors';

export interface PayoutCadenceView {
  readonly cadence: PayoutCadence;
  readonly options: readonly PayoutCadence[];
  readonly hourlyMinimum: Money | null;
  readonly changedAt: string | null;
  readonly nextPayoutAt: string | null;
}

/** The four payout stages of SPEC-W2 §11 (API-W2 §3.2), current state. */
export interface PayoutStagesView {
  readonly awaitingSettlement: Money | null;
  readonly awaitingSettlementCalls: number;
  readonly nextSettleAt: string | null;
  readonly inDisputeHold: Money | null;
  readonly inDisputeHoldCalls: number;
  readonly disputeHoldEndsAt: string | null;
  readonly readyForPayout: Money | null;
  readonly readyForPayoutCalls: number;
  readonly nextPayoutAt: string | null;
  readonly payoutCadence: PayoutCadence;
  /**
   * Paid out on chain but set aside by the escrow because the token refused
   * the transfer (an issuer freeze): NOT in the provider's wallet until it is
   * claimed (review 2026-10-31 M4). `null` with nothing unpaid.
   */
  readonly unpaid: Money | null;
  readonly unpaidSince: string | null;
  /**
   * The unpaid payouts per asset, EVERY asset whatever `asset` asked for
   * (frontend L-6), so a block on another asset is never hidden. Empty with
   * nothing unpaid.
   */
  readonly unpaidByAsset: ReadonlyArray<{ readonly amount: Money; readonly since: string | null }>;
}

/**
 * The provider's payout cadence (SPEC-W2 §8) and where its money is between
 * "passed" and "in your wallet" (§11). Applies to per-call holds and idle
 * channels; active channels are collected before every settle.
 *
 * ETAs are upper bounds from the scheduler constants, never promises the
 * scheduler does not keep: settle by the oldest call's age trigger, the hold
 * as the API reports it (`collectable_at` — a per-call hold ends exactly
 * `collectHoldSeconds` after redemption, a channel bucket on the next full
 * hour), payout on the cadence grid.
 */
@Injectable()
export class ProviderPayoutStagesService {
  constructor(
    private readonly channels: VoucherChannelRepository,
    @Optional()
    @Inject(CHANNEL_POLICY)
    private readonly policy: ChannelPolicy = channelPolicyFromEnv(),
    @Optional() private readonly now: () => number = () => Date.now(),
    // The per-call collect's gathering rule: its maximum wait bounds the ETA.
    @Optional()
    @Inject(COLLECT_GATHERING)
    private readonly gathering: GatheringPolicy = COLLECT_GATHERING_FROM_ENV,
    // The per-call redemption's maximum wait, as configured (e2e B-2).
    @Optional()
    @Inject(REDEEM_GATHERING)
    private readonly redeemGathering: GatheringPolicy = REDEEM_GATHERING_FROM_ENV,
  ) {}

  /**
   * The next payout over both doors, never before the earliest hold end
   * (review 2026-10-31 M2). An estimate from the scheduler rules, an upper
   * bound for the per-call door (64 items or its maximum wait).
   */
  private nextPayout(
    cadence: PayoutCadence,
    stages: Awaited<ReturnType<VoucherChannelRepository['providerStages']>>,
  ): string | null {
    const seconds = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
    const at = nextPayoutAtByDoor(
      cadence,
      {
        perCall: {
          ready: stages.doors.perCall.ready,
          oldestReadyAt: seconds(stages.doors.perCall.oldestReadyAt),
          holdEndsAt: seconds(stages.doors.perCall.holdEndsAt),
        },
        channel: {
          ready: stages.doors.channel.ready,
          holdEndsAt: seconds(stages.doors.channel.holdEndsAt),
          active: stages.doors.channel.active,
        },
      },
      this.nowSeconds(),
      this.policy.hourlyPayoutMinimumAtomic,
      this.gathering.maxWaitSeconds,
      this.policy.tickSeconds,
    );
    return at === null ? null : iso(at);
  }

  async getCadence(providerId: string, asset?: string | null): Promise<PayoutCadenceView> {
    const row = (await this.channels.cadenceOf([providerId])).get(providerId);
    const cadence = (row?.cadence ?? DEFAULT_PAYOUT_CADENCE) as PayoutCadence;
    const stages = await this.channels.providerStages(providerId, asset ?? null);
    const assetId = asset ?? stages.assets[0] ?? null;
    return {
      cadence,
      options: PAYOUT_CADENCES,
      hourlyMinimum: assetId ? this.money(this.policy.hourlyPayoutMinimumAtomic, assetId) : null,
      changedAt: row?.changedAt ? new Date(row.changedAt).toISOString() : null,
      nextPayoutAt: this.nextPayout(cadence, stages),
    };
  }

  async setCadence(providerId: string, cadence: string): Promise<PayoutCadenceView> {
    if (!(PAYOUT_CADENCES as readonly string[]).includes(cadence)) {
      throw ProviderErrors.payoutCadenceInvalid({ options: [...PAYOUT_CADENCES] });
    }
    if (!(await this.channels.setCadence(providerId, cadence))) {
      throw ProviderErrors.providerNotFound({ providerId });
    }
    return this.getCadence(providerId);
  }

  async stages(providerId: string, asset: string | null): Promise<PayoutStagesView> {
    const [stages, cadenceRow, unpaid, unpaidByAsset] = await Promise.all([
      this.channels.providerStages(providerId, asset),
      this.channels.cadenceOf([providerId]),
      this.channels
        .unpaidOf(providerId, asset)
        .catch(() => ({ amount: 0n, since: null as Date | null })),
      (this.channels.unpaidByAsset?.(providerId) ?? Promise.resolve([])).catch(
        () => [] as Array<{ assetId: string; amount: bigint; since: Date | null }>,
      ),
    ]);
    const cadence = (cadenceRow.get(providerId)?.cadence ??
      DEFAULT_PAYOUT_CADENCE) as PayoutCadence;
    // One asset only, like the windowed figures: several and none named is `null`.
    const assetId = asset ?? (stages.assets.length === 1 ? stages.assets[0] : null);
    const money = (atomic: bigint) => (assetId ? this.money(atomic, assetId) : null);
    // Unpaid on exactly one asset, none named: that asset's figure, never a hidden `null`.
    const unpaidAsset =
      assetId ?? (asset === null && unpaidByAsset.length === 1 ? unpaidByAsset[0].assetId : null);
    const now = this.nowSeconds();
    return {
      awaitingSettlement: money(stages.awaiting.amount),
      awaitingSettlementCalls: stages.awaiting.calls,
      // The age trigger's bound, or the per-call door's maximum wait.
      nextSettleAt: stages.awaiting.oldest
        ? iso(
            Math.max(
              now,
              Math.floor(stages.awaiting.oldest.getTime() / 1000) +
                settleBoundSeconds(this.policy.tAgeSeconds, this.redeemGathering.maxWaitSeconds),
            ),
          )
        : null,
      inDisputeHold: money(stages.inHold.amount),
      inDisputeHoldCalls: stages.inHold.calls,
      disputeHoldEndsAt: stages.inHold.endsAt ? stages.inHold.endsAt.toISOString() : null,
      readyForPayout: money(stages.ready.amount),
      readyForPayoutCalls: stages.ready.calls,
      nextPayoutAt: this.nextPayout(cadence, stages),
      payoutCadence: cadence,
      unpaid: unpaid.amount > 0n && unpaidAsset ? this.money(unpaid.amount, unpaidAsset) : null,
      unpaidSince: unpaid.amount > 0n && unpaid.since ? unpaid.since.toISOString() : null,
      unpaidByAsset: unpaidByAsset.map((row) => ({
        amount: this.money(row.amount, row.assetId),
        since: row.since ? row.since.toISOString() : null,
      })),
    };
  }

  private money(atomic: bigint, asset: string): Money {
    let decimals = 6;
    try {
      decimals = getAssetMetadata(asset as AssetId).decimals;
    } catch {
      // An asset this build does not list: the settlement assets are all 6.
    }
    return { amount: atomic.toString(), asset: asset as AssetId, decimals };
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
