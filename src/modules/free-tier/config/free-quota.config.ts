import { ConfigService } from '@nestjs/config';

import {
  DEFAULT_PER_AGENT_DAILY_QUOTA,
  DEFAULT_PROVIDER_DAILY_BUDGET,
  PLATFORM_AGENT_DAILY_QUOTA,
  PLATFORM_RATE_LIMIT_PER_MINUTE,
  TOOL_CALL_RECORD_RETENTION_DAYS,
} from '../constants/free-quota.constants';

/**
 * The free tier's numbers, injected rather than compiled in — same reasoning
 * as `MCP_PRICING`: a ceiling that needs a deploy to move is a ceiling nobody
 * can react to on the day it turns out to be wrong.
 */
export interface FreeQuotaConfig {
  /** Per agent, across every free tool, per day. */
  readonly platformAgentDailyLimit: number;
  /** Requests per minute on the relay path, per agent. */
  readonly platformRateLimitPerMinute: number;
  /** Per agent, per binding, per day, when the provider has not set one. */
  readonly defaultPerAgentDailyLimit: number;
  /** Free calls a binding will serve daily, across every agent, when unset. */
  readonly defaultProviderDailyBudget: number;
  /** Days a `tool_call_records` row survives before the retention sweep. */
  readonly retentionDays: number;
  /** Rows removed per retention sweep pass. */
  readonly retentionSweepBatchSize: number;
}

/** DI token for the bound {@link FreeQuotaConfig}. */
export const FREE_QUOTA_CONFIG = Symbol('FREE_QUOTA_CONFIG');

export const DEFAULT_FREE_QUOTA_CONFIG: FreeQuotaConfig = {
  platformAgentDailyLimit: PLATFORM_AGENT_DAILY_QUOTA,
  platformRateLimitPerMinute: PLATFORM_RATE_LIMIT_PER_MINUTE,
  defaultPerAgentDailyLimit: DEFAULT_PER_AGENT_DAILY_QUOTA,
  defaultProviderDailyBudget: DEFAULT_PROVIDER_DAILY_BUDGET,
  retentionDays: TOOL_CALL_RECORD_RETENTION_DAYS,
  retentionSweepBatchSize: 500,
};

export function freeQuotaConfigFactory(configService: ConfigService): FreeQuotaConfig {
  return {
    platformAgentDailyLimit: positive(
      configService.get<string>('FREE_QUOTA_PLATFORM_AGENT_DAILY_LIMIT'),
      DEFAULT_FREE_QUOTA_CONFIG.platformAgentDailyLimit,
    ),
    platformRateLimitPerMinute: positive(
      configService.get<string>('FREE_QUOTA_PLATFORM_RATE_LIMIT_PER_MINUTE'),
      DEFAULT_FREE_QUOTA_CONFIG.platformRateLimitPerMinute,
    ),
    defaultPerAgentDailyLimit: positive(
      configService.get<string>('FREE_QUOTA_DEFAULT_PER_AGENT_DAILY_LIMIT'),
      DEFAULT_FREE_QUOTA_CONFIG.defaultPerAgentDailyLimit,
    ),
    defaultProviderDailyBudget: positive(
      configService.get<string>('FREE_QUOTA_DEFAULT_PROVIDER_DAILY_BUDGET'),
      DEFAULT_FREE_QUOTA_CONFIG.defaultProviderDailyBudget,
    ),
    retentionDays: positive(
      configService.get<string>('FREE_QUOTA_RETENTION_DAYS'),
      DEFAULT_FREE_QUOTA_CONFIG.retentionDays,
    ),
    retentionSweepBatchSize: positive(
      configService.get<string>('FREE_QUOTA_RETENTION_SWEEP_BATCH_SIZE'),
      DEFAULT_FREE_QUOTA_CONFIG.retentionSweepBatchSize,
    ),
  };
}

/**
 * `''`, `0`, a negative and `NaN` all fall back to the default — same guard as
 * `evidenceRetentionConfigFactory`'s, and for the same reason: a `0` here
 * reads like "unlimited" or "keep nothing" depending on the field, and both
 * readings are wrong for every field on this interface.
 */
function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
