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
   * Configurable through `PLATFORM_FEE_BPS`; the code default is 2000 (20%).
   * The same rate applies to every tier, because a rate per tier is a decision
   * nobody has taken. The fee is on the intent, on the receipt, and greppable.
   */
  readonly platformFeeBps: number;
}

/** DI token for the bound {@link McpPricingConfig}. */
export const MCP_PRICING = 'MCP_PRICING';

/** 20%, the code default for the platform fee. Configurable via `PLATFORM_FEE_BPS`. */
export const DEFAULT_PLATFORM_FEE_BPS = 2000;
