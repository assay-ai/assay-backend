import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { AccountId } from '@modules/chains/ports/caip.types';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import {
  DEFAULT_RELAYED_INTENT_RATE_LIMITS,
  RelayedIntentObservation,
  RelayedIntentRateLimits,
  decideRelayedIntentRate,
} from '../domain/relayed-intent-rate-limit';
import { SettlementErrors } from '../errors/settlement.errors';

/** Overridable so a deployment can tighten the bound without a release. */
export const RELAYED_INTENT_RATE_LIMITS = 'RELAYED_INTENT_RATE_LIMITS';

const KEY_PREFIX = 'settlement:relayed-intent:rate:';

/** Four commands per scope; `zcard` is the third of them. */
const COMMANDS_PER_SCOPE = 4;

/**
 * Counts relayed-submission attempts in a sliding window, in Redis.
 *
 * ## Sliding, not fixed
 *
 * A fixed window lets through twice the ceiling across a boundary, and the
 * boundary is trivially findable by anybody who can watch the rejections. For a
 * throttle on a read route that is a rounding error; for a bound on how fast
 * somebody can spend the platform's ETH it is a hole with a clock on it. A
 * sorted set keyed by timestamp costs one round trip more and has no boundary:
 * the window is always the last `windowSeconds`, measured from now.
 *
 * ## Redis is the counter, and it fails CLOSED
 *
 * If the counter cannot run, {@link admit} refuses and **nothing is
 * submitted**. That is the opposite of the usual choice for a rate limiter, and
 * it is the same choice `RedisSigningRateLimiter` makes for the same structural
 * reason: the unavailable-therefore-permitted branch is the one an attacker
 * steers you into, and knocking Redis over is easier than anything else on this
 * path.
 *
 * **What it costs, stated rather than buried.** While Redis is down, a buyer
 * holding no ETH cannot lower their ceiling or *start* an exit through the
 * relayed doors. Nothing is lost and nothing is seized — the delay is until the
 * counter is back, the signature stays valid until its own deadline, and
 * `withdraw()`, the transaction that actually moves money out, is the buyer's
 * own and never passed through this class. The asymmetry is deliberate: failing
 * open costs ETH that cannot be recovered, failing closed costs minutes that
 * can.
 */
@Injectable()
export class RelayedIntentRateLimiter {
  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    @Inject(RELAYED_INTENT_RATE_LIMITS)
    private readonly limits: RelayedIntentRateLimits = DEFAULT_RELAYED_INTENT_RATE_LIMITS,
  ) {}

  /**
   * Record this attempt and refuse if either scope is now over its ceiling.
   *
   * The attempt is recorded **before** the decision and regardless of what
   * happens next, so a submission the chain goes on to refuse still counts —
   * see `decideRelayedIntentRate` for why a refusal that did not count would
   * make the limit stop being one.
   */
  async admit(account: AccountId, organizationId: string): Promise<void> {
    const observations = await this.observe(account, organizationId);
    const breached = decideRelayedIntentRate(observations);
    if (breached) {
      throw SettlementErrors.relayedIntentRateLimited({
        scope: breached.scope,
        observed: breached.observed,
        limit: breached.limit,
        windowSeconds: this.limits.windowSeconds,
      });
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async observe(
    account: AccountId,
    organizationId: string,
  ): Promise<readonly RelayedIntentObservation[]> {
    const now = Date.now();
    const windowMs = this.limits.windowSeconds * 1000;
    // Unique per attempt. Two submissions in the same millisecond are ordinary
    // under load, and a plain timestamp member would silently overwrite one of
    // them — undercounting exactly when the count matters.
    const member = `${now}:${randomUUID()}`;

    const scopes = [
      // Narrowest first: `decideRelayedIntentRate` names the first breached
      // scope, and "this buyer is out of budget" is more actionable than "your
      // organization is".
      { scope: `account:${account}`, limit: this.limits.perAccount },
      { scope: `organization:${organizationId}`, limit: this.limits.perOrganization },
    ];

    let replies: [Error | null, unknown][] | null;
    try {
      const pipeline = this.redis.multi();
      for (const { scope } of scopes) {
        const key = `${KEY_PREFIX}${scope}`;
        pipeline.zremrangebyscore(key, '-inf', now - windowMs);
        pipeline.zadd(key, now, member);
        pipeline.zcard(key);
        // Refreshed on every write rather than set once, so a scope that keeps
        // being used never expires mid-window and one that goes quiet is
        // cleaned up.
        pipeline.pexpire(key, windowMs);
      }
      replies = (await pipeline.exec()) as [Error | null, unknown][] | null;
    } catch {
      throw SettlementErrors.relayedIntentUnavailable();
    }

    if (!replies) {
      // `exec` returns null when the MULTI was discarded — a reconnect, or a
      // watch failure. Not distinguishable from a partial count, so it is
      // treated as "the counter did not run", which fails closed.
      throw SettlementErrors.relayedIntentUnavailable();
    }

    return scopes.map(({ scope, limit }, index) => {
      const reply = replies?.[index * COMMANDS_PER_SCOPE + 2];
      if (!reply || reply[0]) {
        throw SettlementErrors.relayedIntentUnavailable();
      }
      return { scope, observed: Number(reply[1]), limit };
    });
  }
}
