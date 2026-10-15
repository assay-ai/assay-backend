import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ToolCallRecordRepository } from '@database/postgres/repositories/tool-call-record.repository';
import { toServedToolBindings } from '@modules/tool/services/database-tool-catalogue';
import { BindingStatus, PricingMode, ToolBinding } from '@modules/tool/ports/tool.types';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { FREE_QUOTA_CONFIG, FreeQuotaConfig } from '../config/free-quota.config';
import { TOOL_CALL_RECORD_RETENTION_DAYS } from '../constants/free-quota.constants';

// ---------------------------------------------------------------------------
// Redis keys — house style: exported prefixes, the period baked into the key.
// ---------------------------------------------------------------------------

/** Per agent, across every free tool, per **UTC day**. The platform's own ceiling. */
export const FREE_QUOTA_PLATFORM_DAILY_KEY_PREFIX = 'free-quota:platform:daily:';
/** Per agent, per **UTC minute-window**. The platform's burst guard. */
export const FREE_QUOTA_PLATFORM_RATE_KEY_PREFIX = 'free-quota:platform:rate:';
/** Per agent, per binding, per **UTC day**. The provider's own per-agent dial. */
export const FREE_QUOTA_BINDING_AGENT_DAILY_KEY_PREFIX = 'free-quota:binding-agent:daily:';
/** Per binding, across every agent, per **UTC day**. The provider's own budget. */
export const FREE_QUOTA_BINDING_BUDGET_KEY_PREFIX = 'free-quota:binding-budget:daily:';

/** Which of the four independent limits refused the call, or is closest to doing so. */
export enum FreeQuotaLimitKind {
  /** Platform, agent-scoped, all free tools: {@link FreeQuotaConfig.platformAgentDailyLimit}. */
  PLATFORM_AGENT_DAILY = 'PLATFORM_AGENT_DAILY',
  /** Platform, agent-scoped, bursts: {@link FreeQuotaConfig.platformRateLimitPerMinute}. */
  PLATFORM_RATE_LIMIT = 'PLATFORM_RATE_LIMIT',
  /** Provider, per agent per binding: `tool_bindings.free_quota_per_agent`. */
  PROVIDER_PER_AGENT_DAILY = 'PROVIDER_PER_AGENT_DAILY',
  /** Provider, per binding across every agent: `tool_bindings.free_daily_budget`. */
  PROVIDER_DAILY_BUDGET = 'PROVIDER_DAILY_BUDGET',
}

export interface FreeQuotaAllowed {
  readonly kind: 'ALLOWED';
}

/**
 * `kind` is the discriminant, not `allowed`, and that is a compiler
 * constraint rather than a style choice: this codebase's `tsconfig.json` sets
 * `strictNullChecks: false`, and under that setting TypeScript does not
 * narrow a union on a `true`/`false`-literal boolean field — `if
 * (!decision.allowed)` type-checks but leaves `decision` typed as the full
 * union, so `decision.limit` is a compile error even on the branch that
 * refused. A string-literal discriminant (`'ALLOWED' | 'REFUSED'`, the same
 * shape `McpCallOutcome.kind` already uses next door) narrows correctly under
 * the same setting. Verified against this project's own `tsc`, not assumed.
 */
export interface FreeQuotaRefused {
  readonly kind: 'REFUSED';
  readonly limit: FreeQuotaLimitKind;
  readonly resetsAt: Date;
  /**
   * Exhaustion behaviour: a `FREEMIUM` exhaustion falls
   * through to the paid path; a `FREE` exhaustion (no paid path through this
   * tool exists) is an error. `FreeQuotaService` does not decide this on its
   * own reasoning — it is exactly the `pricingMode` the caller passed to
   * {@link FreeQuotaService.check}, echoed back so the orchestrator's relay
   * branch does not have to re-derive it from the quote a second time.
   */
  readonly fallThroughToPaid: boolean;
}

export type FreeQuotaDecision = FreeQuotaAllowed | FreeQuotaRefused;

export interface FreeQuotaCheckInput {
  readonly organizationId: string;
  readonly agentId: string;
  readonly toolId: string;
  /**
   * From `ToolQuote.pricingMode` — `FREE` or `FREEMIUM` only. The orchestrator
   * calls {@link check} exactly on the branch that already decided to go free
   * (relay mode: *"FREE, or FREEMIUM within quota"*), so a
   * `PAID` quote never reaches here.
   */
  readonly pricingMode: PricingMode.FREE | PricingMode.FREEMIUM;
}

