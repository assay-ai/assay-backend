import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Global, Module } from '@nestjs/common';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { OAUTH_CLEANUP_CRON } from '@modules/oauth/constants/oauth-cleanup.constants';
import { OAuthCleanupJob } from '@modules/oauth/jobs/oauth-cleanup.job';
import { OAuthSchedulerModule } from '@modules/oauth/oauth-scheduler.module';
import { OAuthCleanupService } from '@modules/oauth/services/oauth-cleanup.service';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

/** Stands in for the scheduler's global Postgres and Redis modules. */
@Global()
@Module({
  providers: [
    { provide: getDataSourceToken('postgres'), useValue: {} },
    { provide: REDIS_CACHE_CLIENT, useValue: {} },
  ],
  exports: [getDataSourceToken('postgres'), REDIS_CACHE_CLIENT],
})
class FakeInfrastructureModule {}

describe('OAuthSchedulerModule', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('boots without OAUTH_CONFIG: no cookie secret, no AUTH_SESSION_SOURCE', async () => {
    delete process.env.OAUTH_REQUEST_COOKIE_SECRET;
    delete process.env.AUTH_SESSION_SOURCE;
    const module = await Test.createTestingModule({
      imports: [FakeInfrastructureModule, OAuthSchedulerModule],
    }).compile();

    expect(module.get(OAuthCleanupService)).toBeInstanceOf(OAuthCleanupService);
    expect(module.get(OAuthCleanupJob)).toBeInstanceOf(OAuthCleanupJob);
    await module.close();
  });

  it('leaves the request cookie secret in the environment', async () => {
    process.env.OAUTH_REQUEST_COOKIE_SECRET = 'left-alone';
    const module = await Test.createTestingModule({
      imports: [FakeInfrastructureModule, OAuthSchedulerModule],
    }).compile();

    expect(process.env.OAUTH_REQUEST_COOKIE_SECRET).toBe('left-alone');
    await module.close();
  });

  it('imports neither OAUTH_CONFIG nor loadOAuthConfig', () => {
    const sources = [
      'oauth-scheduler.module.ts',
      'jobs/oauth-cleanup.job.ts',
      'services/oauth-cleanup.service.ts',
      'config/oauth-verified-client-ids.ts',
    ].map((file) => readFileSync(join(__dirname, '../../../src/modules/oauth', file), 'utf8'));
    for (const source of sources) {
      expect(source).not.toMatch(/import\s*\{[^}]*\b(?:OAUTH_CONFIG|loadOAuthConfig)\b/);
      expect(source).not.toMatch(/inject\(OAUTH_CONFIG\)|@Inject\(OAUTH_CONFIG\)/i);
    }
  });

  it('runs daily at 03:17 UTC, one pass at a time', () => {
    expect(OAUTH_CLEANUP_CRON).toBe('0 17 3 * * *');
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      OAuthCleanupJob.prototype.handleOAuthCleanup,
    ) as { cronTime?: string; timeZone?: string; waitForCompletion?: boolean };
    expect(options).toMatchObject({
      cronTime: OAUTH_CLEANUP_CRON,
      timeZone: 'UTC',
      waitForCompletion: true,
    });
  });
});
