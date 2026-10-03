import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';

import { CREDENTIAL_EXPIRY_SWEEP_CONFIG } from './constants/credential-expiry.constants';
import { CredentialExpirySweepJob } from './jobs/credential-expiry-sweep.job';
import { CredentialExpirySweepService } from './services/credential-expiry-sweep.service';

/**
 * Scheduler-only half of the account domain.
 *
 * Same shape as `ProviderStakeMonitorSchedulerModule`: registered only in
 * `AppSchedulerModule`, so the credential-expiry sweep runs once per
 * deployment rather than once per API replica.
 * `AgentCredentialRepository` needs no import — `PostgresModule` is
 * `@Global()`.
 */
@Module({
  imports: [NotificationModule],
  providers: [
    { provide: CREDENTIAL_EXPIRY_SWEEP_CONFIG, useValue: { now: () => Date.now() } },
    CredentialExpirySweepService,
    CredentialExpirySweepJob,
  ],
})
export class AccountSchedulerModule {}