export interface FreeQuotaConsumeInput {
  readonly organizationId: string;
  readonly agentId: string;
  /** The binding the relay call actually used — read off `RoutedCall.binding.id`. */
  readonly bindingId: string;
}

/** Places taken by {@link FreeQuotaService.reservePlatform} or `reserveBinding`. */
export interface FreeQuotaReservation {
  readonly kind: 'RESERVED';
  /** Gives every place back. Never throws; a second call is a no-op. */
  release(): Promise<void>;
}

/** The binding a free call is about to be dialled on, and the agent it is for. */
export interface FreeQuotaBindingReserveInput {
  readonly organizationId: string;
  readonly agentId: string;
  readonly binding: Pick<ToolBinding, 'id' | 'freeQuotaPerAgent' | 'freeDailyBudget'>;
}

/** `{ remaining, limit, resetsAt }` — the shape `tools/list` publishes as `x402/freeQuota`. */
export interface FreeQuotaRemaining {
  readonly remaining: number;
  readonly limit: number;
  readonly resetsAt: Date;
}

/**
 * The four independent free-tier limits, read and spent.
 *
 * ```text
 *   free-tier limit                                  this class
 *   ─────────────────────────────────────────────    ──────────────────────────
 *   Per agent, per binding, daily (provider)      ──  binding-agent counter
 *   Provider daily budget (provider)              ──  binding-budget counter
 *   Per agent, all free tools, daily (platform)   ──  platform-daily counter
 *   Rate limit (platform)                         ──  platform-rate window
 * ```
 *
 * ## `check` is pure inspection; the call path RESERVES
 *
 * The MCP call path no longer checks and then consumes after the fact: N
 * parallel calls would all pass the check before any consume (review
 * 2026-10-15, M5). It takes its places atomically before the call —
 * {@link reservePlatform} before routing, {@link reserveBinding} on the binding
 * the router is about to dial, so a binding whose own quota is spent is never
 * drawn (M4) — and releases them when nothing was served. {@link consume} stays
 * for callers that count after the fact. The rest of this section describes
 * {@link check} and {@link consume}.
 *
 * Same split as `BindingCeilingService`, for the same reason: {@link check} is
 * called from `tools/list` (every agent, every poll, no call happening) as
 * well as from the relay branch's pre-flight, so it must never spend anything.
 * {@link consume} is called exactly once, after the router has already
 * returned which binding served the call — never at pre-flight, because the
 * router picks the binding *after* the free/paid decision is made (see the
 * class doc on
 * `PROVIDER_PER_AGENT_DAILY` below for what that costs).
 *
 * ## Why the platform limits and the provider limits are read differently
 *
 * The two platform limits are agent-scoped and knowable before routing, so
 * {@link check} enforces them as a genuine refusal. The two provider limits are
 * per-*binding*, and the binding is not chosen yet — `ProviderRouterService`
 * picks it inside `selectAndReserve`, and the router keeps sole ownership of
 * that decision. So {@link check} reads **every** free/freemium binding
 * behind the tool directly off `ToolBindingRepository` and refuses only when
 * **all** of them are exhausted; a tool with five free bindings, four of them
 * spent, still returns `kind: 'ALLOWED'`, and the router may or may not draw the
 * one with headroom. The intended "route to another provider" outcome for a
 * provider-budget exhaustion is therefore not actually implemented — routing
 * away from an exhausted-quota binding belongs beside
 * `this.ceilings.consume(binding)` in `selectAndReserve`, because a free quota
 * is structurally the same thing as a binding ceiling.
 *
 * ## The fail direction is not one direction — it is two, and they disagree on purpose
 *
 * The **platform** limits exist because free traffic is real infrastructure
 * cost with no economic backpressure — the default ceilings are priced at
 * roughly $16,500/month, and that number is the
 * platform's own exposure. Failing open on an unreadable counter here would
 * remove the only bound on it, so a `platformAgentDaily` or `rateLimit` check
 * that cannot be answered **refuses** — after trying Postgres first (below),
 * exactly `BindingCallCounterService`'s hydration shape, so a bare Redis
 * restart does not look like an outage.
 *
 * The **provider** limits are the opposite case, for the same reason
 * `BindingCeilingService` gives for its own ceilings: *"this one guards a
 * courtesy a provider asked for."* A provider's own per-agent or budget dial
 * going briefly unenforced during a Redis incident costs that provider some
 * goodwill, not the platform any money, and it is bounded from above by the
 * platform ceiling regardless — so an unreadable provider counter **permits**.
 *
 * ## Why the daily counters hydrate from Postgres and the rate window does not
 *
 * A daily counter is the thing an attacker could game by waiting out a cache
 * flush — `payment_intents`/`tool_call_records` is the durable answer behind
 * it, same argument `BindingCallCounterService` makes for the exploration
 * count, and {@link ToolCallRecordRepository.countForAgentSince} /
 * {@link ToolCallRecordRepository.countForAgentBindingSince} /
 * {@link ToolCallRecordRepository.countForBindingSince} are its three grains.
 * A 60-second rate window is not: it self-heals within a minute regardless of
 * whether Redis restarted a second ago or an hour ago, so there is nothing a
 * Postgres round trip would protect that the window's own short life does not
 * already bound, and asking Postgres to answer "how many calls in the last
 * minute" on every `tools/call` would be the wrong trade for a burst guard.
 */
