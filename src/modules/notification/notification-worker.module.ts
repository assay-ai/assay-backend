import { Module } from '@nestjs/common';

import { SlashDeliveryObserver } from '@modules/slash/services/slash-delivery-observer.service';
import { SlashOpenerModule } from '@modules/slash/slash-opener.module';

import { DELIVERY_OBSERVER } from './ports/delivery-observer.port';
import { NotificationDeliverProcessor } from './processors/notification-deliver.processor';
import { NotificationModule } from './notification.module';

/**
 * Worker-side notification module — imported only by `AppWorkerModule`.
 *
 * Same shape and same reason as `VerificationWorkerModule`: instantiating a
 * `@Processor()` starts a BullMQ `Worker` immediately, and neither the api nor
 * the mcp process may become a consumer of `notification.deliver` — every
 * producer only ever publishes to it, through `NotificationService`.
 */
@Module({
  // `SlashOpenerModule` is the smallest module that carries the observer: it
  // holds `SlashProposalService` without dragging in the operator identity, the
  // override log or the chain executor the way `SlashModule` would. It imports
  // `NotificationModule` itself, which closes no cycle — `NotificationModule`
  // imports neither.
  imports: [NotificationModule, SlashOpenerModule],
  providers: [
    NotificationDeliverProcessor,
    // Bound here and nowhere else. The processor is the only consumer, and it
    // exists only in the worker.
    { provide: DELIVERY_OBSERVER, useExisting: SlashDeliveryObserver },
  ],
})
export class NotificationWorkerModule {}
