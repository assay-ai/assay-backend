import { Module } from '@nestjs/common';

import { NotificationModule } from '@modules/notification/notification.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { VerificationModule } from '@modules/verification/verification.module';
import { AuditLogModule } from '@shared/audit';

import { CALL_DISPUTE_CONFIG, loadCallDisputeConfig } from './constants/call-dispute.config';
import { CallDisputeService } from './services/call-dispute.service';
import { DisputeService } from './services/dispute.service';
import { RefundEligibilityService } from './services/refund-eligibility.service';

/**
 * Dispute domain — challenges to a verdict, an SLA window, or a payment
 * intent. A provider disputing a call it served and an agent disputing its own
 * call are the two directions one table serves; see `DisputeEntity`'s class
 * comment for why it is one table rather than two.
 *
 * `DisputeService` reads `disputes`, `payment_intents` and
 * `verification_records` directly through the repositories `PostgresModule`
 * provides globally.
 *
 * `CallDisputeService` is a buyer's dispute over one paid call (G3.B1), from
 * filing to the operator's decision and its refund. It needs `PaymentModule`
 * (`PaymentIntentService.voidDebt`, the refund of an uncollected call),
 * `VerificationModule` (the evidence pack it snapshots), `NotificationModule`
 * and `AuditLogModule`. The operator console decides through it
 * (`OperatorCallDisputeService`).
 */
@Module({
  imports: [PaymentModule, VerificationModule, NotificationModule, AuditLogModule],
  providers: [
    DisputeService,
    CallDisputeService,
    // Read-only: the receipt's refundableIfReportedNow, beside the filing so both see one HELD_PAYMENTS.
    RefundEligibilityService,
    { provide: CALL_DISPUTE_CONFIG, useFactory: () => loadCallDisputeConfig() },
  ],
  exports: [DisputeService, CallDisputeService, RefundEligibilityService, CALL_DISPUTE_CONFIG],
})
export class DisputeModule {}