@Injectable()
export class FreeQuotaService {
  private readonly logger = new Logger(FreeQuotaService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly records: ToolCallRecordRepository,
    private readonly bindings: ToolBindingRepository,
    @Inject(FREE_QUOTA_CONFIG) private readonly config: FreeQuotaConfig,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    private readonly versions: BindingVersionRepository,
  ) {}

  // ── check — pure, no Redis writes ─────────────────────────────────────────

  async check(input: FreeQuotaCheckInput): Promise<FreeQuotaDecision> {
    const platformRate = await this.checkPlatformRate(input.agentId);
    if (platformRate)
      return this.refuse(FreeQuotaLimitKind.PLATFORM_RATE_LIMIT, platformRate, input);

    const platformDaily = await this.checkPlatformDaily(input.organizationId, input.agentId);
    if (platformDaily)
      return this.refuse(FreeQuotaLimitKind.PLATFORM_AGENT_DAILY, platformDaily, input);

    const providerVerdict = await this.checkProviderLimits(
      input.organizationId,
      input.agentId,
      input.toolId,
    );
    if (providerVerdict) return this.refuse(providerVerdict.limit, providerVerdict.resetsAt, input);

    return { kind: 'ALLOWED' };
  }

  /**
   * What `tools/list` publishes as `x402/freeQuota` — the most generous honest
   * answer, across whichever free/freemium binding behind this tool has the
   * most headroom.
   *
   * `null` when the tool has no `FREE`/`FREEMIUM` `ACTIVE` binding at all,
   * which is the caller's signal to omit the annotation rather than publish a
   * quota against nothing.
   *
   * "Most headroom" rather than "the binding the router would pick" because
   * `ToolQuote` — deliberately — carries no
   * binding id, and picking one is the router's decision (`selectAndReserve`),
   * not this method's to guess. Reporting the binding with the most room left
   * is the same directional choice `check` makes: an agent is told the best
   * case that is actually still reachable, never a number that overstates it.
   */
  async remainingForTool(
    organizationId: string,
    agentId: string,
    toolId: string,
  ): Promise<FreeQuotaRemaining | null> {
    const candidates = await this.freeBindings(toolId);
    if (candidates.length === 0) return null;

    const resetsAt = nextUtcMidnight();
    let best: FreeQuotaRemaining | null = null;

    for (const binding of candidates) {
      const perAgentLimit = binding.freeQuotaPerAgent ?? this.config.defaultPerAgentDailyLimit;
      const budgetLimit = binding.freeDailyBudget ?? this.config.defaultProviderDailyBudget;

      const perAgentUsed = await this.readAgentBindingDaily(organizationId, agentId, binding.id);
      const budgetUsed = await this.readBindingBudget(binding.id);

      const perAgentRemaining = clampRemaining(perAgentLimit, perAgentUsed);
      const budgetRemaining = clampRemaining(budgetLimit, budgetUsed);
      const remaining = Math.min(perAgentRemaining, budgetRemaining);

      if (!best || remaining > best.remaining) {
        best = { remaining, limit: perAgentLimit, resetsAt };
      }
    }

    return best;
  }

  /**
   * How many free calls a day one agent is offered on this tool — the most
   * generous per-agent allowance among its `FREE`/`FREEMIUM` `ACTIVE`
   * bindings, the platform default standing in for one the provider left unset.
   * `null` when no binding of the tool serves free calls.
   *
   * What `tools/list` prints as *"N free per day, then $X"*. Nobody's own
   * count: the same figure for every agent, so it can be published without a
   * viewer, unlike {@link remainingForTool}. The platform's own per-agent daily
   * ceiling still applies on top, across every free tool.
   */
  async dailyAllowanceForTool(toolId: string): Promise<number | null> {
    const candidates = await this.freeBindings(toolId);
    if (candidates.length === 0) return null;

    return Math.max(
      ...candidates.map(
        (binding) => binding.freeQuotaPerAgent ?? this.config.defaultPerAgentDailyLimit,
      ),
    );
  }

