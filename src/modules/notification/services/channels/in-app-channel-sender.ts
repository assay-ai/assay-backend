import { Injectable } from '@nestjs/common';

import {
  NotificationChannelSender,
  NotificationDeliveryJob,
  NotificationDeliveryResult,
} from '../../ports/notification-channel-sender.port';

/**
 * The `IN_APP` "channel".
 *
 * There is nothing to send: the `notifications` row and the `IN_APP`
 * `notification_deliveries` row are written `DELIVERED` synchronously inside
 * `NotificationService.notify`, before this class or the queue is ever
 * reached — the row *is* the delivery. `NotificationDeliverProcessor` never
 * enqueues an `IN_APP` job, so `send` here exists only so
 * `NOTIFICATION_CHANNEL_SENDER_REGISTRY` is total over `NotificationChannel`
 * and a future caller cannot reach a `undefined` sender by mistake.
 */
@Injectable()
export class InAppChannelSender implements NotificationChannelSender {
  async send(_job: NotificationDeliveryJob): Promise<NotificationDeliveryResult> {
    return { delivered: true };
  }
}
