import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type { McpUnauthorizedReason } from '@modules/mcp/ports/mcp-unauthorized.port';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import {
  isAllowedOAuthCounterLabel,
  OAUTH_COUNTER_TTL_MS,
  OAuthAuthorizeOutcome,
  OAuthCimdFetchResult,
  OAuthConsentStep,
  OAuthCounterName,
  oauthCounterKey,
  OAuthTokenGrantType,
  OAuthTokenResult,
} from '../domain/oauth-counters';
import { OAUTH_CLOCK } from './oauth-rate-limiter.service';

export type {
  OAuthAuthorizeOutcome,
  OAuthCimdFetchResult,
  OAuthConsentStep,
  OAuthTokenGrantType,
  OAuthTokenResult,
};
export type { McpUnauthorizedReason };

/**
 * The request-path OAuth counters of spec §6.7, as hourly Redis counters the
 * operator dashboard reads (`OAuthSignalsReader`); see `oauth-counters.ts` for
 * the keys and the label allow-lists.
 *
 * Every method resolves, never rejects: a Redis failure is logged at debug and
 * the request goes on. A label outside its allow-list is not counted. Counts
 * the database already holds (grace uses, reuse, DCR registrations, live
 * grants) are not counted here; the dashboard reads them from their tables.
 *
 * Provided by `OAuthCoreModule`, which the scheduler never imports.
 */
@Injectable()
export class OAuthMetrics {
  private readonly logger = new Logger(OAuthMetrics.name);

  constructor(
    @Optional() private readonly cache?: CacheService,
    @Optional() @Inject(OAUTH_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  incAuthorize(outcome: OAuthAuthorizeOutcome): Promise<void> {
    return this.count('authorize', outcome);
  }

  incConsent(step: OAuthConsentStep): Promise<void> {
    return this.count('consent', step);
  }

  incToken(grantType: OAuthTokenGrantType, result: OAuthTokenResult): Promise<void> {
    return this.count('token', `${grantType}.${result}`);
  }

  incCimdFetch(result: OAuthCimdFetchResult): Promise<void> {
    return this.count('cimd_fetch', result);
  }

  incMcpUnauthorized(reason: McpUnauthorizedReason): Promise<void> {
    return this.count('mcp_unauthorized', reason);
  }

  private async count(name: OAuthCounterName, label: string): Promise<void> {
    if (!this.cache || !isAllowedOAuthCounterLabel(name, label)) return;
    const key = oauthCounterKey(name, label, this.now());
    try {
      const redis = this.cache.getRedisClient();
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, OAUTH_COUNTER_TTL_MS);
    } catch (error) {
      this.logger.debug(
        `OAuth counter ${name} not recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
