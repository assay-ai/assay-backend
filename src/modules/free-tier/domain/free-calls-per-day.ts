import { FreeQuotaConfig } from '../config/free-quota.config';

/** The two published dials of one free-capable binding; `null` means the platform default. */
export interface FreeBindingDials {
  readonly freeQuotaPerAgent: number | null;
  readonly freeDailyBudget: number | null;
}

/**
 * The "N" of *"N free per day, then $X"*: the free calls one agent can get on
 * a tool in a day, from the routable free-capable bindings at their PUBLISHED
 * revision (review 2026-10-15, L2).
 *
 * The router draws a free call onto any of them that still has room and sheds
 * one whose quota is spent, so an agent's allowance is the SUM of what each
 * binding gives it — its per-agent quota, never more than its daily budget —
 * capped by the platform's own per-agent daily ceiling across every free tool.
 * `null` when no binding serves free calls.
 */
export function freeCallsPerDay(
  bindings: readonly FreeBindingDials[],
  config: Pick<
    FreeQuotaConfig,
    'platformAgentDailyLimit' | 'defaultPerAgentDailyLimit' | 'defaultProviderDailyBudget'
  >,
): number | null {
  if (bindings.length === 0) return null;
  const total = bindings.reduce(
    (sum, binding) =>
      sum +
      Math.min(
        binding.freeQuotaPerAgent ?? config.defaultPerAgentDailyLimit,
        binding.freeDailyBudget ?? config.defaultProviderDailyBudget,
      ),
    0,
  );
  return Math.min(total, config.platformAgentDailyLimit);
}
