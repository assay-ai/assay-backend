import { randomUUID } from 'node:crypto';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

import { ChainErrors } from '../errors/chains.errors';

/** The window every hourly wei budget counts over. */
export const EVM_HOURLY_WEI_WINDOW_SECONDS = 3600;

/**
 * What one admitted send was charged, so the charge can be replaced by what the
 * send actually cost once its receipt is in ({@link EvmHourlyWeiWindow.settle}).
 */
export interface EvmWeiBudgetTicket {
  readonly key: string;
  readonly member: string;
  readonly score: number;
}

/**
 * Sum-and-admit in one step, so two replicas cannot both take the last wei.
 *
 * Each admitted send is one member of a sorted set, scored by its instant and
 * named `<instant>:<uuid>:<wei>`; the wei is read back from the name. Lua
 * numbers are doubles, exact to 2^53 wei (about 0.009 ETH): every budget here is
 * a small fraction of that, and an error of a few wei above it would not matter.
 * Only ADMITTED sends are recorded, for the reason the count-based budget gave:
 * a ceiling that counted refusals could be held shut by one caller asking.
 */
const TAKE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local total = 0
for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local wei = string.match(member, ':(%d+)$')
  if wei then total = total + tonumber(wei) end
end
if total + tonumber(ARGV[3]) > tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * Replaces an admitted charge with the actual cost, at the same instant. A
 * member already gone (it left the window) is left gone.
 */
const SETTLE_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return 1
`;

/**
 * A rolling one-hour sum of wei per Redis key: the shared mechanism of the
 * relayer's and the redeemer's hourly spend budgets.
 *
 * The caller charges a send its ESTIMATE when admitting it (`gasLimit × L2
 * basefee`, the most the send can cost on Nitro), and may replace that with the
 * actual cost after the receipt ({@link settle}). It throws on a Redis failure;
 * whether that refuses or admits is the caller's rule.
 */
export class EvmHourlyWeiWindow {
  constructor(
    private readonly cache: CacheService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Charges `wei` to `key` if the hour's sum stays within `limit`; `null` when it would not. */
  async take(key: string, wei: bigint, limit: bigint): Promise<EvmWeiBudgetTicket | null> {
    const now = this.now();
    const member = `${now}:${randomUUID()}:${wei < 0n ? 0n : wei}`;
    const taken = await withRedisTimeout(() =>
      this.cache
        .getRedisClient()
        .eval(
          TAKE_SCRIPT,
          1,
          key,
          String(now),
          String(EVM_HOURLY_WEI_WINDOW_SECONDS * 1000),
          String(wei < 0n ? 0n : wei),
          String(limit),
          member,
        ),
    );
    return Number(taken) === 1 ? { key, member, score: now } : null;
  }

  /** The charge of `ticket` becomes `actualWei`. Best effort: never throws. */
  async settle(ticket: EvmWeiBudgetTicket, actualWei: bigint): Promise<void> {
    const wei = actualWei < 0n ? 0n : actualWei;
    const replacement = `${ticket.member.replace(/:\d+$/, '')}:${wei}`;
    if (replacement === ticket.member) return;
    try {
      await withRedisTimeout(() =>
        this.cache
          .getRedisClient()
          .eval(SETTLE_SCRIPT, 1, ticket.key, ticket.member, String(ticket.score), replacement),
      );
    } catch {
      // The estimate stays charged: an over-count for one hour, never an under-count.
    }
  }
}

/**
 * A whole number of wei from the environment, or `fallback` when unset. A value
 * that is not one refuses to boot rather than leave a budget at a guess.
 */
export function readWeiBudget(raw: string | undefined, fallback: bigint, variable: string): bigint {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a whole number of wei, in decimal',
    });
  }
  return BigInt(raw.trim());
}
