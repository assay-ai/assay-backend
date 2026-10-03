import { Processor } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { Job } from 'bullmq';

import { NotificationChannelRepository } from '@database/postgres/repositories/notification-channel.repository';
import { NotificationDeliveryRepository } from '@database/postgres/repositories/notification-delivery.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { QueueProcessorBase } from '@shared/queue';

import { DELIVERY_OBSERVER, DeliveryObserverPort } from '../ports/delivery-observer.port';
import {
  NOTIFICATION_CHANNEL_SENDER_REGISTRY,
  NotificationChannelSenderRegistry,
} from '../ports/notification-channel-sender.port';
import { NotificationQueue } from '../constants/notification-queues.constant';
import { NotificationDeliverJobData } from '../publishers/notification-deliver.publisher';

/**
 * Processor for the `notification.deliver` queue — runs in the worker process
 * only.
 *
 * Deliberately thin, same shape as `VerificationJudgeProcessor`: it re-reads
 * the two durable rows the job only names, resolves the channel's sender from
 * the registry, and writes the outcome back onto the delivery row. Registered
 * by `NotificationWorkerModule`, never by anything the api or mcp process
 * imports — a `@Processor()` starts a BullMQ `Worker` the moment it is
 * instantiated.
 *
 * Never lets a delivery failure escape: `QueueProcessorBase`'s retry policy is
 * for a *sender* that could not be reached, not for "the row disappeared",
 * which this class treats as a permanently-failed attempt rather than a thing
 * to keep retrying against rows that no longer exist.
 */
@Processor(NotificationQueue.DELIVER)
@Injectable()
export class NotificationDeliverProcessor extends QueueProcessorBase<NotificationDeliverJobData> {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly deliveries: NotificationDeliveryRepository,
    private readonly channels: NotificationChannelRepository,
    @Inject(NOTIFICATION_CHANNEL_SENDER_REGISTRY)
    private readonly senders: NotificationChannelSenderRegistry,
    @Inject(DELIVERY_OBSERVER)
    private readonly observer: DeliveryObserverPort,
  ) {
    super();
  }

  async process(job: Job<NotificationDeliverJobData>): Promise<void> {
    const { organizationId, notificationId, deliveryId, channel } = job.data;

    const [notification, delivery] = await Promise.all([
      this.notifications.findOneBy({ organizationId, id: notificationId }),
      this.deliveries.findOneBy({ organizationId, id: deliveryId }),
    ]);

    if (!notification || !delivery) {
      this.logger.warn(
        `Notification ${notificationId} or delivery ${deliveryId} no longer exists; dropping the job`,
      );
      return;
    }

    const sender = this.senders.get(channel);
    if (!sender) {
      this.logger.error(`No sender registered for channel ${channel}; marking delivery FAILED`);
      await this.markOutcome(organizationId, deliveryId, {
        delivered: false,
        error: `no sender registered for ${channel}`,
      });
      return;
    }

    const channels = await this.channels.findForOrganization(organizationId);
    const destination = channels.find((row) => row.channel === channel)?.destination ?? null;

    const result = await sender.send({
      organizationId,
      notificationId,
      deliveryId,
      channel,
      destination,
      title: notification.title,
      body: notification.body,
      payload: notification.payload,
    });

    await this.markOutcome(organizationId, deliveryId, result);

    // Ordered after the delivery row is written, and guarded, because this is
    // the only place a *clock* starts from a delivery. An observer that
    // threw before `markOutcome` would leave the row unwritten and the job
    // retried, re-sending a notification the channel already delivered.
    if (result.delivered && notification.subjectType && notification.subjectId) {
      await this.notifyObserver(organizationId, notification.subjectType, notification.subjectId);
    }
  }

  /**
   * Best-effort, by contract: the port must not throw and this catches it if it
   * does. The job has already succeeded — the message was delivered and the row
   * says so — so an observer failure is a missed clock, not a failed delivery,
   * and it must be logged rather than retried.
   */
  private async notifyObserver(
    organizationId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<void> {
    try {
      await this.observer.onDelivered(organizationId, subjectType, subjectId, new Date());
    } catch (error) {
      this.logger.error(
        `Delivery observer failed for ${subjectType} ${subjectId}: ${(error as Error).message}`,
      );
    }
  }

  private async markOutcome(
    organizationId: string,
    deliveryId: string,
    result: { readonly delivered: boolean; readonly error?: string },
  ): Promise<void> {
    const now = new Date();

    await this.deliveries.update(
      { organizationId, id: deliveryId },
      {
        status: result.delivered ? 'DELIVERED' : 'FAILED',
        attempts: () => '"attempts" + 1',
        lastError: result.delivered ? null : (result.error ?? 'unknown error'),
        deliveredAt: result.delivered ? now : null,
      },
    );
  }
}
