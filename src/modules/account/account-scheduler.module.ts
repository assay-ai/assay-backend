import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';

import { CREDENTIAL_EXPIRY_SWEEP_CONFIG } from './constants/credential-expiry.constants';
import { CredentialExpirySweepJob } from './jobs/credential-expiry-sweep.job';
import { CredentialExpirySweepService } from './services/credential-expiry-sweep.service';
import { PAYMENT_KEY_DAILY_SUMMARY_CONFIG } from './constants/payment-key-daily-summary.constants';
import { PaymentKeyDailySummaryJob } from './jobs/payment-key-daily-summary.job';
import { PaymentKeyDailySummaryService } from './services/payment-key-daily-summary.service';

/**
 * Scheduler-only half of the account domain.
 *
 * Same shape as `ProviderStakeMonitorSchedulerModule`: registered only in
 * `AppSchedulerModule`, so the credential-expiry sweep runs once per
 * deployment rather than once per API replica.
 * `AgentCredentialRepository` needs no import — `PostgresModule` is
 * `@Global()`.
 *
 * The payment-key daily summary (`payment_key.daily_summary`) runs here too,
 * once per deployment; its Redis job lock covers a second scheduler replica.
 * Nothing here imports the OAuth module or its config.
 */
@Module({
  imports: [NotificationModule],
  providers: [
    { provide: CREDENTIAL_EXPIRY_SWEEP_CONFIG, useValue: { now: () => Date.now() } },
    CredentialExpirySweepService,
    CredentialExpirySweepJob,
    { provide: PAYMENT_KEY_DAILY_SUMMARY_CONFIG, useValue: { now: () => Date.now() } },
    PaymentKeyDailySummaryService,
    PaymentKeyDailySummaryJob,
  ],
})
export class AccountSchedulerModule {}
