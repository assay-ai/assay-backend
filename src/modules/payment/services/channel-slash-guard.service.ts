import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { CHANNEL_LIVE_CHAINS } from '../constants/channel.constants';

/** How long a proposal waits for the provider's channels before it goes ahead anyway. */
export const SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS = 1_800;

/** Thrown to put a slash proposal back for its next pass (a TRANSIENT failure there). */
export class ChannelsSettlingBeforeSlashError extends Error {
  constructor(readonly channels: number) {
    super(`${channels} payment channel(s) of the provider are still settling; the slash waits`);
    this.name = 'ChannelsSettlingBeforeSlashError';
  }
}

/**
 * Settle a provider's channels before its slash is proposed (v3 §5.4.7). A
 * proposal reserves the provider's stake at once; a channel settlement after
 * it would be skipped `Stake`, and the buyers' served calls would lapse. So the
 * proposal first asks for an urgent round on every channel of that provider
 * and, while any still holds unsettled value, is put back
 * ({@link ChannelsSettlingBeforeSlashError}, retried by the slash pass) — for at
 * most {@link SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS}, after which it goes ahead
 * and pages: compensation for the harmed buyers is never held back for good.
 *
 * The request is in the DB (the scheduler acts on it) and the first deferral in
 * Redis, so it runs in whichever process proposes and survives a restart. It
 * runs whatever the live flag says: a provider with no unsettled channel on
 * the chain passes at once.
 */
@Injectable()
export class ChannelSlashGuard {
  private readonly logger = new Logger(ChannelSlashGuard.name);
  /** Fallback when Redis is absent or unreachable: proposal id → first wait (ms). */
  private readonly waitingSince = new Map<string, number>();

  constructor(
    private readonly channels: VoucherChannelRepository,
    // Kept for the DI signature; no longer a gate (ops F8).
    @Optional()
    @Inject(CHANNEL_LIVE_CHAINS)
    readonly liveChains: ReadonlySet<string> = new Set(),
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
    // The first deferral is kept in Redis, so a restart does not start the wait again.
    @Optional() private readonly cache: CacheService | null = null,
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  /** When this proposal first waited (ms), recording `now` when it has not yet. */
  private async firstWait(proposalId: string): Promise<number> {
    const key = slashWaitKey(proposalId);
    if (this.cache) {
      try {
        const stored = await this.cache.get<number | string>(key);
        if (stored !== null && Number.isFinite(Number(stored))) return Number(stored);
        const at = this.now();
        await this.cache.set(key, String(at), SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS * 4);
        return at;
      } catch (error) {
        this.logger.warn(`slash wait of ${proposalId} not persisted: ${describe(error)}`);
      }
    }
    const at = this.waitingSince.get(proposalId) ?? this.now();
    this.waitingSince.set(proposalId, at);
    return at;
  }

  private async forget(proposalId: string): Promise<void> {
    this.waitingSince.delete(proposalId);
    await this.cache?.del(slashWaitKey(proposalId)).catch(() => undefined);
  }

  async beforePropose(input: {
    proposalId: string;
    providerId: string;
    chainId: string;
  }): Promise<void> {
    // Not gated on `EVM_CHANNELS_LIVE_CHAINS` (final review ops F8): the flag
    // gates NEW admission only, and existing channels keep settling with it
    // off. A chain with no channel of the provider answers 0 below.
    const unsettled = await this.channels.requestProviderSettle(
      input.providerId,
      input.chainId,
      'SLASH',
    );
    if (unsettled === 0) {
      await this.forget(input.proposalId);
      return;
    }
    const since = await this.firstWait(input.proposalId);
    if (this.now() - since < SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS * 1000) {
      throw new ChannelsSettlingBeforeSlashError(unsettled);
    }
    await this.forget(input.proposalId);
    this.logger.error(
      `slash ${input.proposalId}: ${unsettled} channel(s) of ${input.providerId} still unsettled ` +
        `after ${SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS}s; proposing anyway`,
    );
    await this.alerts
      ?.emit({
        severity: AlertSeverity.CRITICAL,
        name: 'channel_slash_before_settle',
        summary:
          `Slash ${input.proposalId} proposed while ${unsettled} payment channel(s) of the provider ` +
          `were still unsettled: their settlement will be skipped (Stake) and the calls lapse.`,
        details: {
          proposalId: input.proposalId,
          providerId: input.providerId,
          channels: unsettled,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: input.proposalId,
      })
      .catch(() => undefined);
  }
}

/** The Redis key of a proposal's first deferral. */
export function slashWaitKey(proposalId: string): string {
  return `assay:channel-slash-wait:${proposalId}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
