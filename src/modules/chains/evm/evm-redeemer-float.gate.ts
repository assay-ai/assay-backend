import { Inject, Injectable, Logger } from '@nestjs/common';

import { ALERT_PORT, AlertPort, AlertSeverity } from '@shared/alerting';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

import { ChainId, ChainNamespace, namespaceOf } from '../ports/caip.types';
import type { FloatLevel } from './evm-relayer-float.monitor';

/**
 * `assay:evm-redeemer-float-critical:<chainId>` — present while the last pass
 * of `EvmRelayerFloatMonitor` read that chain's REDEEMER float at or below its
 * critical mark.
 */
export const REDEEMER_FLOAT_CRITICAL_KEY_PREFIX = 'assay:evm-redeemer-float-critical';

export function redeemerFloatCriticalKey(chainId: ChainId): string {
  return `${REDEEMER_FLOAT_CRITICAL_KEY_PREFIX}:${chainId}`;
}

/**
 * Three passes of `EVM_RELAYER_FLOAT_CRON` (every five minutes). Every
 * CRITICAL pass refreshes it, so it only runs out when the monitor stops
 * writing — see {@link RedeemerFloatGate} for why that then means "admit".
 */
export const REDEEMER_FLOAT_FLAG_TTL_SECONDS = 15 * 60;

/** How long one process trusts its last read of the flag. */
export const REDEEMER_FLOAT_READ_CACHE_MS = 5_000;

/**
 * The `retryAfter` a refused call carries. A top-up is a human sending ETH, so
 * the wait is minutes, not the seconds a cap-tightening pause takes; a minute
 * keeps an agent's retries from becoming load while it lasts.
 */
export const PAID_CALLS_PAUSED_RETRY_AFTER_SECONDS = 60;

export const REDEEMER_FLOAT_GATE_ALERTS = {
  PAUSED: 'paid_calls_paused_redeemer_float',
  RESUMED: 'paid_calls_resumed_redeemer_float',
} as const;

interface CachedRead {
  readonly paused: boolean;
  readonly until: number;
}

/**
 * Paid-call admission, closed while the redeemer cannot pay for redemptions.
 *
 * ## The incident
 *
 * On 2026-10-29 the redeemer EOA ran out of ETH. The monitor paged CRITICAL
 * every pass for ten hours into a log nobody read, and the API kept admitting
 * paid calls whose vouchers could never be redeemed: they expired and became
 * buyer debt. A served call nobody can collect is the one outcome the platform
 * cannot undo, so admission now reads the float the monitor already measures.
 *
 * ## Two processes, one flag
 *
 * The monitor runs in the scheduler; admission runs in the api and mcp
 * replicas. The scheduler {@link publish}es one Redis key per eip155 chain and
 * every replica reads it ({@link isPaused}) — the same shape as the access
 * epoch counters, with no broadcast to lose.
 *
 * ## Fail open, on purpose, three ways
 *
 * A missing key, an expired key and an unreadable Redis all read as "not
 * critical". The flag is a brake on one failure (a dry redeemer), and a brake
 * that engages whenever its own plumbing fails would turn every scheduler
 * restart or Redis blip into a payments outage. So the key carries a TTL of
 * {@link REDEEMER_FLOAT_FLAG_TTL_SECONDS}: a monitor that dies mid-incident
 * releases the pause within three missed passes rather than holding it
 * forever, and that release is silent — no resume alert fires, because no pass
 * saw the float recover. Only a pass that READS the float decides: CRITICAL
 * sets the flag, OK or LOW clears it, and UNREADABLE or NO_RELAYER leaves it to
 * its TTL — neither is evidence about the balance.
 *
 * ## One alert per transition, not per call
 *
 * The pause and resume alerts are emitted HERE, by the single scheduler, on the
 * Redis transition itself: `SET NX` succeeding is the pause, `DEL` removing a
 * key is the resume. A replica never alerts, so five replicas refusing a
 * thousand calls page once. A scheduler restart mid-incident finds the key set
 * and stays quiet.
 *
 * ## Reads are cached for a few seconds
 *
 * {@link REDEEMER_FLOAT_READ_CACHE_MS} per chain per process, failures
 * included, so a slow Redis costs one bounded wait per window rather than one
 * per call. A pause or resume reaches every replica within that window plus a
 * monitor pass. Solana chains never read Redis: they have no redeemer float
 * here.
 */
