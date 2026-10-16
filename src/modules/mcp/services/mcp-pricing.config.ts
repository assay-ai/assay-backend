/**
 * What the platform keeps from a tool call.
 *
 * One number, injected rather than compiled in, for the reason that applies
 * to economic parameters generally: a take rate that needs a deploy to
 * change is a take rate nobody can negotiate.
 */
export interface McpPricingConfig {
  /**
   * Basis points of the quoted price retained by the platform.
   *
   * Configurable through `PLATFORM_FEE_BPS`; the code default is 1000 (10%),
   * the take rate the provider terms, the operator economics view and the EVM
   * escrow's `takeRateBps` all state.
   * The same rate applies to every tier, because a rate per tier is a decision
   * nobody has taken. The fee is on the intent, on the receipt, and greppable.
   */
  readonly platformFeeBps: number;
}

/** DI token for the bound {@link McpPricingConfig}. */
export const MCP_PRICING = 'MCP_PRICING';

/** 10%, the code default for the platform fee. Configurable via `PLATFORM_FEE_BPS`. */
export const DEFAULT_PLATFORM_FEE_BPS = 1000;

/**
 * The platform take rate in percent, from `PLATFORM_FEE_BPS` — the one source
 * for every surface that prints the rate (provider terms, operator economics,
 * provider reconciliation), so none of them can state a rate that differs from
 * what a call is charged (R17-R-03). `1000` bps → `10`, `1250` → `12.5`.
 */
export function platformTakeRatePercent(config: {
  get<T = string>(key: string): T | undefined;
}): number {
  return Number(config.get<string>('PLATFORM_FEE_BPS') ?? String(DEFAULT_PLATFORM_FEE_BPS)) / 100;
}
