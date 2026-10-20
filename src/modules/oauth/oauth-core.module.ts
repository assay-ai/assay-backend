import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { AuditLogModule } from '@shared/audit/audit-log.module';
import { APP_ROLE, AppRole, resolveAppRole } from '@shared/app-role/app-role';

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
 * Imported only by the app modules that mount the OAuth routes. What it
 * needs depends on `APP_ROLE`: only the MCP app (`/oauth/authorize`,
 * `continue`) requires `OAUTH_REQUEST_COOKIE_SECRET` and pre-warms the
 * verified clients' metadata; the API app does neither. Never by the
 * scheduler: it provides `OAUTH_CONFIG`, which fails the boot without the
 * OAuth secrets, and `OAuthMetrics`, the request-path counters.
 *
 * Relies on the global `PostgresModule` (the OAuth and credential
 * repositories), `RedisCacheModule` (`CacheService`) and `NetworkModule`
 * (`EgressHttpClient`). `NotificationModule` brings `NOTIFICATION_PORT` (the
 * grant-stopped notice) and needs the app's BullMQ root. `AccessEpochService`
 * is provided here rather than imported with the whole `ToolsetModule`: it is
 * stateless over the shared Redis counter, so a second instance is the same.
 */
@Module({
  imports: [AuditLogModule, NotificationModule],
  providers: [
    {
      provide: OAUTH_CONFIG,
      // The API app (consent API) neither needs nor holds the request-cookie secret.
      useFactory: (role?: AppRole) => loadOAuthConfig(process.env, resolveAppRole(role)),
      inject: [{ token: APP_ROLE, optional: true }],
    },
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