  /** Platform per-agent daily headroom — `GET /free-quota`'s `platform` field. */
  async platformRemaining(organizationId: string, agentId: string): Promise<FreeQuotaRemaining> {
    const used = await this.readThroughDaily(this.platformDailyKey(agentId), () =>
      this.records.countForAgentSince(organizationId, agentId, utcDayStart()),
    );

    return {
      remaining: clampRemaining(this.config.platformAgentDailyLimit, used),
      limit: this.config.platformAgentDailyLimit,
      resetsAt: nextUtcMidnight(),
    };
  }

  /** Platform rate-limit headroom — `GET /free-quota`'s `rateLimit` field. */
  async rateLimitRemaining(agentId: string): Promise<FreeQuotaRemaining> {
    const limit = this.config.platformRateLimitPerMinute;
    const resetsAt = new Date(Date.now() + this.rateWindowMs());

    try {
      const floor = Date.now() - this.rateWindowMs();
      const used = Number(
        await this.redis.zcount(this.platformRateKey(agentId), `(${floor}`, '+inf'),
      );
      return { remaining: clampRemaining(limit, used), limit, resetsAt };
    } catch (error) {
      this.logger.warn(
        `agent ${agentId}: rate-limit window unreadable for display. ${describe(error)}`,
      );
      // Display only — reporting the permissive figure here does not spend
      // anything and does not weaken `checkPlatformRate`'s own enforcement.
      return { remaining: limit, limit, resetsAt };
    }
  }

