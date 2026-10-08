import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { CeilingKind } from '../domain/routing';
import { ToolBinding } from '../ports/tool.types';

/** One sorted set per binding, holding the calls inside the current rps window. */
export const BINDING_RPS_KEY_PREFIX = 'tool:binding:rps:';

/** One counter per binding **per UTC day** — the day is part of the key. */
export const BINDING_DAILY_KEY_PREFIX = 'tool:binding:daily:';

/**
 * The rps window. One second, because `max_rps` says "per second".
 *
 * Exported so the test can slide the clock by exactly this rather than by a
 * number that happens to match it today.
 */
export const RPS_WINDOW_MS = 1_000;

/** How much of each declared ceiling is left. `null` where none was declared. */
export interface CeilingHeadroom {
  readonly rps: number | null;
  readonly daily: number | null;
}

/**
 * A provider's self-declared ceilings, enforced by shedding.
 *
 * Ceilings the provider declares itself (maxRps, daily quota, timeout): on
 * hitting a ceiling, shed traffic rather than let their calls fail —
 * a provider says what they can take, and when the platform reaches it the
 * traffic goes somewhere else instead of being pushed at them until it fails.
 *
 * The difference matters to the provider's standing, not just to the agent. A
 * call pushed past a declared ceiling comes back as a 429 or a timeout, which
 * `classifyResponse` records as `SYSTEM_ERROR` against the provider's
 * availability — a strike for honouring the limit they published. Shedding
 * produces `IneligibilityReason.CEILING_REACHED`, which is not an error, not a
 * strike, and not in the quality profile.
 *
 * ```text
 *   gatherCandidates ──▶ readAll()      READ ONLY — nothing spent
 *        │                                 └─ candidate.ceilingHit
 *   filterEligible   ──▶ CEILING_REACHED (pure, synchronous, no Redis)
 *        │
 *   selection        ──▶ consume()      exactly ONE token, one binding
 *        └─ refused? ──▶ shed → failover, same as a filter-time hit
 * ```
 *
 * ## READ and CONSUME are separate operations, and that is the whole design
 *
 * `filterEligible` is pure and synchronous — it is replayed months later to
 * re-explain a routing decision from its recorded inputs — so it cannot reach
 * Redis. The ceiling state therefore arrives on the candidate, read before
 * filtering, and the token is spent afterwards on the single binding that was
 * actually invoked.
 *
 * Collapsing the two into one "check and take" at filter time compiles, passes
 * a shedding test, and is wrong in a way nothing would report: it spends one
 * token per **candidate** per routing decision, so a provider who declared
 * `max_rps: 10` behind a tool with five bindings is really held to two. Note
 * that a check asking only whether traffic sheds would still be green — it
 * never asks at what threshold. `binding-ceiling.spec.ts` asserts the
 * threshold for that reason.
 *
 * ## The race between the read and the consume is ordinary, not an edge case
 *
 * Under load the bucket empties between the two. {@link consume} then returns
 * the same {@link CeilingKind} the filter would have returned, and the caller
 * sheds and fails over exactly as if the ceiling had been hit at filter time.
 * There is nothing to reconcile: both paths end in `CEILING_REACHED`.
 *
 * A refused call is **not** left holding a token — the rps member is removed
 * and a spent daily call is given back. This is a deliberate divergence from
 * `RedisSigningRateLimiter`, which counts refused attempts on purpose: what
 * that class bounds is *attempts* to use a stolen key, so a refusal is
 * evidence. What this class bounds is calls actually delivered to a provider's
 * endpoint, and a refused call was never delivered. Counting it would make a
 * burst of shedding extend the outage past the rate the provider declared, and
 * would leave a daily quota that drains on calls the provider's own logs never
 * saw.
 *
 * ## The daily quota resets on the UTC day. Deliberately, not by omission
 *
 * The day is part of the key — `…:{bindingId}:2026-08-20` — and it is
 * `Date.toISOString()`'s day, never `getDate()`'s. A provider's own timezone
 * is on their `providers` row and it is tempting to use it here; the reason not
 * to is reconciliation. Two providers with the same declared ceiling would
 * otherwise be held to different limits during the same hour, their quotas
 * would roll over at different moments, and a support conversation about "we
 * were cut off at 4pm" would have no shared clock to be had in. Every other
 * daily bucket on this platform already made the same choice for the same
 * reason: `PaymentIntentRepository`'s `CREATED_AT_UTC_DAY` and
 * `provider/services/day-bucket.util.ts` both cast to UTC before grouping.
 *
 * That util is the **SQL** half — it renders a `to_char(... AT TIME ZONE
 * 'UTC')` expression for a query — so it cannot produce a Redis key, and
 * {@link utcDayKey} below is the Redis half of the same rule rather than a
 * second opinion. They are kept apart rather than shared because that one lives
 * in the provider module's services and this is the tool module, which reaches
 * into `@modules/provider` through ports only.
 *
 * ## When Redis cannot answer, this permits
 *
 * The opposite direction from `RedisSigningRateLimiter`, which refuses to sign
 * when its counter is unreadable. That class guards the production of
 * signatures that take money from providers, and failing open would remove the
 * only bound on a stolen key. This one guards a courtesy a provider asked for.
 * Shedding every ceiling-declaring binding on the platform because the shared
 * cache blinked would concentrate all traffic onto the bindings that declared
 * nothing and could take the supply out — an outage caused entirely by us, in
 * the name of a limit that exists to be kind to someone else.
 *
 * What failing open degrades to is precisely how the platform behaved before
 * this class existed: a provider may briefly be sent more than they asked for,
 * their endpoint answers 429, and the router fails over on `SYSTEM_ERROR`. That
 * is a worse outcome than shedding and a far better one than having no supply,
 * and it lasts exactly as long as the Redis incident.
 *
 * ## Why the shared cache client
 *
 * The same argument `BindingCallCounterService` makes next door: a dedicated
 * connection per pod is what the kill switch and the signing limiter buy
 * because their decisions must not be taken down by cache traffic. This
 * decision is documented above as safe to fail open on, so it rides the
 * `@Global` `REDIS_CACHE_CLIENT`.
 */
