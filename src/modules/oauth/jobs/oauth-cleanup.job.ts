import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { OAUTH_CLEANUP_CRON } from '../constants/oauth-cleanup.constants';
import { OAuthCleanupService } from '../services/oauth-cleanup.service';

/**
 * The cron wrapper around `OAuthCleanupService.run`, daily at 03:17 UTC.
 *
 * Registered only in `OAuthSchedulerModule`, which only the scheduler process
 * imports. The service's Redis lock keeps a second scheduler replica from
 * running it twice.
 */
@Injectable()
export class OAuthCleanupJob {
  private readonly logger = new Logger(OAuthCleanupJob.name);

  constructor(private readonly cleanup: OAuthCleanupService) {}

  @Cron(OAUTH_CLEANUP_CRON, { timeZone: 'UTC', waitForCompletion: true })
  async handleOAuthCleanup(): Promise<void> {
    try {
      const summary = await this.cleanup.run();
      if (!('accessTokens' in summary)) {
        this.logger.log('OAuth cleanup: skipped, another run holds the lock');
        return;
      }
      this.logger.log(
        `OAuth cleanup: accessTokens=${summary.accessTokens} refreshTokens=${summary.refreshTokens} ` +
          `codes=${summary.codes} clients=${summary.clients}`,
      );
    } catch (error) {
      this.logger.error(
        `OAuth cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
