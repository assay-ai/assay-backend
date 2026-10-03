import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

/** One key per binding. Not per tenant — see {@link BindingCallCounterService}. */
export const BINDING_CALL_COUNT_KEY_PREFIX = 'tool:binding:calls:';

/**
 * A week. Long enough that the `COUNT(*)` is rare, short enough that a counter
 * which has drifted re-anchors to the table without anybody noticing it had.
 *
 * Set at hydration and deliberately **not** refreshed on every increment: a
 * busy binding would then hold a key that never expires and never re-checks
 * itself, which is precisely the binding whose count matters most.
 */
export const BINDING_CALL_COUNT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How many calls a binding has served.
 *
 * The exploration floor gives a **new** binding a reserved share of its tool's
 * traffic for its first `EXPLORATION_CALL_THRESHOLD` calls, so "how many calls
 * has this binding served" is the input that decides whether a provider gets
 * their chance to build a quality profile. `computeWeights` reserves that
 * share; this class is where the number it reserves against comes from.
 *
 * ```text
 *   the MCP loop            this class                 the truth
 *   ───────────────────     ─────────────────────      ────────────────────────
 *   transition writes  ──▶  INCR tool:binding:calls:X
 *   payment_intents             │ key missing?
 *   .binding_id = X             └──────────────────▶  COUNT(*) WHERE binding_id = X
 * ```
 *
 * ## `payment_intents` is the source of truth, Redis is the counter
 *
 * A count that lived only in Redis would be rewritten by a flush, an eviction
 * or a failover — a binding two years into production would come back looking
 * brand new and take a new binding's exploration allowance. So the key is a
 * cache in front of {@link PaymentIntentRepository.countCallsByBinding}, and a
 * miss is repaired from the rows that recorded the calls rather than restarted
 * from zero.
 *
 * The hydrating read does **not** then increment. The MCP loop writes the row
 * first and tells this class second, so by the time a miss is repaired, the
 * call being recorded is already one of the rows that was counted; adding to it
 * would count that call twice.
 *
 * ## Every failure runs in one direction
 *
 * The count can be wrong in two directions and they are not symmetrical:
 *
 * - **Too low** — the binding looks *newer* than it is and is given
 *   exploration traffic it has arguably already had. It is a small over-spend
 *   out of a budget hard-capped at 20% of a tool's traffic.
 * - **Too high** — the binding looks *older* than it is and loses its
 *   exploration share **early**, before it has served the calls that would have
 *   earned it a score. No later call gives that back.
 *
 * So every branch here prefers the first. A lost key rebuilds from a table that
 * cannot see rows from before `binding_id` was recorded, and is therefore a
 * floor rather than an estimate.
 * A racing hydration declines to add its own call rather than risk adding it
 * twice. And an increment that Redis refuses is dropped, not retried.
 *
 * The one thing that is *not* allowed to be permissive is an unreadable count.
 * {@link observedCalls} returns `null` there rather than `0`, because
 * `RoutingCandidate.observedCalls` excludes `null` from the exploration set:
 * `0` is the permissive value on that interface and an outage would otherwise
 * hand every binding on the platform a new binding's allowance at once.
 *
 * ## Why the counter is per binding and spans tenants
 *
 * A binding's traffic arrives from every buying organization that routed to it,
 * and the tenant on a `payment_intents` row is the buyer, not the provider. So
 * there is one key per binding, and the query behind it reads across tenants on
 * purpose — see the repository method for that half.
 *
 * ## Why the shared cache client
 *
 * `RedisPolicyKillSwitchService` and `RedisSigningRateLimiter` each open their
 * own connection because they sit on decisions that must not be taken down by
 * cache traffic — whether a policy is enforced, whether a signature is
 * produced. This is the opposite kind of consumer: losing it costs a little
 * exploration budget and nothing else, and it is documented above as the safe
 * direction to fail in. A third connection per pod to protect a number that is
 * allowed to be approximate would be weight for nothing, so this rides the
 * `@Global` `REDIS_CACHE_CLIENT` that `CacheService` uses.
 */
@Injectable()
export class BindingCallCounterService {
  private readonly logger = new Logger(BindingCallCounterService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly intents: PaymentIntentRepository,
  ) {}

