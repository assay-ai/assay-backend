import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

import { ChainId } from '../ports/caip.types';

/**
 * How many relayer sends paid for by a buyer's request (relayed `*BySig`
 * requests and withdraw gas grants) one chain admits per hour, across EVERY
 * account and organization.
 *
 * The per-account (20) and per-organization (50) limits of
 * `relayed-intent-rate-limit.ts` bound one tenant. They do not bound N tenants,
 * and the relayer holds a float of about 0.001 ETH. 120 sends at the ordinary
 * cost of a `setLimitsBySig` (about 2.3e-6 ETH) is about 2.8e-4 ETH an hour,
 * under a third of the float, and still more than twice what one busy
 * organization may send. Slash sends are not counted: they are the platform's
 * own, and the float is kept for them.
 */
export const EVM_RELAYER_HOURLY_SEND_BUDGET = 120;

/** DI token: the {@link EvmRelayerHourlyBudget}, or `null` in a process without Redis. */
export const EVM_RELAYER_HOURLY_BUDGET = 'EVM_RELAYER_HOURLY_BUDGET';

/** The window of {@link EVM_RELAYER_HOURLY_SEND_BUDGET}. */
export const EVM_RELAYER_HOURLY_WINDOW_SECONDS = 3600;

/** `assay:evm-relayer-hourly:<chainId>`: a sorted set of admitted sends, scored by instant. */
export const EVM_RELAYER_HOURLY_KEY_PREFIX = 'assay:evm-relayer-hourly';

export function relayerHourlyKey(chainId: ChainId): string {
  return `${EVM_RELAYER_HOURLY_KEY_PREFIX}:${chainId}`;
}

/**
 * Count-and-admit in one step, so two replicas cannot both take the last slot.
 * Only ADMITTED sends are recorded. A global ceiling that also counted refused
 * attempts could be held shut for ever by one caller who keeps asking, which
 * would lock every other buyer out of their brake and their exit.
 */
const TAKE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * The relayer's global hourly send budget, per chain, in Redis.
 *
 * Taken immediately before the send, after every check that can refuse, so
 * a refused request costs nothing from it. It fails CLOSED, as the per-account
 * limiter does: an uncountable budget is not a budget.
 */
export class EvmRelayerHourlyBudget {
  private readonly logger = new Logger(EvmRelayerHourlyBudget.name);

  constructor(
    private readonly cache: CacheService,
    readonly limit: number = EVM_RELAYER_HOURLY_SEND_BUDGET,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Takes one send from the budget. `false`: over budget, or the count could not be made. */
  async take(chainId: ChainId, purpose: string): Promise<boolean> {
    const now = this.now();
    try {
      const taken = await withRedisTimeout(() =>
        this.cache
          .getRedisClient()
          .eval(
            TAKE_SCRIPT,
            1,
            relayerHourlyKey(chainId),
            String(now),
            String(EVM_RELAYER_HOURLY_WINDOW_SECONDS * 1000),
            String(this.limit),
            `${now}:${randomUUID()}`,
          ),
      );
      if (Number(taken) === 1) return true;
      this.logger.warn(
        `the relayer's hourly budget of ${this.limit} sends on ${chainId} is spent; ${purpose} refused`,
      );
      return false;
    } catch (error) {
      this.logger.error(
        `the relayer's hourly budget on ${chainId} could not be counted; ${purpose} refused. ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }
}
