import { DEFAULT_PLATFORM_FEE_BPS } from '@modules/mcp/services/mcp-pricing.config';
import { loadCollectionHoldWindowSeconds } from '@modules/payment/constants/collection-hold.constants';
import { loadSlashConfig } from '@modules/slash/constants/slash.constants';

/** `$50` at 6 decimals: the code default of `PROVIDER_MINIMUM_STAKE_FLOOR`. */
export const DEFAULT_MINIMUM_STAKE_FLOOR = '50000000';
/** The code default of `PROVIDER_TERMS_PENALTY_SPLIT`. */
export const DEFAULT_PENALTY_SPLIT = '60 / 30 / 10';

/**
 * The env values that stand in for on-chain parameters while the chain cannot
 * be read. Only a fallback: once a chain answered, its value wins in both
 * directions, and a difference is logged and alerted (`EvmChainParamsCache`).
 */
export interface ChainParamsFallback {
  /** `PROVIDER_MINIMUM_STAKE_FLOOR`, atomic units. */
  readonly minimumStake: string;
  /** `PLATFORM_FEE_BPS`. */
  readonly takeRateBps: number;
  /** `PROVIDER_TERMS_PENALTY_SPLIT` as bps, or `null` when it does not parse. */
  readonly slashAgentBps: number | null;
  readonly slashPlatformBps: number | null;
  /** `CALL_DISPUTE_HOLD_WINDOW_MINUTES` × 60. */
  readonly collectHoldSeconds: number;
  /** `SLASH_TIMELOCK_HOURS` × 3600. Also the policy floor under the chain's delay. */
  readonly slashDelaySeconds: number;
}

interface ConfigReader {
  get<T = string>(key: string): T | undefined;
}

export function loadChainParamsFallback(config: ConfigReader): ChainParamsFallback {
  const split = parsePenaltySplitBps(
    config.get<string>('PROVIDER_TERMS_PENALTY_SPLIT') ?? DEFAULT_PENALTY_SPLIT,
  );
  return {
    minimumStake: config.get<string>('PROVIDER_MINIMUM_STAKE_FLOOR') ?? DEFAULT_MINIMUM_STAKE_FLOOR,
    takeRateBps: Number(config.get<string>('PLATFORM_FEE_BPS') ?? String(DEFAULT_PLATFORM_FEE_BPS)),
    slashAgentBps: split?.agentBps ?? null,
    slashPlatformBps: split?.platformBps ?? null,
    collectHoldSeconds: loadCollectionHoldWindowSeconds({
      CALL_DISPUTE_HOLD_WINDOW_MINUTES: config.get<string>('CALL_DISPUTE_HOLD_WINDOW_MINUTES'),
    } as NodeJS.ProcessEnv),
    slashDelaySeconds: Math.round(loadSlashConfig().timelockMs / 1000),
  };
}

/**
 * `"60 / 30 / 10"` → agent 6000 bps, platform 3000 bps (the provider keeps the
 * rest). `null` unless it is exactly three numbers that add up to 100.
 */
export function parsePenaltySplitBps(
  raw: string,
): { agentBps: number; platformBps: number } | null {
  const parts = raw.split('/').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => part === '' || Number.isNaN(Number(part)))) {
    return null;
  }
  const [agent, platform, provider] = parts.map((part) => Math.round(Number(part) * 100));
  if (agent + platform + provider !== 10_000) return null;
  return { agentBps: agent, platformBps: platform };
}
