import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';
import { MetricsRegistryModule } from '@modules/observability/metrics-registry.module';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AuditLogModule } from '@shared/audit/audit-log.module';

import { OAUTH_CONFIG, loadOAuthConfig } from './config/oauth.config';
import { CimdFetcher } from './services/cimd.fetcher';
import { DcrService } from './services/dcr.service';
import { OAuthClientRegistry } from './services/oauth-client.registry';
import { OAuthGrantWriter } from './services/oauth-grant.writer';
import { OAuthMetrics } from './services/oauth-metrics.service';
import { OAuthRateLimiter } from './services/oauth-rate-limiter.service';
import { OAuthTokenService } from './services/oauth-token.service';

/**
 * The OAuth authorization server's core services: its configuration, its
 * metrics, the client registry (built-in, CIMD, DCR), the rate limiter, and
 * the token service with its grant writer (codes, exchange, refresh, revoke).
 *
 * Imported only by the app modules that mount the OAuth routes. Never by the
 * scheduler: it provides `OAUTH_CONFIG`, which fails the boot without the
 * OAuth secrets, and `OAuthMetrics`, which may exist once per container.
 *
 * Relies on the global `PostgresModule` (the OAuth and credential
 * repositories), `RedisCacheModule` (`CacheService`) and `NetworkModule`
 * (`EgressHttpClient`). `NotificationModule` brings `NOTIFICATION_PORT` (the
 * grant-stopped notice) and needs the app's BullMQ root. `AccessEpochService`
 * is provided here rather than imported with the whole `ToolsetModule`: it is
 * stateless over the shared Redis counter, so a second instance is the same.
 */
@Module({
  imports: [MetricsRegistryModule, AuditLogModule, NotificationModule],
  providers: [
    { provide: OAUTH_CONFIG, useFactory: () => loadOAuthConfig() },
    OAuthMetrics,
    OAuthRateLimiter,
    CimdFetcher,
    DcrService,
    OAuthClientRegistry,
    AccessEpochService,
    OAuthGrantWriter,
    OAuthTokenService,
  ],
  exports: [
    OAUTH_CONFIG,
    OAuthMetrics,
    OAuthRateLimiter,
    DcrService,
    OAuthClientRegistry,
    OAuthGrantWriter,
    OAuthTokenService,
  ],
})
export class OAuthCoreModule {}
