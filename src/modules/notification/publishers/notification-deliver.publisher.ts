import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { RequestContext } from '@shared/observability';

import { NotificationChannel } from '../ports/notification.port';
import { NotificationQueue } from '../constants/notification-queues.constant';

/**
 * The wakeup `NotificationDeliverProcessor` consumes.
 *
 * Ids only, plus the channel — everything the processor needs to re-read the
 * `notification_deliveries` row and the `notifications` row it belongs to.
 * `title`/`body`/`payload` are **not** carried on the job: the row is the
 * durable copy, and a job that duplicated it would let a retry deliver
 * content that disagrees with what `notifications` now says, e.g. after a
 * (hypothetical, currently nonexistent) edit or redaction path.
 */
export interface NotificationDeliverJobData {
  readonly organizationId: string;
  readonly notificationId: string;
  readonly deliveryId: string;
  readonly channel: NotificationChannel;

  /**
   * The HTTP request this delivery was enqueued from, stamped from
   * the ambient `RequestContext` by `publishDeliver` rather than passed in.
   * See `VerificationJudgeJobData.requestId` for why it is stamped and not a
   * parameter. Absent for a notification raised by a scheduler tick, which
   * has no request behind it.
   */
  readonly requestId?: string;
}

@Injectable()
export class NotificationDeliverPublisher {
  private readonly logger = new Logger(NotificationDeliverPublisher.name);

  constructor(
    @InjectQueue(NotificationQueue.DELIVER)
    private readonly queue: Queue<NotificationDeliverJobData>,
  ) {}

  /**
   * Enqueues one channel's delivery attempt.
   *
   * `jobId` is the delivery id, not a composite: `notification_deliveries` is
   * already one row per `(notification_id, channel)`, so the delivery id alone
   * is unique per attempt and a duplicate publish for the same delivery
   * collapses into the same BullMQ job rather than queuing twice.
   */
  async publishDeliver(data: NotificationDeliverJobData): Promise<void> {
    const jobId = `notification-deliver-${data.deliveryId}`;

    await this.queue.add(
      NotificationQueue.DELIVER,
      { ...data, requestId: data.requestId ?? RequestContext.getRequestId() ?? undefined },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    this.logger.debug(
      `Enqueued ${NotificationQueue.DELIVER} (jobId=${jobId}) for notification ${data.notificationId} on ${data.channel}`,
    );
  }
}
