import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CREDENTIAL_EXPIRY_SWEEP_CRON } from '../constants/credential-expiry.constants';
import { CredentialExpirySweepService } from '../services/credential-expiry-sweep.service';

/**
 * The cron wrapper around `CredentialExpirySweepService.sweep`.
 *
 * Same shape as `StakeMonitorJob`: registered only in
 * `AccountSchedulerModule`, which only the scheduler process imports, so the
 * sweep runs once per deployment rather than once per replica.
 */
@Injectable()
export class CredentialExpirySweepJob {
  private readonly logger = new Logger(CredentialExpirySweepJob.name);

  constructor(private readonly sweep: CredentialExpirySweepService) {}

  @Cron(CREDENTIAL_EXPIRY_SWEEP_CRON)
  async handleCredentialExpirySweep(): Promise<void> {
    try {
      const summary = await this.sweep.sweep();
      this.logger.log(
        `Credential-expiry sweep: checked=${summary.checked} T-7=${summary.warnedT7} ` +
          `T-1=${summary.warnedT1} expired=${summary.expired}`,
      );
    } catch (error) {
      this.logger.error(
        `Credential-expiry sweep threw past its own error handling: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
