import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { Money } from '@modules/chains/ports/money.types';
import { AssetId } from '@modules/chains/ports/caip.types';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { MoneyUtil } from '@shared/utils/money.util';
import {
  NotificationEvent,
  NotificationPort,
  NOTIFICATION_PORT,
} from '@modules/notification/ports/notification.port';

import {
  centsToAtomicUnits,
  SPEND_ALERT_BANDS,
  SPEND_POLICY_DOLLAR_DEFAULTS,
  SPEND_POLICY_VELOCITY_DEFAULTS,
} from '../constants/spend-policy-defaults.constants';
import { utcHourStart, utcNextDayStart, utcNextMonthStart } from '../domain/spend-window.util';
import { SpendUsageService } from './spend-usage.service';
import { SpendPolicyVelocityService, VelocityViolationKind } from './spend-policy-velocity.service';

/** How long one agent's spend lock lives at most: well above one check-and-hold. */
export const AGENT_SPEND_LOCK_TTL_MS = 15_000;
/** How long a call waits for the agent's spend lock before it is refused, retryably. */
export const AGENT_SPEND_LOCK_WAIT_MS = 10_000;
const AGENT_SPEND_LOCK_POLL_MS = 25;

/** What the caller wants to spend money on, before any of it is reserved. */
export interface AssertCallAllowedInput {
  readonly organizationId: string;
  readonly agentId: string;
  readonly toolId: string;
  readonly price: Money;
  /**
   * `computeRoutedCallHash(...)` for this exact call — the same value that
   * ends up as `payment_intents.request_hash`.
   *
   * **Added deliberately.** The duplicate-request check has no other way to
   * know two calls are "identical": `assertCallAllowed`'s other four
   * parameters are already known before the tool's arguments are even read,
   * and the hash is exactly `{method, path, toolId, amount, asset, query,
   * body}` folded into one comparable value. See this service's class doc,
   * "What the orchestrator must compute once", for the exact call-site
   * contract this implies.
   */
  readonly requestHash: string;
}