@Injectable()
export class RedeemerFloatGate {
  private readonly logger = new Logger(RedeemerFloatGate.name);
  private readonly reads = new Map<ChainId, CachedRead>();

  constructor(
    private readonly cache: CacheService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  // ── The scheduler's half ─────────────────────────────────────────────────

  /**
   * Records one redeemer reading. Never throws: the monitor's next chain must
   * still be read, and a lost write is bounded by the TTL.
   */
  async publish(chainId: ChainId, level: FloatLevel): Promise<void> {
    if (level !== 'CRITICAL' && level !== 'OK' && level !== 'LOW') return;
    const key = redeemerFloatCriticalKey(chainId);
    const redis = this.cache.getRedisClient();
    try {
      if (level === 'CRITICAL') {
        const set = await redis.set(key, '1', 'EX', REDEEMER_FLOAT_FLAG_TTL_SECONDS, 'NX');
        if (set === 'OK') {
          await this.emit({
            severity: AlertSeverity.CRITICAL,
            name: REDEEMER_FLOAT_GATE_ALERTS.PAUSED,
            summary: `New paid calls on ${chainId} are refused until the EVM redeemer is topped up`,
            details: {
              chainId,
              key,
              retryAfterSeconds: PAID_CALLS_PAUSED_RETRY_AFTER_SECONDS,
              flagTtlSeconds: REDEEMER_FLOAT_FLAG_TTL_SECONDS,
              resumes: 'on the first monitor pass that reads the redeemer above its critical mark',
            },
          });
        } else {
          await redis.expire(key, REDEEMER_FLOAT_FLAG_TTL_SECONDS);
        }
        return;
      }
      if ((await redis.del(key)) > 0) {
        await this.emit({
          severity: AlertSeverity.WARN,
          name: REDEEMER_FLOAT_GATE_ALERTS.RESUMED,
          summary: `Paid calls on ${chainId} are admitted again: the EVM redeemer float is above its critical mark`,
          details: { chainId, key, level },
        });
      }
    } catch (error) {
      this.logger.error(
        `the redeemer float flag for ${chainId} was not written (${level}); ` +
          `admission keeps its last state until the flag's TTL. ${describe(error)}`,
      );
    }
  }

  // ── The api and mcp half ─────────────────────────────────────────────────

  /** Whether new paid calls on `chainId` are refused. Never throws. */
  async isPaused(chainId: ChainId): Promise<boolean> {
    if (namespaceOf(chainId) !== ChainNamespace.EIP155) return false;
    const now = Date.now();
    const cached = this.reads.get(chainId);
    if (cached && cached.until > now) return cached.paused;

    let paused = false;
    try {
      const value = await withRedisTimeout(() =>
        this.cache.getRedisClient().get(redeemerFloatCriticalKey(chainId)),
      );
      paused = value !== null;
    } catch (error) {
      this.logger.warn(
        `the redeemer float flag for ${chainId} could not be read; admitting paid calls. ` +
          describe(error),
      );
    }
    if ((cached?.paused ?? false) !== paused) {
      this.logger.warn(
        paused
          ? `paid calls on ${chainId} paused: the redeemer float is critical`
          : `paid calls on ${chainId} admitted again`,
      );
    }
    this.reads.set(chainId, { paused, until: now + REDEEMER_FLOAT_READ_CACHE_MS });
    return paused;
  }

  private async emit(alert: Parameters<AlertPort['emit']>[0]): Promise<void> {
    try {
      await this.alerts.emit(alert);
    } catch (error) {
      this.logger.error(`the alert ${alert.name} failed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