@Injectable()
export class BindingCeilingService {
  private readonly logger = new Logger(BindingCeilingService.name);

  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis) {}

  /**
   * Which ceiling this binding is currently at, without spending anything.
   *
   * Pure inspection: no `INCR`, no `ZADD`, and no trimming pass either — a
   * `ZREMRANGEBYSCORE` would leave the count unchanged and still make this a
   * write, which is the difference between a read that can be served by a
   * replica and one that cannot. Expired members are trimmed by
   * {@link consume} and by the key's own TTL.
   *
   * **`MAX_DAILY_CALLS` is reported ahead of `MAX_RPS` when both are hit.** The
   * rps ceiling clears within a second and the daily one does not clear until
   * midnight, so naming the transient one sends a provider looking at the wrong
   * dial.
   *
   * A binding that declared neither ceiling issues no Redis command at all.
   * Most bindings are that binding, and a round trip per candidate for a limit
   * nobody set is a cost every routing decision on the platform would pay.
   */
  async read(binding: ToolBinding): Promise<CeilingKind | null> {
    if (declared(binding.maxDailyCalls)) {
      const spent = await this.dailySpent(binding.id);
      if (spent !== null && spent >= binding.maxDailyCalls) return CeilingKind.MAX_DAILY_CALLS;
    }

    if (declared(binding.maxRps)) {
      const inWindow = await this.callsInWindow(binding.id);
      if (inWindow !== null && inWindow >= binding.maxRps) return CeilingKind.MAX_RPS;
    }

    return null;
  }

  /**
   * {@link read} for a whole candidate set, in one wave rather than N.
   *
   * `gatherCandidates`' own doc comment forbids a per-candidate read on the hot
   * path — *"a per-candidate loop would turn one routing decision into N
   * sequential network round-trips on the path an agent is blocked on"* — and
   * this is what lets the router honour that. The commands for every binding
   * are issued in the same tick, so they leave in one socket write and their
   * replies come back together: the cost is a constant two round trips (the
   * daily read, then the rps read for whatever survived it), not two per
   * candidate.
   *
   * Only bindings that are actually at a ceiling appear in the result. An
   * absent binding has headroom, which keeps the caller from having to tell
   * `null`-the-value from `null`-the-missing-entry.
   */
  async readAll(bindings: readonly ToolBinding[]): Promise<ReadonlyMap<string, CeilingKind>> {
    const readings = await Promise.all(
      bindings.map(async (binding) => [binding.id, await this.read(binding)] as const),
    );

    const hits = new Map<string, CeilingKind>();
    for (const [bindingId, hit] of readings) {
      if (hit !== null) hits.set(bindingId, hit);
    }
    return hits;
  }

  /**
   * Spend one call's worth of both ceilings, on the binding actually invoked.
   *
   * Returns `null` when the call may proceed, or the {@link CeilingKind} that
   * refused it — which the caller treats as an ordinary shed and fails over on,
   * identically to a ceiling hit at filter time.
   *
   * **Never throws.** It sits between selection and the outbound call, and a
   * throw there would convert a rate-limiting concern into a failed tool call
   * for the agent.
   *
   * The daily counter is spent first and the rps token second, so that the
   * *durable* resource is never consumed by a call the transient one is about
   * to refuse. When the rps bucket refuses after the day has been debited, the
   * day is credited back before returning — see the class doc on why a refused
   * call must hold nothing.
   */
  async consume(binding: ToolBinding): Promise<CeilingKind | null> {
    const hasDaily = declared(binding.maxDailyCalls);
    const hasRps = declared(binding.maxRps);
    if (!hasDaily && !hasRps) return null;

    let dailyDebited = false;

    if (hasDaily) {
      const outcome = await this.spendDaily(binding.id, binding.maxDailyCalls);
      if (outcome === 'refused') return CeilingKind.MAX_DAILY_CALLS;
      dailyDebited = outcome === 'spent';
    }

    if (hasRps) {
      const outcome = await this.spendRps(binding.id, binding.maxRps);
      if (outcome === 'refused') {
        if (dailyDebited) await this.refundDaily(binding.id);
        return CeilingKind.MAX_RPS;
      }
    }

    return null;
  }

  /**
   * How much of each ceiling is left — for the provider's own console
   * and for the assertion that {@link read} spends nothing.
   *
   * Never negative: a shed that raced past the ceiling is corrected by
   * {@link consume}, and a headroom of `-1` on a screen would be read as a bug
   * in the accounting rather than as a moment of concurrency.
   *
   * An unreadable Redis reports **full** headroom rather than `null`, matching
   * the permit-on-failure rule above: `null` on this interface means "no
   * ceiling declared", and overloading it with "we could not tell" would make
   * every caller re-derive which of the two it had.
   */
  async remaining(binding: ToolBinding): Promise<CeilingHeadroom> {
    const rps = declared(binding.maxRps)
      ? Math.max(0, binding.maxRps - ((await this.callsInWindow(binding.id)) ?? 0))
      : null;

    const daily = declared(binding.maxDailyCalls)
      ? Math.max(0, binding.maxDailyCalls - ((await this.dailySpent(binding.id)) ?? 0))
      : null;

    return { rps, daily };
  }

  // ── the daily quota ───────────────────────────────────────────────────────

  /** How many calls this binding has served today, or `null` if unreadable. */
  private async dailySpent(bindingId: string): Promise<number | null> {
    try {
      const value = await this.redis.get(this.dailyKey(bindingId));
      const spent = Number(value ?? '0');
      return Number.isFinite(spent) ? spent : 0;
    } catch (error) {
      this.permitting(bindingId, 'daily quota unreadable', error);
      return null;
    }
  }

  private async spendDaily(bindingId: string, max: number): Promise<SpendOutcome> {
    const key = this.dailyKey(bindingId);

    try {
      const spent = await this.redis.incr(key);

      // Only on the first write of the day. The key names its own day, so the
      // TTL exists to sweep yesterday rather than to define today — refreshing
      // it on every call would be a command per call for nothing.
      if (spent === 1) await this.redis.expire(key, secondsUntilNextUtcDay());

      if (spent > max) {
        await this.redis.decr(key);
        return 'refused';
      }
      return 'spent';
    } catch (error) {
      this.permitting(bindingId, 'daily quota not counted', error);
      return 'unavailable';
    }
  }

  /**
   * Give back a call debited for a request the rps bucket then refused.
   *
   * Best effort, and silent about its own failure beyond a warning: the call is
   * already being shed, and there is nothing better to do with a Redis that
   * refuses the correction than to leave the counter one high for the rest of
   * the day.
   */
  private async refundDaily(bindingId: string): Promise<void> {
    try {
      await this.redis.decr(this.dailyKey(bindingId));
    } catch (error) {
      this.logger.warn(
        `binding ${bindingId}: a shed call was left counted against today's quota. ` +
          `${describe(error)}`,
      );
    }
  }

  private dailyKey(bindingId: string): string {
    return `${BINDING_DAILY_KEY_PREFIX}${bindingId}:${utcDayKey(new Date())}`;
  }

  // ── the rps window ────────────────────────────────────────────────────────

  /**
   * How many calls fall inside the current window, or `null` if unreadable.
   *
   * `ZCOUNT` over a score range rather than a trim-then-count: the expired
   * members are still in the key and are simply not counted, which is what
   * keeps this a read. Exclusive lower bound (`(`), matching the inclusive
   * `<=` trim {@link spendRps} performs, so the two agree about a member
   * sitting exactly on the boundary.
   */
  private async callsInWindow(bindingId: string): Promise<number | null> {
    const floor = Date.now() - RPS_WINDOW_MS;

    try {
      return Number(await this.redis.zcount(this.rpsKey(bindingId), `(${floor}`, '+inf'));
    } catch (error) {
      this.permitting(bindingId, 'rps window unreadable', error);
      return null;
    }
  }

  /**
   * Add this call to the window and report whether it fits.
   *
   * A sliding window (a sorted set keyed by timestamp), not a fixed one, for
   * the reason `RedisSigningRateLimiter` gives at length: a fixed window lets
   * through twice the ceiling across a boundary, which for a provider who
   * declared `max_rps: 10` means a burst of 20 in two seconds and a 429 they
   * were promised protection from.
   *
   * Optimistic: the member is added, the window is counted, and it is removed
   * again if it did not fit. Under concurrency two callers can both overshoot
   * and both roll back, so this can refuse a call that would have fitted —
   * erring on the side of the number the provider declared, which is the only
   * direction that cannot produce a call they said they could not take.
   */
  private async spendRps(bindingId: string, max: number): Promise<SpendOutcome> {
    const key = this.rpsKey(bindingId);
    const now = Date.now();
    // Unique per call. Two calls in the same millisecond are ordinary under
    // load, and a plain timestamp member would silently overwrite one of them —
    // undercounting exactly when the count matters.
    const member = `${now}:${randomUUID()}`;

    try {
      const replies = await this.redis
        .multi()
        .zremrangebyscore(key, '-inf', String(now - RPS_WINDOW_MS))
        .zadd(key, now, member)
        .zcard(key)
        // Refreshed on every write rather than set once, so a binding that
        // keeps serving never expires mid-window and one that goes quiet is
        // cleaned up without a sweeper.
        .pexpire(key, RPS_WINDOW_MS)
        .exec();

      if (!replies) {
        // `exec` returns null when the MULTI was discarded — a reconnect, or a
        // watch failure. Indistinguishable from a partial count, so it is
        // treated as "the counter did not run".
        this.permitting(bindingId, 'rps counter unavailable', new Error('MULTI discarded'));
        return 'unavailable';
      }

      // Four commands; `zcard` is the third.
      const [error, inWindow] = replies[2];
      if (error) throw error;

      if (Number(inWindow) > max) {
        await this.redis.zrem(key, member).catch((problem: unknown) => {
          this.logger.warn(
            `binding ${bindingId}: a shed call was left holding an rps token for ` +
              `${RPS_WINDOW_MS}ms. ${describe(problem)}`,
          );
          return 0;
        });
        return 'refused';
      }

      return 'spent';
    } catch (error) {
      this.permitting(bindingId, 'rps not counted', error);
      return 'unavailable';
    }
  }

  private rpsKey(bindingId: string): string {
    return `${BINDING_RPS_KEY_PREFIX}${bindingId}`;
  }

  /**
   * One place for every "Redis said no, so the call goes through" branch, so
   * that the direction this class fails in is greppable rather than spread over
   * six catch blocks.
   */
  private permitting(bindingId: string, what: string, error: unknown): void {
    this.logger.warn(
      `binding ${bindingId}: ${what}, the declared ceiling is not enforced for this call. ` +
        `${describe(error)}`,
    );
  }
}