/**
 * The single pre-flight gate `tools/call` runs before any money is held.
 *
 * ```text
 *  1. paused?                      → MCP_POLICY_AGENT_PAUSED     (not retryable)
 *  2. tool on the allowlist?       → MCP_TOOL_NOT_ALLOWED        (not retryable)
 *  3. per-call ceiling?            → MCP_SPEND_LIMIT_EXCEEDED    (not retryable)
 *  3b. above requireApprovalAbove? → MCP_APPROVAL_REQUIRED       (not retryable)
 *  4. velocity (min/hr/dup)        → MCP_VELOCITY_LIMIT_EXCEEDED (retryable)
 *  4b. spend/hour                  → MCP_VELOCITY_LIMIT_EXCEEDED (retryable)
 *  5. daily / monthly cap?         → MCP_SPEND_LIMIT_EXCEEDED    (not retryable)
 *  6. (never blocks) 50/80/100% alert bands → `spend.threshold_crossed`
 * ```
 *
 * ## Why this order, exactly
 *
 * **Pause first.** A paused agent's calls fail for one reason no matter what
 * else is true about the policy — a human stopped this — and this must read
 * differently from every other refusal:
 * *"so the agent's logs say 'a human stopped this', not 'out of money'."* If
 * pause were checked after a cap, an agent whose cap happened to also be
 * exhausted would see `MCP_SPEND_LIMIT_EXCEEDED` and never learn a human
 * intervened.
 *
 * **Allowlist before any money math.** `MCP_TOOL_NOT_ALLOWED` is a
 * configuration fact — this tool is categorically off-limits for this agent —
 * and it is cheaper to decide (an array membership test) than every check
 * below it. There is also no sense in which "you're $0.01 over budget" is a
 * more useful answer than "this tool isn't on your list" when both are true.
 *
 * **Per-call before velocity, velocity before the period caps.** Each check
 * is strictly narrower in scope than the next: per-call looks at nothing but
 * this one price, velocity looks at the last minute/hour, the period caps
 * look at the whole day or month. Deciding narrow-to-wide means a call that
 * fails narrowly is never charged the cost of a wide query first — the
 * per-call check is a comparison against a field already on `policy`, the
 * velocity check is Redis, the period caps are a `payment_intents` query.
 * Cheapest and most specific first.
 *
 * **Spend/hour is measured like the period caps, not like the attempt
 * counters.** It is the same `payment_intents` read (open holds + `SETTLED`,
 * `SPEND_COUNTING_STATUSES`) split at the top of the UTC hour, so a call that
 * was refused, voided or refunded never counts toward it — the attempt
 * counters in Redis cannot be told a call was later voided, and summing every
 * attempt's price there locked agents out after a run of voided calls with
 * nothing spent. It is still reported as a velocity violation (`retryable`,
 * `retryAfter` = the end of the hour), which is what it has always been.
 *
 * **Alert bands last, and never blocking.** *"An alert never blocks a
 * call."* They can only be evaluated once the call is known to be allowed —
 * evaluating them earlier and only conditionally skipping the notify would
 * invite exactly the bug that rule warns about, a screen where "tell me" and
 * "stop me" share one code path.
 *
 * ## No policy is not a blocked agent
 *
 * There is today no code path that creates an organization's default policy
 * row (`spend_policies` with `agent_id IS NULL`) — nothing has ever called
 * `POST`/`PATCH` at the organization scope, because `SpendPolicyService.patch`
 * deliberately never writes there (see that class's own doc comment). So the
 * very first call `assertCallAllowed` ever sees for a new organization finds
 * no row at any scope.
 *
 * The right behaviour is **not** to refuse it — an ungoverned agent is not
 * the same thing as a paused one, and refusing every call until an operator
 * has visited a settings screen would make onboarding depend on a step
 * nothing prompts for. Instead this method closes the gap itself, cheaply:
 * it seeds the **organization default** row from {@link
 * SPEND_POLICY_DOLLAR_DEFAULTS} / {@link SPEND_POLICY_VELOCITY_DEFAULTS},
 * denominated in *this call's* asset (the only asset it has any information
 * about), `changedBy: 'system:g27a-auto-seed'`, and then re-resolves and
 * enforces against the row it just wrote — so the very first call an agent
 * ever makes is already governed by the documented default numbers, not by
 * nothing.
 *
 * The seed is racy by design rather than locked: two concurrent first calls
 * for the same organization can both attempt the insert, and the partial
 * unique index on `(organization_id, agent_id) WHERE superseded_at IS NULL`
 * (the same one `SpendPolicyService.writeVersion` relies on) lets exactly one
 * win. The loser catches `23505`, re-reads, and enforces against the
 * winner's row — nobody's call fails because of the race. If seeding fails
 * for any other reason (a transient DB error), the call is **permitted**
 * with no policy version recorded (`payment_intents.spend_policy_version` is
 * nullable precisely for this case — see that column's own doc comment) —
 * the fallback an unreachable database leaves is the same one "no policy
 * exists" always had: an unattributed, ungoverned call, logged as a warning
 * rather than silently swallowed.
 *
 * ## The single-asset assumption
 *
 * A `spend_policies` row denominates every limit in one asset
 * (`spend_policies.asset_id`). If this call's `price.asset` differs from the
 * resolved policy's asset, every **money** check below (per-call, velocity's
 * spend/hour, the daily/monthly cap, the alert bands) is skipped — `MoneyUtil`
 * refuses to compare two different assets, and coercing one into the other's
 * units is not this service's job. The **non-money** checks (paused,
 * allowlist, calls/minute, calls/hour, duplicate-hash) still run, since none
 * of them depend on which asset the price is in. This is a real, deliberate
 * gap: a multi-asset spend policy does not exist in this schema, and every
 * deployment this platform runs today prices every tool in one settlement
 * asset, so the gap has never been reachable in practice.
 *
 * ## What the orchestrator must compute once
 *
 * `computeRoutedCallHash` is already computed by `McpToolCallService.call`
 * today, inline inside the `intents.create(...)` call. The insertion point
 * for `assertCallAllowed` must compute that same hash **once**, before both
 * calls, and pass it to both — see this module's `README`-equivalent in the
 * goal report for the exact diff shape.
 */
@Injectable()
export class SpendPolicyEnforcementService {
  private readonly logger = new Logger(SpendPolicyEnforcementService.name);

  constructor(
    private readonly policies: SpendPolicyRepository,
    private readonly usage: SpendUsageService,
    private readonly velocity: SpendPolicyVelocityService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
  ) {}

