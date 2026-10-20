import { Module } from '@nestjs/common';

import { readVerifiedClientIds } from './config/oauth-verified-client-ids';
import { OAUTH_CLEANUP_CONFIG } from './constants/oauth-cleanup.constants';
import { OAuthCleanupJob } from './jobs/oauth-cleanup.job';
import { OAuthCleanupService, OAuthCleanupConfig } from './services/oauth-cleanup.service';

/**
 * Scheduler-only half of OAuth: the daily cleanup job. Registered only in
 * `AppSchedulerModule`.
 *
 * It deliberately does not provide `OAUTH_CONFIG`: that would make the
 * scheduler demand the request cookie secret and `AUTH_SESSION_SOURCE=both`
 * (and, under `SERVICE_TYPE=all`, take the secret out of the environment
 * first). The job needs only the verified client ids, read on their own.
 * No metric is counted here: the scheduler has no OAuth request path. Postgres and
 * Redis come from the global modules.
 */
@Module({
  providers: [
    {
      provide: OAUTH_CLEANUP_CONFIG,
      useFactory: (): OAuthCleanupConfig => ({
        now: () => Date.now(),
        verifiedClientIds: readVerifiedClientIds(),
      }),
    },
    OAuthCleanupService,
    OAuthCleanupJob,
  ],
})
export class OAuthSchedulerModule {}
