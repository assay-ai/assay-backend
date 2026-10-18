import { Module } from '@nestjs/common';

import { MetricsRegistryModule } from '@modules/observability/metrics-registry.module';

import { OAUTH_CONFIG, loadOAuthConfig } from './config/oauth.config';
import { CimdFetcher } from './services/cimd.fetcher';
import { DcrService } from './services/dcr.service';
import { OAuthClientRegistry } from './services/oauth-client.registry';
import { OAuthMetrics } from './services/oauth-metrics.service';
import { OAuthRateLimiter } from './services/oauth-rate-limiter.service';

/**
 * The OAuth authorization server's core services: its configuration, its
 * metrics, the client registry (built-in, CIMD, DCR) and the rate limiter.
 *
 * Imported only by the app modules that mount the OAuth routes. Never by the
 * scheduler: it provides `OAUTH_CONFIG`, which fails the boot without the
 * OAuth secrets, and `OAuthMetrics`, which may exist once per container.
 *
 * Relies on the global `PostgresModule` (`OAuthClientRepository`),
 * `RedisCacheModule` (`CacheService`) and `NetworkModule` (`EgressHttpClient`).
 */
@Module({
  imports: [MetricsRegistryModule],
  providers: [
    { provide: OAUTH_CONFIG, useFactory: () => loadOAuthConfig() },
    OAuthMetrics,
    OAuthRateLimiter,
    CimdFetcher,
    DcrService,
    OAuthClientRegistry,
  ],
  exports: [OAUTH_CONFIG, OAuthMetrics, OAuthRateLimiter, DcrService, OAuthClientRegistry],
})
export class OAuthCoreModule {}
