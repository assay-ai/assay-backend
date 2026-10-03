import { BullModule } from '@nestjs/bullmq';
import { Module, Provider } from '@nestjs/common';

import { NotificationQueue } from './constants/notification-queues.constant';
import {
  NOTIFICATION_CHANNEL_SENDER_REGISTRY,
  NotificationChannelSenderRegistry,
} from './ports/notification-channel-sender.port';
import { NOTIFICATION_PORT, NotificationChannel } from './ports/notification.port';
import { NotificationDeliverPublisher } from './publishers/notification-deliver.publisher';
import { InAppChannelSender } from './services/channels/in-app-channel-sender';
import { LoggingChannelSender } from './services/channels/logging-channel-sender';
import { NotificationService } from './services/notification.service';

/**
 * Notification domain — how the platform tells a customer something concerns
 * them.
 *
 * Shared module, following the verification/payment convention: registers the
 * `notification.deliver` queue so both the api-side publisher (indirectly,
 * through `NotificationService`, reached from `LedgerModule`, `PaymentModule`
 * and `ProviderModule`) and the worker-side processor
 * (`NotificationWorkerModule`) inject the same queue token. The repositories
 * (`NotificationRepository` and its three siblings) need no import —
 * `PostgresModule` provides them globally.
 *
 * `NOTIFICATION_CHANNEL_SENDER_REGISTRY` maps every `NotificationChannel` to a
 * sender — `InAppChannelSender` for `IN_APP`, and the single
 * `LoggingChannelSender` placeholder for the four channels that have no vendor
 * integration yet. One shared instance for all four rather than four
 * subclasses: they behave identically today, and splitting them now would be
 * four classes to later collapse back when each grows a real backend, not four
 * classes that grow independently.
 */
const senderRegistry: Provider = {
  provide: NOTIFICATION_CHANNEL_SENDER_REGISTRY,
  inject: [InAppChannelSender, LoggingChannelSender],
  useFactory: (
    inApp: InAppChannelSender,
    logging: LoggingChannelSender,
  ): NotificationChannelSenderRegistry =>
    new Map([
      [NotificationChannel.IN_APP, inApp],
      [NotificationChannel.EMAIL, logging],
      [NotificationChannel.PUSH, logging],
      [NotificationChannel.SLACK, logging],
      [NotificationChannel.WEBHOOK, logging],
    ]),
};

@Module({
  imports: [BullModule.registerQueue({ name: NotificationQueue.DELIVER })],
  providers: [
    InAppChannelSender,
    LoggingChannelSender,
    senderRegistry,
    NotificationDeliverPublisher,
    NotificationService,
    { provide: NOTIFICATION_PORT, useExisting: NotificationService },
  ],
  exports: [
    NOTIFICATION_PORT,
    NotificationService,
    NotificationDeliverPublisher,
    BullModule,
    // The processor lives in `NotificationWorkerModule` and resolves its
    // senders from here, so the registry has to cross the module boundary.
    // Exported rather than re-declared there: two registries would be two
    // answers to "which sender handles EMAIL", and the worker's copy is the
    // one nobody would think to update.
    NOTIFICATION_CHANNEL_SENDER_REGISTRY,
  ],
})
export class NotificationModule {}
