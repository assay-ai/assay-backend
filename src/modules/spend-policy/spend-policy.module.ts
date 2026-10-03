import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';

import { SpendPolicyService } from './services/spend-policy.service';
import { SpendUsageService } from './services/spend-usage.service';
import { SpendPolicyVelocityService } from './services/spend-policy-velocity.service';
import { SpendPolicyEnforcementService } from './services/spend-policy-enforcement.service';

/**
 * Spend policy domain — the append-only limits table behind
 * `GET`/`PATCH /spend-policy`, and the enforcement gate that applies it.
 *
 * `SpendPolicyRepository` and `PaymentIntentRepository` are provided
 * globally by `PostgresModule`, and `REDIS_CACHE_CLIENT` globally by
 * `RedisCacheModule` — so this module declares only its own services, same
 * pattern as `LedgerModule`.
 *
 * `NOTIFICATION_PORT` comes from `NotificationModule`, imported below: the
 * enforcement gate raises the 50/80/100% alert bands and the
 * velocity anomaly, and neither of those may block a call.
 */
@Module({
  // `NOTIFICATION_PORT`, for the 50/80/100% bands and the velocity anomaly.
  // Imported explicitly rather than made global like `AlertingModule`:
  // `NotificationModule` registers a BullMQ queue, and a module that pulls a
  // queue into every graph that touches it is a module that breaks processes
  // which have no business owning one.
  imports: [NotificationModule],
  providers: [
    SpendPolicyService,
    SpendUsageService,
    SpendPolicyVelocityService,
    SpendPolicyEnforcementService,
  ],
  exports: [SpendPolicyService, SpendPolicyEnforcementService],
})
export class SpendPolicyModule {}
