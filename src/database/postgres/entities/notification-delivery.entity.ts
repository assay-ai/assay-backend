import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The delivery log the `notifications` table explicitly refused to be.
 *
 * `NotificationEntity`'s own class comment reserves this seam: *"one balance-low
 * event may fan out to a webhook, an email and an in-app badge, each retrying on
 * its own schedule, and folding those into this row would make 'unread' mean
 * 'undelivered to the slowest channel'."* So `notifications.read_at` is about a
 * person reading, and this table is about a message leaving.
 *
 * **One row per `(notification_id, channel)`, updated in place.** A retry
 * raises `attempts` rather than appending, because the question this log exists
 * to answer — *"I never got an alert"* — is answered by reading one row, not by
 * folding a history of attempts into a verdict.
 *
 * `WithoutSoftDelete`: a delivery record is evidence about what we did, and
 * evidence with a `deleted_at` on it is evidence somebody can quietly retract.
 * It is deleted only with its notification, by the FK cascade.
 */
@Entity('notification_deliveries')
@Index('idx_notification_deliveries_organization_id', ['organizationId'])
export class NotificationDeliveryEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'notification_id', type: 'uuid' })
  notificationId: string;

  /** `IN_APP` | `EMAIL` | `PUSH` | `SLACK` | `WEBHOOK` — `NotificationChannel`. */
  @Column({ name: 'channel', type: 'varchar', length: 16 })
  channel: string;

  /**
   * `PENDING` | `DELIVERED` | `FAILED` | `SUPPRESSED`.
   *
   * `SUPPRESSED` is not a failure and must not be counted as one: it is the
   * record that this channel was deliberately skipped — a preference row said
   * no, or the organization never configured a destination. Collapsing it into
   * `FAILED` would put a working system permanently in the alarm state.
   */
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: string;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 512, nullable: true })
  lastError: string | null;

  /** Set if and only if `status = 'DELIVERED'` — `chk_notification_deliveries_delivered_at`. */
  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}
