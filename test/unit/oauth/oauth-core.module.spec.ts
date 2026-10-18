import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { AppSchedulerModule } from '@bootstrap/scheduler/app.module';
import { OAUTH_CONFIG } from '@modules/oauth/config/oauth.config';
import { OAuthCoreModule } from '@modules/oauth/oauth-core.module';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import { DcrService } from '@modules/oauth/services/dcr.service';
import { OAuthClientRegistry } from '@modules/oauth/services/oauth-client.registry';
import { OAuthMetrics } from '@modules/oauth/services/oauth-metrics.service';
import { OAuthRateLimiter } from '@modules/oauth/services/oauth-rate-limiter.service';
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
    { provide: OAuthClientRepository, useValue: new FakeOAuthClientRepository() },
    { provide: CacheService, useValue: fakeCache(new FakeOAuthRedis()) },
    { provide: EgressHttpClient, useValue: {} },
  ],
  exports: [OAuthClientRepository, CacheService, EgressHttpClient],
})
class FakeGlobalsModule {}

describe('OAuthCoreModule', () => {
  it('provides the registry, CIMD fetcher, DCR service and rate limiter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, OAuthCoreModule],
    })
      .overrideProvider(OAUTH_CONFIG)
      .useValue(oauthConfig({ verifiedClients: [] }))
      .compile();

    for (const token of [OAuthClientRegistry, CimdFetcher, DcrService, OAuthRateLimiter]) {
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