type SpendOutcome = 'spent' | 'refused' | 'unavailable';

/**
 * `null` is "no ceiling"; `0` is "declared unroutable".
 *
 * Spelled out rather than written `?? Infinity`, because the two collapse under
 * any falsy test and they are opposites: one binding takes every call and the
 * other takes none. A provider who genuinely wants to stop should use the
 * pause button, which says so on the row and in the console.
 *
 * A `0` is nonetheless honoured as what it says, because the schema still
 * permits one. It just can no longer arrive through the editor: `B7b` put
 * `@Min(1)` on both DTO fields, on the ground that `0` and pause are the same
 * outcome with two spellings and only one of them shows on the row. So the
 * reachable sources of a `0` are a raw `UPDATE` and a future writer — and this
 * function is what stops either of them being read as "no ceiling".
 */
function declared(ceiling: number | null): boolean {
  return typeof ceiling === 'number' && Number.isFinite(ceiling);
}

/**
 * `YYYY-MM-DD` in **UTC** — the Redis half of the rule
 * `provider/services/day-bucket.util.ts` states for SQL.
 *
 * `toISOString()` and not `getFullYear()`/`getMonth()`/`getDate()`, which read
 * the process's local zone and would put two pods in different regions on
 * different days.
 */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * How long the day's counter should live: to the next UTC midnight, plus an
 * hour.
 *
 * The key names its own day, so the TTL is only there to stop a binding
 * accumulating one dead key per day forever. The hour of grace covers a
 * counter written a moment before midnight by a pod whose clock is slightly
 * behind — losing that key early would hand the binding a second full
 * allowance on the same day, which is the one direction this must not fail in.
 */
function secondsUntilNextUtcDay(): number {
  const now = Date.now();
  const midnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  );
  return Math.ceil((midnight - now) / 1_000) + 3_600;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