  /**
   * Every tool this agent has called free in the last 30 days, with its
   * headroom — `GET /free-quota`'s `tools` field.
   */
  async remainingByTool(
    organizationId: string,
    agentId: string,
  ): Promise<ReadonlyArray<FreeQuotaRemaining & { readonly toolId: string }>> {
    const since = new Date(Date.now() - TOOL_CALL_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    const toolIds = await this.records.distinctToolIdsForAgentSince(organizationId, agentId, since);

    const rows = await Promise.all(
      toolIds.map(async (toolId) => {
        const remaining = await this.remainingForTool(organizationId, agentId, toolId);
        return remaining ? { toolId, ...remaining } : null;
      }),
    );

    return rows.filter((row): row is FreeQuotaRemaining & { toolId: string } => row !== null);
  }

  // ── reserve — atomic places taken BEFORE the call (review 2026-10-15, M5) ──

  /**
   * Takes this call's place in the two platform limits — the per-minute burst
   * guard and the per-agent daily ceiling — atomically, before anything is
   * routed.
   *
   * `check` then `consume` let N parallel calls all read the same count and
   * all fit, overrunning every limit by up to N. Here each call INCRs first and
   * looks at the result: one over the limit gives its place straight back and
   * is refused, so N parallel calls with one place left produce exactly one
   * free call. The caller releases the places when the call is not served.
   *
   * Same fail directions as {@link check}: an unreadable rate window permits,
   * and an unreadable daily counter falls back to the read-through check
   * (Postgres), which refuses only when that cannot answer either.
   */
  async reservePlatform(
    input: FreeQuotaCheckInput,
  ): Promise<FreeQuotaReservation | FreeQuotaRefused> {
    const rate = await this.reserveRate(input.agentId);
    if (rate.kind === 'FULL') {
      return this.refuse(FreeQuotaLimitKind.PLATFORM_RATE_LIMIT, rate.resetsAt, input);
    }

    const daily = await this.reserveDaily(
      this.platformDailyKey(input.agentId),
      this.config.platformAgentDailyLimit,
      () => this.records.countForAgentSince(input.organizationId, input.agentId, utcDayStart()),
    );
    if (daily.kind === 'FULL') {
      await rate.release();
      return this.refuse(FreeQuotaLimitKind.PLATFORM_AGENT_DAILY, nextUtcMidnight(), input);
    }
    if (daily.kind === 'UNAVAILABLE') {
      const refusedUntil = await this.checkPlatformDaily(input.organizationId, input.agentId);
      if (refusedUntil) {
        await rate.release();
        return this.refuse(FreeQuotaLimitKind.PLATFORM_AGENT_DAILY, refusedUntil, input);
      }
    }

    return reservationOf([rate.release, daily.release]);
  }

  /**
   * Takes this call's place in one binding's own limits — the provider's
   * per-agent quota and its daily budget — atomically, on the binding about to
   * be dialled. `null` when either has no room (both places are given back).
   * Fails open, like the provider limits in {@link check}.
   */
  async reserveBinding(input: FreeQuotaBindingReserveInput): Promise<FreeQuotaReservation | null> {
    const { organizationId, agentId, binding } = input;
    const perAgent = await this.reserveDaily(
      this.agentBindingDailyKey(agentId, binding.id),
      binding.freeQuotaPerAgent ?? this.config.defaultPerAgentDailyLimit,
      () =>
        this.records.countForAgentBindingSince(organizationId, agentId, binding.id, utcDayStart()),
    );
    if (perAgent.kind === 'FULL') return null;

    const budget = await this.reserveDaily(
      this.bindingBudgetKey(binding.id),
      binding.freeDailyBudget ?? this.config.defaultProviderDailyBudget,
      () => this.records.countForBindingSince(binding.id, utcDayStart()),
    );
    if (budget.kind === 'FULL') {
      await perAgent.release();
      return null;
    }

    return reservationOf([perAgent.release, budget.release]);
  }

  /**
   * One place in a daily counter: hydrate on a miss (the day's count so far,
   * from Postgres), then `INCR`; over the limit gives it back with `DECR`.
   */
  private async reserveDaily(
    key: string,
    limit: number,
    hydrate: () => Promise<number>,
  ): Promise<
    | { readonly kind: 'RESERVED'; readonly release: () => Promise<void> }
    | { readonly kind: 'FULL' }
    | { readonly kind: 'UNAVAILABLE'; readonly release: () => Promise<void> }
  > {
    const noop = async () => undefined;
    try {
      if ((await this.redis.exists(key)) !== 1) {
        const count = await hydrate();
        await this.redis.set(key, String(count), 'EX', secondsUntilNextUtcDay(), 'NX');
      }
      const after = await this.redis.incr(key);
      const release = async () => {
        await this.redis.decr(key).catch((error: unknown) => {
          this.logger.warn(`${key}: reserved place not given back. ${describe(error)}`);
        });
      };
      if (after > limit) {
        await release();
        return { kind: 'FULL' };
      }
      return { kind: 'RESERVED', release };
    } catch (error) {
      this.logger.warn(`${key}: place not reserved. ${describe(error)}`);
      return { kind: 'UNAVAILABLE', release: noop };
    }
  }

  /** One place in the per-minute window: trim, `ZADD`, then count, in one `MULTI`. */
  private async reserveRate(
    agentId: string,
  ): Promise<
    | { readonly kind: 'RESERVED'; readonly release: () => Promise<void> }
    | { readonly kind: 'FULL'; readonly resetsAt: Date }
  > {
    const key = this.platformRateKey(agentId);
    const now = Date.now();
    const windowMs = this.rateWindowMs();
    const member = `${now}:${randomUUID()}`;
    const release = async () => {
      await this.redis.zrem(key, member).catch((error: unknown) => {
        this.logger.warn(`agent ${agentId}: rate place not given back. ${describe(error)}`);
      });
    };
    try {
      const results = await this.redis
        .multi()
        .zremrangebyscore(key, '-inf', String(now - windowMs))
        .zadd(key, now, member)
        .pexpire(key, windowMs)
        // After the trim, every member left is inside the window.
        .zcard(key)
        .exec();
      const count = Number(results?.[3]?.[1] ?? 0);
      if (count > this.config.platformRateLimitPerMinute) {
        await release();
        return { kind: 'FULL', resetsAt: new Date(now + windowMs) };
      }
      return { kind: 'RESERVED', release };
    } catch (error) {
      // Transient by construction — see the class doc. A blip permits.
      this.logger.warn(`agent ${agentId}: rate place not reserved, permitting. ${describe(error)}`);
      return { kind: 'RESERVED', release: async () => undefined };
    }
  }

  // ── consume — the after-the-fact write (callers that do not reserve) ─────

  /**
   * Spend one call against every counter it belongs to, on the binding that
   * actually served the call.
   *
   * Called once, after the fact — see the class doc. **Never throws**: it runs
   * after the agent has already been handed its result, on the same footing as
   * `BindingCallCounterService.record`, and a throw here would turn a
   * successful, already-returned call into an error.
   */
  async consume(input: FreeQuotaConsumeInput): Promise<void> {
    await Promise.all([
      this.incrPlatformDaily(input.organizationId, input.agentId),
      this.incrPlatformRate(input.agentId),
      this.incrAgentBindingDaily(input.organizationId, input.agentId, input.bindingId),
      this.incrBindingBudget(input.bindingId),
    ]);
  }

  // ── platform: rate limit (fails CLOSED — see class doc) ──────────────────

  /** `null` when there is headroom; the reset time when the window is full. */
  private async checkPlatformRate(agentId: string): Promise<Date | null> {
    const key = this.platformRateKey(agentId);
    const floor = Date.now() - this.rateWindowMs();

    try {
      const count = Number(await this.redis.zcount(key, `(${floor}`, '+inf'));
      if (count >= this.config.platformRateLimitPerMinute) {
        return new Date(Date.now() + this.rateWindowMs());
      }
      return null;
    } catch (error) {
      // Transient by construction — see the class doc's "why the rate window
      // does not hydrate". A blip here permits, unlike the daily counters.
      this.logger.warn(
        `agent ${agentId}: rate-limit window unreadable, permitting. ${describe(error)}`,
      );
      return null;
    }
  }

  private async incrPlatformRate(agentId: string): Promise<void> {
    const key = this.platformRateKey(agentId);
    const now = Date.now();
    const member = `${now}:${randomUUID()}`;
    const windowMs = this.rateWindowMs();

    try {
      await this.redis
        .multi()
        .zremrangebyscore(key, '-inf', String(now - windowMs))
        .zadd(key, now, member)
        .pexpire(key, windowMs)
        .exec();
    } catch (error) {
      this.logger.warn(`agent ${agentId}: rate-limit call not counted. ${describe(error)}`);
    }
  }

  private rateWindowMs(): number {
    return 60_000;
  }

  private platformRateKey(agentId: string): string {
    return `${FREE_QUOTA_PLATFORM_RATE_KEY_PREFIX}${agentId}`;
  }

  // ── platform: per-agent daily (fails CLOSED — see class doc) ─────────────

  private async checkPlatformDaily(organizationId: string, agentId: string): Promise<Date | null> {
    const used = await this.readThroughDaily(this.platformDailyKey(agentId), () =>
      this.records.countForAgentSince(organizationId, agentId, utcDayStart()),
    );

    if (used === null) {
      // Neither Redis nor Postgres could answer. This is the platform's own
      // cost ceiling — refuse rather than permit unmetered spend.
      this.logger.warn(
        `agent ${agentId}: platform daily quota unreadable from both Redis and Postgres; refusing.`,
      );
      return nextUtcMidnight();
    }

    return used >= this.config.platformAgentDailyLimit ? nextUtcMidnight() : null;
  }

  private async incrPlatformDaily(organizationId: string, agentId: string): Promise<void> {
    await this.incrDaily(this.platformDailyKey(agentId), () =>
      this.records.countForAgentSince(organizationId, agentId, utcDayStart()),
    );
  }

  private platformDailyKey(agentId: string): string {
    return `${FREE_QUOTA_PLATFORM_DAILY_KEY_PREFIX}${agentId}:${utcDayKey()}`;
  }

  // ── provider: per-agent-per-binding and per-binding budget (fail OPEN) ───

  /**
   * `null` when at least one free/freemium binding behind the tool has
   * headroom on both of its own dials; otherwise which limit blocked every one
   * of them and when the earliest of them resets.
   */
  private async checkProviderLimits(
    organizationId: string,
    agentId: string,
    toolId: string,
  ): Promise<{ readonly limit: FreeQuotaLimitKind; readonly resetsAt: Date } | null> {
    const candidates = await this.freeBindings(toolId);
    if (candidates.length === 0) {
      // Nothing to check against. The caller only reaches `check` on a quote
      // that already priced this tool as FREE/FREEMIUM a moment ago, so an
      // empty set here means the catalogue changed underneath the call — the
      // same "trust the caller's context, do not re-litigate it" stance
      // `McpToolCallService.requireQuote` takes. Permit; the relay path itself
      // will fail cleanly if there is truly nothing to route to.
      return null;
    }

    let blockedByBudgetOnly = true;
    let earliestReset: Date | null = null;

    for (const binding of candidates) {
      const perAgentLimit = binding.freeQuotaPerAgent ?? this.config.defaultPerAgentDailyLimit;
      const budgetLimit = binding.freeDailyBudget ?? this.config.defaultProviderDailyBudget;

      const perAgentUsed = await this.readAgentBindingDaily(organizationId, agentId, binding.id);
      const budgetUsed = await this.readBindingBudget(binding.id);

      const perAgentOk = perAgentUsed === null || perAgentUsed < perAgentLimit;
      const budgetOk = budgetUsed === null || budgetUsed < budgetLimit;

      if (perAgentOk && budgetOk) return null; // this binding has headroom — the tool is servable free

      if (perAgentOk === false) blockedByBudgetOnly = false;

      const reset = nextUtcMidnight();
      if (!earliestReset || reset < earliestReset) earliestReset = reset;
    }

    return {
      limit: blockedByBudgetOnly
        ? FreeQuotaLimitKind.PROVIDER_DAILY_BUDGET
        : FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
      resetsAt: earliestReset ?? nextUtcMidnight(),
    };
  }

  private async readAgentBindingDaily(
    organizationId: string,
    agentId: string,
    bindingId: string,
  ): Promise<number | null> {
    return this.readThroughDaily(this.agentBindingDailyKey(agentId, bindingId), () =>
      this.records.countForAgentBindingSince(organizationId, agentId, bindingId, utcDayStart()),
    );
  }

  private async incrAgentBindingDaily(
    organizationId: string,
    agentId: string,
    bindingId: string,
  ): Promise<void> {
    await this.incrDaily(this.agentBindingDailyKey(agentId, bindingId), () =>
      this.records.countForAgentBindingSince(organizationId, agentId, bindingId, utcDayStart()),
    );
  }

  private async readBindingBudget(bindingId: string): Promise<number | null> {
    return this.readThroughDaily(this.bindingBudgetKey(bindingId), () =>
      this.records.countForBindingSince(bindingId, utcDayStart()),
    );
  }

  private async incrBindingBudget(bindingId: string): Promise<void> {
    await this.incrDaily(this.bindingBudgetKey(bindingId), () =>
      this.records.countForBindingSince(bindingId, utcDayStart()),
    );
  }

  private agentBindingDailyKey(agentId: string, bindingId: string): string {
    return `${FREE_QUOTA_BINDING_AGENT_DAILY_KEY_PREFIX}${bindingId}:${agentId}:${utcDayKey()}`;
  }

  private bindingBudgetKey(bindingId: string): string {
    return `${FREE_QUOTA_BINDING_BUDGET_KEY_PREFIX}${bindingId}:${utcDayKey()}`;
  }

  /** Every `ACTIVE` `FREE`/`FREEMIUM` binding behind the tool, as the domain type. */
  private async freeBindings(toolId: string): Promise<readonly ToolBinding[]> {
    // At the published revision, as the router sees it: a live PAID binding
    // whose draft says FREE is not a free binding until it is published.
    const rows = await this.bindings.findByTool(toolId);
    return (await toServedToolBindings(rows, this.versions)).filter(
      (binding) =>
        binding.status === BindingStatus.ACTIVE &&
        (binding.pricingMode === PricingMode.FREE || binding.pricingMode === PricingMode.FREEMIUM),
    );
  }

  // ── shared read-through / increment machinery ─────────────────────────────

  /**
   * `GET`, falling through to Postgres on a miss or an error — the hydration
   * shape `BindingCallCounterService.observedCalls` uses, reduced to what this
   * class needs: no cache write-back on the read path, because {@link
   * incrDaily} is what publishes a value for the next reader and doing it
   * twice (once on read, once on write) would race two hydrations against
   * each other for no benefit.
   *
   * Returns `null` only when **both** Redis and Postgres failed to answer.
   */
  private async readThroughDaily(
    key: string,
    hydrate: () => Promise<number>,
  ): Promise<number | null> {
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) {
        const value = Number(cached);
        if (Number.isFinite(value)) return value;
      }
    } catch (error) {
      this.logger.warn(`${key}: unreadable, falling through to Postgres. ${describe(error)}`);
    }

