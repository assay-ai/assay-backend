import { NotificationChannel } from './notification.port';

/**
 * What a channel needs to actually attempt a delivery.
 *
 * A subset of the `notifications` row plus the one thing the row does not
 * carry: the destination, read from `notification_channels` by the caller
 * (`NotificationService`) before the sender is invoked. A sender never reads
 * the channel registry itself — resolving "what address does this org use for
 * `EMAIL`" is fan-out logic, not delivery logic, and keeping it out of every
 * sender is what lets a new channel be added without teaching it how
 * `notification_channels` is shaped.
 */
export interface NotificationDeliveryJob {
  readonly organizationId: string;
  readonly notificationId: string;
  readonly deliveryId: string;
  readonly channel: NotificationChannel;
  /** `null` only for `IN_APP`, which needs none. */
  readonly destination: string | null;
  readonly title: string;
  readonly body: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** What a delivery attempt reports back, for the delivery row to record. */
export interface NotificationDeliveryResult {
  readonly delivered: boolean;
  /** Present only when `delivered` is `false`. */
  readonly error?: string;
}

/**
 * One channel's delivery mechanism.
 *
 * Deliberately one method per channel, resolved by the caller rather than a
 * single sender that switches on `job.channel` — the way `SignerPort` and
 * `FeePayerSignerPort` are one class per signing backend rather than one class
 * with a mode flag, so that adding a real `EMAIL` sender later is a new class
 * and one line of wiring, not an edit to a class every other channel also runs
 * through.
 *
 * Must not throw — same rule as `NotificationPort` and `AlertPort`.
 * `NotificationDeliverProcessor` reads the return value, not a caught
 * exception, to decide what to write on the delivery row; a sender that throws
 * instead of returning `{ delivered: false, error }` loses the reason on the
 * way to the log.
 */
export interface NotificationChannelSender {
  send(job: NotificationDeliveryJob): Promise<NotificationDeliveryResult>;
}

export const NOTIFICATION_CHANNEL_SENDER_REGISTRY = 'NOTIFICATION_CHANNEL_SENDER_REGISTRY';

/** Where `NotificationDeliverProcessor` resolves a channel's sender. */
export type NotificationChannelSenderRegistry = ReadonlyMap<
  NotificationChannel,
  NotificationChannelSender
>;