  /**
   * Runs `fn` — the cap check and the reservation it allows — holding the
   * agent's spend lock, so the two are atomic per agent (review 2026-10-15
   * P-6).
   *
   * {@link assertCallAllowed} sums what the agent has held or settled, and the
   * caller then writes the intent and its hold. Without a lock, N concurrent
   * calls all read the same sum and all fit, and every money cap is overshot
   * by up to N calls. The caller puts the check AND the hold inside `fn`; the
   * next call of the same agent waits, and its sum then counts this hold.
   *
   * A Redis lock rather than a Postgres one because the critical section spans
   * several services and connections (the intent insert, the ledger hold, a
   * voucher's checks); an advisory lock would hold a pool connection while
   * waiting on the others. It expires after {@link AGENT_SPEND_LOCK_TTL_MS}, so
   * a crashed holder cannot stop an agent for longer than that. Fails closed:
   * Redis unreachable, or the lock still busy after
   * {@link AGENT_SPEND_LOCK_WAIT_MS}, is a retryable velocity refusal, and
   * nothing was reserved.
   */
  async withAgentSpendLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + AGENT_SPEND_LOCK_WAIT_MS;
    for (;;) {
      let claimed: boolean;
      try {
        claimed = await this.velocity.tryLockAgentSpend(agentId, token, AGENT_SPEND_LOCK_TTL_MS);
      } catch (error) {
        this.logger.warn(`agent ${agentId}: spend lock unavailable. ${describe(error)}`);
        throw McpErrors.velocityLimitExceeded({
          reason: VelocityViolationKind.UNAVAILABLE,
          retryAfter: 1,
        });
      }
      if (claimed) break;
      if (Date.now() >= deadline) {
        throw McpErrors.velocityLimitExceeded({
          reason: VelocityViolationKind.UNAVAILABLE,
          retryAfter: 1,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, AGENT_SPEND_LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      await this.velocity.unlockAgentSpend(agentId, token);
    }
  }

  async assertCallAllowed(input: AssertCallAllowedInput): Promise<number | null> {
    const { organizationId, agentId, toolId, price, requestHash } = input;

    const policy = await this.resolveLivePolicy(organizationId, agentId, price);
    if (!policy) {
      this.logger.warn(
        `org ${organizationId} agent ${agentId}: no spend policy could be resolved or seeded; ` +
          `permitting the call ungoverned`,
      );
      return null;
    }

    // 1. Paused — "a human stopped this", checked before anything else can
    // give a different, wrong reason.
    if (policy.paused) {
      throw McpErrors.policyAgentPaused({ agentId });
    }

    // 2. Allowlist — `NULL` = every tool, `[]` = no tool (the entity's own
    // doc comment).
    if (policy.allowedTools !== null && !policy.allowedTools.includes(toolId)) {
      throw McpErrors.toolNotAllowed({ toolId, allowedTools: policy.allowedTools });
    }

    const sameAsset = price.asset === policy.assetId;
    if (!sameAsset) {
      this.logger.warn(
        `agent ${agentId}: call priced in ${price.asset} but the policy is denominated in ` +
          `${policy.assetId}; skipping every money-based check for this call (see class doc)`,
      );
    }

    // 3. Per-call ceiling.
    if (sameAsset && policy.perCallMax !== null) {
      const limit = MoneyUtil.of(policy.perCallMax, policy.assetId as AssetId, policy.decimals);
      if (MoneyUtil.greaterThan(price, limit)) {
        throw McpErrors.spendLimitExceeded({
          limitType: 'per_call',
          limit: limit.amount,
          asset: limit.asset,
        });
      }
    }

    // 3b. Approval threshold. There is no approval flow to ask, so a call above
    // it is refused: an approval nobody can give resolves to DENY, never ALLOW.
    // Before velocity, like the per-call ceiling, so a refused call is not counted.
    if (sameAsset && policy.requireApprovalAbove !== null) {
      const threshold = MoneyUtil.of(
        policy.requireApprovalAbove,
        policy.assetId as AssetId,
        policy.decimals,
      );
      if (MoneyUtil.greaterThan(price, threshold)) {
        throw McpErrors.approvalRequired({ threshold: threshold.amount, asset: threshold.asset });
      }
    }

    // 4. Velocity — calls/minute, calls/hour, duplicate-hash (attempts).
    const violation = await this.velocity.consume(agentId, requestHash, {
      maxCallsPerMinute: policy.maxCallsPerMinute,
      maxCallsPerHour: policy.maxCallsPerHour,
    });

    if (violation) {
      if (violation.kind === VelocityViolationKind.DUPLICATE_REQUEST && violation.freshAnomaly) {
        await this.notifyVelocityAnomaly(organizationId, agentId, requestHash);
      }
      throw McpErrors.velocityLimitExceeded({
        reason: violation.kind,
        retryAfter: violation.retryAfterSeconds,
      });
    }

    // 4b + 5. Spend/hour and the daily / monthly cap — money held or settled.
    let spendToday: Money | null = null;
    let spendThisMonth: Money | null = null;
    if (
      sameAsset &&
      (policy.maxSpendPerHour !== null || policy.dailyCap !== null || policy.monthlyCap !== null)
    ) {
      const usage = await this.usage.spendSoFar(
        organizationId,
        agentId,
        policy.assetId as AssetId,
        policy.decimals,
      );
      spendToday = usage.spendToday;
      spendThisMonth = usage.spendThisMonth;

      if (policy.maxSpendPerHour !== null) {
        const ceiling = MoneyUtil.of(
          policy.maxSpendPerHour,
          policy.assetId as AssetId,
          policy.decimals,
        );
        if (MoneyUtil.greaterThan(MoneyUtil.add(usage.spendThisHour, price), ceiling)) {
          const now = new Date();
          throw McpErrors.velocityLimitExceeded({
            reason: VelocityViolationKind.SPEND_PER_HOUR,
            retryAfter: Math.ceil(
              (utcHourStart(now).getTime() + 60 * 60_000 - now.getTime()) / 1_000,
            ),
          });
        }
      }

      if (policy.dailyCap !== null) {
        const cap = MoneyUtil.of(policy.dailyCap, policy.assetId as AssetId, policy.decimals);
        const afterThisCall = MoneyUtil.add(spendToday, price);
        if (MoneyUtil.greaterThan(afterThisCall, cap)) {
          throw McpErrors.spendLimitExceeded({
            limitType: 'daily',
            limit: cap.amount,
            asset: cap.asset,
            resetsAt: utcNextDayStart(new Date()).toISOString(),
          });
        }
      }

      if (policy.monthlyCap !== null) {
        const cap = MoneyUtil.of(policy.monthlyCap, policy.assetId as AssetId, policy.decimals);
        const afterThisCall = MoneyUtil.add(spendThisMonth, price);
        if (MoneyUtil.greaterThan(afterThisCall, cap)) {
          throw McpErrors.spendLimitExceeded({
            limitType: 'monthly',
            limit: cap.amount,
            asset: cap.asset,
            resetsAt: utcNextMonthStart(new Date()).toISOString(),
          });
        }
      }
    }

    // 6. Alert bands — never blocks. Best-effort: a notification failure must
    // not turn an otherwise-successful call into an error.
    if (sameAsset && spendToday && spendThisMonth) {
      await this.emitCrossedBands(
        organizationId,
        agentId,
        price,
        policy,
        spendToday,
        spendThisMonth,
      ).catch((error) => {
        this.logger.warn(`agent ${agentId}: alert-band notification failed. ${describe(error)}`);
      });
    }

    return policy.policyVersion;
  }

  // ── Resolution and seeding ──────────────────────────────────────────────

  private async resolveLivePolicy(
    organizationId: string,
    agentId: string,
    price: Money,
  ): Promise<SpendPolicyEntity | null> {
    const existing = await this.policies.findLive(organizationId, agentId);
    if (existing) return existing;

    try {
      await this.seedOrganizationDefault(organizationId, price);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        this.logger.warn(
          `org ${organizationId}: could not seed a default spend policy. ${describe(error)}`,
        );
        return null;
      }
      // Lost the seed race to a concurrent first call — fall through and
      // re-read what the winner wrote.
    }

    return this.policies.findLive(organizationId, agentId);
  }

  /** The documented defaults, written once as the organization default. */
  private async seedOrganizationDefault(organizationId: string, price: Money): Promise<void> {
    const decimals = price.decimals;
    await this.policies.insert({
      organizationId,
      agentId: null,
      policyVersion: 1,
      assetId: price.asset,
      decimals,
      perCallMax: centsToAtomicUnits(SPEND_POLICY_DOLLAR_DEFAULTS.perCallMaxCents, decimals),
      dailyCap: centsToAtomicUnits(SPEND_POLICY_DOLLAR_DEFAULTS.dailyCapCents, decimals),
      monthlyCap: centsToAtomicUnits(SPEND_POLICY_DOLLAR_DEFAULTS.monthlyCapCents, decimals),
      maxCallsPerHour: null,
      maxCallsPerMinute: SPEND_POLICY_VELOCITY_DEFAULTS.maxCallsPerMinute,
      maxSpendPerHour: centsToAtomicUnits(
        SPEND_POLICY_DOLLAR_DEFAULTS.maxSpendPerHourCents,
        decimals,
      ),
      allowedTools: null,
      requireApprovalAbove: centsToAtomicUnits(
        SPEND_POLICY_DOLLAR_DEFAULTS.requireApprovalAboveCents,
        decimals,
      ),
      paused: false,
      changedBy: 'system:g27a-auto-seed',
      changeReason: 'auto-provisioned organization default (FA-20 documented defaults)',
      supersededAt: null,
    });
  }

  // ── Alert bands ──────────────────────────────────────────────────────────

  private async emitCrossedBands(
    organizationId: string,
    agentId: string,
    price: Money,
    policy: SpendPolicyEntity,
    spendTodayBefore: Money,
    spendThisMonthBefore: Money,
  ): Promise<void> {
    const asset = policy.assetId as AssetId;

    if (policy.dailyCap !== null) {
      const cap = MoneyUtil.of(policy.dailyCap, asset, policy.decimals);
      await this.emitCrossedBandsForScope(
        organizationId,
        agentId,
        'daily',
        cap,
        spendTodayBefore,
        price,
      );
    }

    if (policy.monthlyCap !== null) {
      const cap = MoneyUtil.of(policy.monthlyCap, asset, policy.decimals);
      await this.emitCrossedBandsForScope(
        organizationId,
        agentId,
        'monthly',
        cap,
        spendThisMonthBefore,
        price,
      );
    }
  }

  /**
   * Which bands (if any) this one call newly crosses, for one scope
   * (`daily`/`monthly`), and notifies for each.
   *
   * The producer decides the edge itself — the same idiom `LedgerJournalService`
   * uses for `BALANCE_LOW` (`notification-catalogue.ts`'s own comment: *"only
   * the producer can see an edge"*) — by comparing spend **before** and
   * **after** this call against each band's threshold, rather than asking
   * "is spend currently above X", which would re-fire on every call after the
   * first crossing. Downstream aggregation (`ONCE_PER_UTC_DAY` for this
   * event) is a second, coarser backstop, not the mechanism this relies on.
   */
  private async emitCrossedBandsForScope(
    organizationId: string,
    agentId: string,
    scope: 'daily' | 'monthly',
    cap: Money,
    spendBefore: Money,
    price: Money,
  ): Promise<void> {
    const spendAfter = MoneyUtil.add(spendBefore, price);
    const capAtomic = MoneyUtil.toAtomic(cap);
    if (capAtomic === 0n) return;

    for (const band of SPEND_ALERT_BANDS) {
      const threshold = (capAtomic * BigInt(band)) / 100n;
      const crossedNow =
        MoneyUtil.toAtomic(spendBefore) < threshold && MoneyUtil.toAtomic(spendAfter) >= threshold;
      if (!crossedNow) continue;

      await this.notifications.notify({
        organizationId,
        event: NotificationEvent.SPEND_THRESHOLD_CROSSED,
        title: `${scope === 'daily' ? 'Daily' : 'Monthly'} spend at ${band}%`,
        body:
          `Agent ${agentId} has spent ${MoneyUtil.format(spendAfter)} of its ` +
          `${MoneyUtil.format(cap)} ${scope} limit (${band}%).`,
        subjectType: 'agent',
        subjectId: agentId,
        payload: { scope, band, spendAfter: spendAfter.amount, cap: cap.amount, asset: cap.asset },
        dedupeKey: `${agentId}:${scope}:${band}`,
      });
    }
  }

  private async notifyVelocityAnomaly(
    organizationId: string,
    agentId: string,
    requestHash: string,
  ): Promise<void> {
    try {
      await this.notifications.notify({
        organizationId,
        event: NotificationEvent.VELOCITY_ANOMALY,
        title: 'Unusual call pattern detected',
        body: `Agent ${agentId} sent the same request repeatedly in a short window and has been throttled.`,
        subjectType: 'agent',
        subjectId: agentId,
        payload: { requestHash },
        dedupeKey: `${agentId}:${requestHash}`,
      });
    } catch (error) {
      this.logger.warn(
        `agent ${agentId}: velocity-anomaly notification failed. ${describe(error)}`,
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  return (
    candidate.code === UNIQUE_VIOLATION_CODE ||
    candidate.driverError?.code === UNIQUE_VIOLATION_CODE
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
