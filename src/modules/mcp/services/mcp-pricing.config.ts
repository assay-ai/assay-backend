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
   * The fallback, `PLATFORM_FEE_BPS`: used only on a chain whose contract
   * rate is not known ({@link platformFeeBpsFor}). The code default is 1000 (10%),
   * the take rate the provider terms, the operator economics view and the EVM
   * escrow's `takeRateBps` all state.
   * The same rate applies to every tier, because a rate per tier is a decision
   * nobody has taken. The fee is on the intent, on the receipt, and greppable.
   */
  readonly platformFeeBps: number;
  /**
   * The settlement contract's own `takeRateBps` for `chainId` (the on-chain
   * params cache), which the escrow splits every collected payment with.
   * `null` (or absent) for a chain whose contract was never read, or that has
   * none: {@link platformFeeBps} applies there.
   */
  readonly platformFeeBpsFor?: (chainId: string) => number | null;
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

/**
 * {@link McpPricingConfig} from config and the on-chain params cache: the
 * contract's `takeRateBps` for a chain it has read (`source: 'chain'`), and
 * `PLATFORM_FEE_BPS` for any other chain (never read yet, or no contract).
 */
export function mcpPricingFrom(
  config: { get<T = string>(key: string): T | undefined },
  params: {
    current(chainId: never): { source: 'chain' | 'config'; takeRateBps: number | null } | null;
  } | null,
): McpPricingConfig {
  return {
    platformFeeBps: Number(
      config.get<string>('PLATFORM_FEE_BPS') ?? String(DEFAULT_PLATFORM_FEE_BPS),
    ),
    platformFeeBpsFor: (chainId) => {
      const live = params?.current(chainId as never);
      return live?.source === 'chain' ? live.takeRateBps : null;
    },
  };
}
