import { randomUUID } from 'node:crypto';

import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { withRedisTimeout } from '@shared/cache/redis-cache/with-redis-timeout';

import { ChainErrors } from '../errors/chains.errors';

/** The window every hourly wei budget counts over. */
export const EVM_HOURLY_WEI_WINDOW_SECONDS = 3600;

/** One counter a charge was written to, and the wei written there. */
export interface EvmWeiBudgetPart {
  readonly key: string;
  readonly member: string;
  readonly wei: bigint;
}

/**
 * What one admitted send was charged, so the charge can be replaced by what the
 * send actually cost once its receipt is in ({@link EvmHourlyWeiWindow.settle}).
 * One part per counter the charge was written to: the first is the whole
 * charge (the global counter), any further part a share of it (a provider's
 * or an account's), each settled in proportion.
 */
export interface EvmWeiBudgetTicket {
  readonly parts: readonly EvmWeiBudgetPart[];
  /** The Redis server's instant, in ms, the charge was admitted at. */
  readonly score: number;
}

/** One counter a charge must fit: `wei` more must keep its hour within `limit`. */
export interface EvmWeiBudgetEntry {
  readonly key: string;
  readonly wei: bigint;
  readonly limit: bigint;
}

/**
 * What {@link EvmHourlyWeiWindow.takeAll} answered: admitted with its ticket,
 * or refused with each entry that did not fit (its index into the request) and
 * how long until enough of that counter's hour leaves the window for the same
 * charge to fit (`retryAfterMs`; the whole window when it never can).
 */
export interface EvmWeiBudgetAnswer {
  readonly admitted: boolean;
  /** Set when admitted. */
  readonly ticket: EvmWeiBudgetTicket | null;
  /** Empty when admitted. */
  readonly refused: readonly { readonly index: number; readonly retryAfterMs: number }[];
}

/**
 * Sum-and-admit over every counter of a charge in one step, so two replicas
 * cannot both take the last wei of any of them.
 *
 * Each admitted send is one member of a sorted set per counter, scored by its
 * instant and named `<instant>:<id>:<wei>`; the wei is read back from the name.
 * The instant is the REDIS SERVER's (`TIME`, review 2026-10-30 M-3), never an
 * app host's: two replicas whose clocks disagree would otherwise trim and score
 * one window differently. `TIME` before a write is safe under the effects
 * replication every supported Redis uses for scripts.
 *
 * Every counter is checked before any is written: one refusal admits nothing.
 * For a refused counter the script also walks its members oldest first to the
 * one whose leaving frees enough room, and answers when that happens.
 *
 * Lua numbers are doubles, exact to 2^53 wei (about 0.009 ETH): every budget
 * here is a small fraction of that, and an error of a few wei above it would
 * not matter. Only ADMITTED sends are recorded, for the reason the count-based
 * budget gave: a ceiling that counted refusals could be held shut by one
 * caller asking.
 *
 * `ARGV`: window ms, id, then `wei, limit` per key. Answers `{1, now}` or
 * `{0, index, retryAfterMs, index, retryAfterMs, ...}` (1-based indexes).
 */
const TAKE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local window = tonumber(ARGV[1])
local refused = {}
for i, key in ipairs(KEYS) do
  local wei = tonumber(ARGV[1 + 2 * i])
  local limit = tonumber(ARGV[2 + 2 * i])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  local members = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local total = 0
  for j = 1, #members, 2 do
    local each = string.match(members[j], ':(%d+)$')
    if each then total = total + tonumber(each) end
  end
  if total + wei > limit then
    local need = total + wei - limit
    local freed = 0
    local at = window
    if wei <= limit then
      for j = 1, #members, 2 do
        local each = string.match(members[j], ':(%d+)$')
        if each then freed = freed + tonumber(each) end
        if freed >= need then
          at = tonumber(members[j + 1]) + window - now
          break
        end
      end
    end
    table.insert(refused, i)
    table.insert(refused, at)
  end
end
if #refused > 0 then
  table.insert(refused, 1, 0)
  return refused
end
for i, key in ipairs(KEYS) do
  redis.call('ZADD', key, now, now .. ':' .. ARGV[2] .. ':' .. ARGV[1 + 2 * i])
  redis.call('PEXPIRE', key, window)
end
return {1, now}
`;

/**
 * Replaces admitted charges with the actual cost, at the same instant: per key,
 * `ARGV` holds the old member then the new one, after the score. A member
 * already gone (it left the window) is left gone.
 */
const SETTLE_SCRIPT = `
for i, key in ipairs(KEYS) do
  local old = ARGV[2 * i]
  if redis.call('ZSCORE', key, old) then
    redis.call('ZREM', key, old)
    redis.call('ZADD', key, ARGV[1], ARGV[2 * i + 1])
  end
