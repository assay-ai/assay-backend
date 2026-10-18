/**
 * The free tier's numbers.
 *
 * The free tier has four independent limits. Two are the **provider's** own
 * dials (`tool_bindings.free_quota_per_agent`,
 * `tool_bindings.free_daily_budget`) — this file supplies only their fallback
 * when a provider has not set one. The other two are the **platform's**, and
 * are not configurable per binding at all; they are exported here as the
 * numbers, full stop.
 */

/** Per agent, per binding, per day, when a provider has not set `free_quota_per_agent`. */
export const DEFAULT_PER_AGENT_DAILY_QUOTA = 100;

/** Free calls a binding will serve across every agent per day, when unset. */
export const DEFAULT_PROVIDER_DAILY_BUDGET = 50_000;

/** Per agent, across every free tool, per day. Platform-set, not configurable per binding. */
export const PLATFORM_AGENT_DAILY_QUOTA = 1_000;

/** Requests per minute on the relay path, per agent. Platform-set. */
export const PLATFORM_RATE_LIMIT_PER_MINUTE = 60;

/**
 * How long a `tool_call_records` row survives before the retention sweep
 * removes it. The rule is *"Retained 30 days, then aggregated."* No
 * aggregation step exists yet.
 */
export const TOOL_CALL_RECORD_RETENTION_DAYS = 30;

/**
 * `FREE_QUOTA_TIERS` — quota **by agent standing**, so an agent that has ever
 * funded a wallet gets more room than one that has not.
 *
 * **Only `REGISTERED` is live.** The tiers also include `ANONYMOUS` and
 * `DEPOSITED`, and this platform has neither signal to key them on:
 *
 * - Every MCP and REST caller resolves through `SessionAuthGuard` /
 *   `McpSessionPort.resolve`, which throws rather than returning a null
 *   session (`McpSessionPort`'s own doc comment: *"There is no 'anonymous
 *   session'"*). There is no request this platform ever serves as
 *   `ANONYMOUS`.
 * - Whether an agent has ever deposited is a ledger question
 *   (`LedgerJournalService` / `deposit.credited`) that nothing in this module
 *   is wired to read, and adding the read here would reach into
 *   `src/modules/ledger/**` from a module that does not depend on it.
 *
 * So `FreeQuotaService` applies {@link PLATFORM_AGENT_DAILY_QUOTA} and
 * {@link PLATFORM_RATE_LIMIT_PER_MINUTE} — `REGISTERED`'s own figures — to
 * every agent, and this constant is kept honest about the other two rather
 * than silently defaulting every agent to one of them. Wiring `DEPOSITED` to
 * a real deposit-history check is not done yet.
 */
export const FREE_QUOTA_TIERS = {
  /** No such caller exists on this platform. Not read by anything. */
  ANONYMOUS: { platformAgentDaily: 100, rateLimitPerMinute: 20 },
  REGISTERED: {
    platformAgentDaily: PLATFORM_AGENT_DAILY_QUOTA,
    rateLimitPerMinute: PLATFORM_RATE_LIMIT_PER_MINUTE,
  },
  /** No deposit-standing signal exists yet. Not read by anything — see the class doc. */
  DEPOSITED: { platformAgentDaily: 5_000, rateLimitPerMinute: 120 },
} as const;