    try {
      return await hydrate();
    } catch (error) {
      this.logger.warn(`${key}: Postgres hydration also failed. ${describe(error)}`);
      return null;
    }
  }

  /**
   * `INCR`, with the first write of the day setting the TTL and re-anchoring
   * to Postgres beforehand when the key is missing — the same "the row for
   * this call is already in the table, so hydrate then do not add to it"
   * ordering `BindingCallCounterService.record` uses, adapted to a key that is
   * allowed to expire by design (the day is in the key) rather than one that
   * expires only as a safety net.
   *
   * Best effort: an increment Redis refuses is logged and dropped, never
   * retried and never thrown, matching every other counter on this platform
   * that sits after the response has already been decided.
   */
  private async incrDaily(key: string, hydrate: () => Promise<number>): Promise<void> {
    try {
      if ((await this.redis.exists(key)) === 1) {
        await this.redis.incr(key);
        return;
      }

      // Cache miss. The caller's own write is already reflected in the count
      // `hydrate` returns (consume() runs after the record was written), so
      // the hydrated value IS the post-call count — set it directly rather
      // than incrementing on top of it.
      const count = await hydrate();
      await this.redis
        .set(key, String(count), 'EX', secondsUntilNextUtcDay(), 'NX')
        .catch((error: unknown) => {
          this.logger.warn(`${key}: hydrated count not cached. ${describe(error)}`);
          return null;
        });
    } catch (error) {
      this.logger.warn(`${key}: call not counted. ${describe(error)}`);
    }
  }

  private refuse(
    limit: FreeQuotaLimitKind,
    resetsAt: Date,
    input: FreeQuotaCheckInput,
  ): FreeQuotaRefused {
    const refusal: FreeQuotaRefused = {
      kind: 'REFUSED',
      limit,
      resetsAt,
      fallThroughToPaid: input.pricingMode === PricingMode.FREEMIUM,
    };

    // Fire-and-forget from the caller's point of view: `check()` answers a
    // pre-flight question, and a notification failure must never turn that
    // answer into a rejected promise. `NotificationPort.notify` already
    // promises not to throw (`notification.port.ts`'s own doc comment); the
    // `catch` here is defence against a mock or a future implementation that
    // does not honour it, not an expectation that it will fire.
    this.notifyExhausted(input, refusal).catch((error: unknown) => {
      this.logger.warn(
        `agent ${input.agentId}: free_quota.exhausted notification not sent. ${describe(error)}`,
      );
    });

    return refusal;
  }

  /**
   * `NotificationEvent.FREE_QUOTA_EXHAUSTED` — `INFO`, `ONCE_PER_UTC_DAY`
   * (`NOTIFICATION_CATALOGUE`), so calling this on every refused pre-flight
   * check costs nothing extra: the notification service is what owns
   * deduplicating "already told this agent about this tool today", per
   * `NotificationPort`'s own doc comment (*"suppression is the notification
   * service's business"*).
   */
  private async notifyExhausted(
    input: FreeQuotaCheckInput,
    refusal: FreeQuotaRefused,
  ): Promise<void> {
    await this.notifications.notify({
      organizationId: input.organizationId,
      event: NotificationEvent.FREE_QUOTA_EXHAUSTED,
      title: 'Free quota exhausted',
      body:
        `Agent ${input.agentId} hit its ${refusal.limit} limit for ${input.toolId}. ` +
        `Resets ${refusal.resetsAt.toISOString()}.`,
      subjectType: 'agent',
      subjectId: input.agentId,
      payload: {
        toolId: input.toolId,
        limit: refusal.limit,
        resetsAt: refusal.resetsAt.toISOString(),
        fallThroughToPaid: refusal.fallThroughToPaid,
      },
      dedupeKey: `${input.agentId}:${input.toolId}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** One reservation over several places, released at most once. */
function reservationOf(releases: ReadonlyArray<() => Promise<void>>): FreeQuotaReservation {
  let released = false;
  return {
    kind: 'RESERVED',
    async release() {
      if (released) return;
      released = true;
      await Promise.all(releases.map((release) => release()));
    },
  };
}

function clampRemaining(limit: number, used: number | null): number {
  if (used === null) return limit; // unreadable → the permissive figure, matching the fail-open provider dials
  return Math.max(0, limit - used);
}

/** `YYYY-MM-DD` in UTC — same construction as `BindingCeilingService.utcDayKey`. */
function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Midnight UTC of the current day, as a `Date` — the daily counters' `since`. */
function utcDayStart(now: Date = new Date()): Date {
  return new Date(`${utcDayKey(now)}T00:00:00.000Z`);
}

/** The next UTC midnight — every daily limit's `resetsAt`. */
function nextUtcMidnight(now: Date = new Date()): Date {
  const start = utcDayStart(now);
  return new Date(start.getTime() + 24 * 60 * 60 * 1_000);
}

/** Seconds from now to the next UTC midnight, plus an hour of grace — see `BindingCeilingService`. */
function secondsUntilNextUtcDay(now: Date = new Date()): number {
  return Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 1_000) + 3_600;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