end
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
  constructor(private readonly cache: CacheService) {}

  /** Charges `wei` to `key` if the hour's sum stays within `limit`; `null` when it would not. */
  async take(key: string, wei: bigint, limit: bigint): Promise<EvmWeiBudgetTicket | null> {
    const answer = await this.takeAll([{ key, wei, limit }]);
    return answer.admitted ? answer.ticket : null;
  }

  /**
   * Charges every entry at once, or none: each `entries[i].wei` to its key,
   * if every key's hour stays within its own limit. The first entry is the
   * charge {@link settle} scales the others by.
   */
  async takeAll(entries: readonly EvmWeiBudgetEntry[]): Promise<EvmWeiBudgetAnswer> {
    const id = randomUUID();
    const clamped = entries.map((entry) => ({ ...entry, wei: entry.wei < 0n ? 0n : entry.wei }));
    const raw = (await withRedisTimeout(() =>
      this.cache
        .getRedisClient()
        .eval(
          TAKE_SCRIPT,
          clamped.length,
          ...clamped.map((entry) => entry.key),
          String(EVM_HOURLY_WEI_WINDOW_SECONDS * 1000),
          id,
          ...clamped.flatMap((entry) => [String(entry.wei), String(entry.limit)]),
        ),
    )) as unknown[];
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error(`the hourly wei budget script answered ${JSON.stringify(raw)}`);
    }
    if (Number(raw[0]) === 1) {
      const now = Number(raw[1]);
      return {
        admitted: true,
        refused: [],
        ticket: {
          score: now,
          parts: clamped.map((entry) => ({
            key: entry.key,
            member: `${now}:${id}:${entry.wei}`,
            wei: entry.wei,
          })),
        },
      };
    }
    const refused: { index: number; retryAfterMs: number }[] = [];
    for (let i = 1; i + 1 < raw.length; i += 2) {
      refused.push({ index: Number(raw[i]) - 1, retryAfterMs: Math.max(0, Number(raw[i + 1])) });
    }
    return { admitted: false, ticket: null, refused };
  }

  /**
   * The charge of `ticket` becomes `actualWei`, and each further part the same
   * proportion of it. Best effort: never throws.
   */
  async settle(ticket: EvmWeiBudgetTicket, actualWei: bigint): Promise<void> {
    const actual = actualWei < 0n ? 0n : actualWei;
    const whole = ticket.parts[0]?.wei ?? 0n;
    const changed = ticket.parts
      .map((part, index) => {
        const wei = index === 0 || whole === 0n ? actual : (actual * part.wei) / whole;
        return { part, replacement: `${part.member.replace(/:\d+$/, '')}:${wei}` };
      })
      .filter(({ part, replacement }) => replacement !== part.member);
    if (changed.length === 0) return;
    try {
      await withRedisTimeout(() =>
        this.cache
          .getRedisClient()
          .eval(
            SETTLE_SCRIPT,
            changed.length,
            ...changed.map(({ part }) => part.key),
            String(ticket.score),
            ...changed.flatMap(({ part, replacement }) => [part.member, replacement]),
          ),
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

/**
 * A share in basis points (1..10,000) from the environment, or `fallback` when
 * unset. Anything else refuses to boot.
 */
export function readBps(raw: string | undefined, fallback: number, variable: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 10_000) {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a whole number of basis points, 1 to 10000',
    });
  }
  return Number(value);
}

/** `limit × bps / 10,000`: a share of a budget. */
export function shareOf(limit: bigint, bps: number): bigint {
  return (limit * BigInt(bps)) / 10_000n;
}

/**
 * What a mined send cost, from its receipt: `gasUsed × effectiveGasPrice`
 * (review 2026-10-30 M-2; a Nitro receipt carries the price it was charged,
 * which is not the basefee read before the send). `fallbackFee` stands in only
 * for a receipt with no price. `null` when neither is known: the estimate
 * stays charged.
 */
export function receiptCostWei(
  receipt: { readonly gasUsed?: bigint; readonly effectiveGasPrice?: bigint | null },
  fallbackFee: bigint | null,
): bigint | null {
  if (typeof receipt.gasUsed !== 'bigint') return null;
  const price =
    typeof receipt.effectiveGasPrice === 'bigint' ? receipt.effectiveGasPrice : fallbackFee;
  return price === null ? null : receipt.gasUsed * price;
}
