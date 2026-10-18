import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { OAuthAccessTokenRepository } from '@database/postgres/repositories/oauth-access-token.repository';
import { OAuthAuthorizationCodeRepository } from '@database/postgres/repositories/oauth-authorization-code.repository';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { OAuthRefreshTokenRepository } from '@database/postgres/repositories/oauth-refresh-token.repository';
import { AppSchedulerModule } from '@bootstrap/scheduler/app.module';
import { OAUTH_CONFIG } from '@modules/oauth/config/oauth.config';
import { NotificationModule } from '@modules/notification/notification.module';
import { NOTIFICATION_PORT } from '@modules/notification/ports/notification.port';
import { OAuthCoreModule } from '@modules/oauth/oauth-core.module';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import { DcrService } from '@modules/oauth/services/dcr.service';
import { OAuthClientRegistry } from '@modules/oauth/services/oauth-client.registry';
import { OAuthGrantWriter } from '@modules/oauth/services/oauth-grant.writer';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { OAuthRateLimiter } from '@modules/oauth/services/oauth-rate-limiter.service';
import { OAuthTokenService } from '@modules/oauth/services/oauth-token.service';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { EgressHttpClient } from '@shared/network/egress';

import {
  FakeOAuthClientRepository,
  FakeOAuthRedis,
  fakeCache,
  oauthConfig,
} from './helpers/oauth-fakes';

/** Stands in for the global Postgres, Redis cache and network modules. */
@Global()
@Module({
  providers: [
    { provide: getDataSourceToken('postgres'), useValue: {} },
    { provide: OAuthClientRepository, useValue: new FakeOAuthClientRepository() },
    { provide: OAuthAuthorizationCodeRepository, useValue: {} },
    { provide: OAuthRefreshTokenRepository, useValue: {} },
    { provide: OAuthAccessTokenRepository, useValue: {} },
    { provide: AgentCredentialRepository, useValue: {} },
    { provide: CacheService, useValue: fakeCache(new FakeOAuthRedis()) },
    { provide: EgressHttpClient, useValue: {} },
  ],
  exports: [
    getDataSourceToken('postgres'),
    OAuthClientRepository,
    OAuthAuthorizationCodeRepository,
    OAuthRefreshTokenRepository,
    OAuthAccessTokenRepository,
    AgentCredentialRepository,
    CacheService,
    EgressHttpClient,
  ],
})
class FakeGlobalsModule {}

/** Stands in for `NotificationModule`, which needs the app's BullMQ root. */
@Module({
  providers: [{ provide: NOTIFICATION_PORT, useValue: { notify: async () => ({}) } }],
  exports: [NOTIFICATION_PORT],
})
class FakeNotificationModule {}

describe('OAuthCoreModule', () => {
  it('provides the registry, CIMD fetcher, DCR service, rate limiter, token service and grant writer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, OAuthCoreModule],
    })
      .overrideModule(NotificationModule)
      .useModule(FakeNotificationModule)
      .overrideProvider(OAUTH_CONFIG)
      .useValue(oauthConfig({ verifiedClients: [] }))
      .compile();

    for (const token of [
      OAuthClientRegistry,
      CimdFetcher,
      DcrService,
      OAuthRateLimiter,
      OAuthGrantWriter,
      OAuthTokenService,
    ]) {
      expect(moduleRef.get(token, { strict: false })).toBeInstanceOf(token);
    }
    expect(moduleRef.get(OAuthMetrics, { strict: false })).toBeInstanceOf(OAuthMetrics);
  });

  it('is never imported by the scheduler, directly or through another module', () => {
    const seen = new Set<unknown>();
    const walk = (module: unknown): boolean => {
      if (!module || seen.has(module)) return false;
      seen.add(module);
      if (module === OAuthCoreModule) return true;
      const target = (module as { module?: unknown }).module ?? module;
      const imports = (Reflect.getMetadata('imports', target as object) ?? []) as unknown[];
      const dynamic = ((module as { imports?: unknown[] }).imports ?? []) as unknown[];
      return [...imports, ...dynamic].some(walk);
    };
    expect(walk(AppSchedulerModule)).toBe(false);
  });
});