  /**
   * Count one call this binding has served.
   *
   * **Called from the point that writes `payment_intents.binding_id`, never
   * from the point the router selects a binding.** Failover abandons the
   * binding it drew first and serves from another; counting at selection would
   * charge the abandoned binding for a call it never answered, and that error
   * runs the wrong way — the binding looks older than it is and loses
   * exploration traffic early.
   *
   * **Never throws.** It runs immediately after a financial transition has
   * already committed, on the path that returns the agent's data. A counter
   * that raised there would turn a successful, already-recorded call into an
   * error, which is a far worse outcome than a count that is one short.
   */
  async record(bindingId: string): Promise<void> {
    const key = this.key(bindingId);

    try {
      if ((await this.redis.exists(key)) === 1) {
        await this.redis.incr(key);
        return;
      }

      // Cache miss. The row for *this* call is already in the table, so the
      // count is the new value and must not be incremented on top of.
      await this.hydrate(key, bindingId);
    } catch (error) {
      this.logger.warn(
        `binding ${bindingId}: call not counted, the exploration count will read low. ` +
          `${describe(error)}`,
      );
    }
  }

  /**
   * How many calls this binding has served, or `null` when nothing could
   * answer.
   *
   * `null` is not zero and the difference is load-bearing — see the class doc.
   * A Redis that cannot be read still leaves the table, and the table is the
   * source of truth anyway; only when neither answers does this give up.
   */
  async observedCalls(bindingId: string): Promise<number | null> {
    const key = this.key(bindingId);

    try {
      const cached = await this.redis.get(key);
      if (cached !== null) {
        const count = Number(cached);
        if (Number.isFinite(count)) return count;
      }
    } catch (error) {
      // Fall through to the table. Redis is the cache, not the answer.
      this.logger.warn(`binding ${bindingId}: call counter unreadable. ${describe(error)}`);
    }

    try {
      return await this.hydrate(key, bindingId);
    } catch (error) {
      this.logger.warn(
        `binding ${bindingId}: call count unavailable, exploration withdrawn. ${describe(error)}`,
      );
      return null;
    }
  }

  /**
   * {@link observedCalls} for a whole candidate set, in one wave rather than N.
   *
   * `gatherCandidates`' own doc comment forbids a per-candidate read on the hot
   * path — *"a per-candidate loop would turn one routing decision into N
   * sequential network round-trips on the path an agent is blocked on"* — and
   * this is what lets the router honour it. The `GET`s for every binding are
   * issued in the same tick, so they leave in one socket write and their
   * replies come back together; the cost is one round trip rather than one per
   * candidate.
   *
   * The **miss** path is the honest caveat: a binding whose key has expired
   * falls through to `COUNT(*)`, and a whole candidate set missing at once is
   * that many queries — concurrent rather than sequential, but still that many.
   * It is bounded by the key's week-long TTL and by there being one key per
   * binding rather than per binding per tenant, and it is the same trade
   * {@link BindingCeilingService.readAll} makes next door. A single `MGET`
   * would remove even that, at the price of a second code path for the misses
   * that would then have to repeat this method's hydration rule.
   *
   * Every binding asked about appears in the result, and `null` means the same
   * thing it means on {@link observedCalls}: nothing could answer. It is NOT
   * collapsed to `0` — `RoutingCandidate.observedCalls` excludes `null` from
   * the exploration set, and `0` is the permissive value there.
   */
  async observedCallsAll(
    bindingIds: readonly string[],
  ): Promise<ReadonlyMap<string, number | null>> {
    const readings = await Promise.all(
      bindingIds.map(
        async (bindingId) => [bindingId, await this.observedCalls(bindingId)] as const,
      ),
    );

    return new Map(readings);
  }

  /**
   * Rebuild the counter from the rows, and publish it for the next reader.
   *
   * `NX` and not a plain `SET`: two callers can miss at once, and the loser
   * must not overwrite a key the winner has already begun incrementing. When it
   * is refused the loser simply returns its own count and adds nothing —
   * under-counting by the one call it was recording, in the direction this
   * class is allowed to be wrong in.
   *
   * The write is best-effort. A count that could be read but not cached is
   * still the right answer; failing the read because the cache refused would
   * turn a Redis problem into a routing one.
   */
  private async hydrate(key: string, bindingId: string): Promise<number> {
    const count = await this.intents.countCallsByBinding(bindingId);

    await this.redis
      .set(key, String(count), 'EX', BINDING_CALL_COUNT_TTL_SECONDS, 'NX')
      .catch((error: unknown) => {
        this.logger.warn(`binding ${bindingId}: call count not cached. ${describe(error)}`);
        return null;
      });

    return count;
  }

  private key(bindingId: string): string {
    return `${BINDING_CALL_COUNT_KEY_PREFIX}${bindingId}`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
