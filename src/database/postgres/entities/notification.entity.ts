import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntity } from './organization-scoped.entity';

/**
 * What the notification centre reads.
 *
 * This table is the **record that an event concerned this organization**, not
 * the record of a delivery attempt. The distinction matters: one balance-low
 * event may fan out to a webhook, an email and an in-app badge, each retrying
 * on its own schedule, and folding those into this row would make "unread" mean
 * "undelivered to the slowest channel". Delivery attempts belong in a delivery
 * log keyed by `(notification_id, channel)` — `notification_deliveries`, not
 * built here.
 *
 * `read_at` is therefore about a person reading it in the dashboard, and
 * `first_delivered_at` is a convenience denormalisation for "has this left the
 * building at all" — deliberately not authoritative.
 *
 * Soft-deletable, unlike the audit log: a user dismissing a notification is a
 * normal act, and the row carries no financial claim.
 */
@Entity('notifications')
@Index('idx_notifications_unread', ['organizationId', 'readAt'])
@Index('idx_notifications_event', ['organizationId', 'event'])
export class NotificationEntity extends OrganizationScopedEntity {
  /**
   * The event name from the webhook event catalogue —
   * `payment_intent.refunded`, `provider.sla_breach_proposed`,
   * `agent.balance_low`, …
   *
   * A string rather than an enum column because the catalogue is shared with
   * webhooks and grows independently of this table; a `CHECK` here would mean a
   * migration every time a webhook event is added.
   */
  @Column({ name: 'event', type: 'varchar', length: 64 })
  event: string;

  /** `INFO` | `WARNING` | `CRITICAL` — drives placement, not content. */
  @Column({ name: 'severity', type: 'varchar', length: 16 })
  severity: string;

  @Column({ name: 'title', type: 'varchar', length: 256 })
  title: string;

  @Column({ name: 'body', type: 'varchar', length: 2048 })
  body: string;

  /**
   * What the notification is *about*, so the UI can deep-link without parsing
   * the body. `payment_intent` / `provider` / `sla_window` / `dispute` / …
   */
  @Column({ name: 'subject_type', type: 'varchar', length: 32, nullable: true })
  subjectType: string | null;

  @Column({ name: 'subject_id', type: 'varchar', length: 128, nullable: true })
  subjectId: string | null;

  /**
   * The event payload as sent to webhooks.
   *
   * Stored so the in-app view and the webhook consumer are looking at the same
   * facts. A notification whose displayed text disagrees with the webhook body
   * for the same event is the failure mode this prevents.
   */
  @Column({ name: 'payload', type: 'jsonb', default: () => `'{}'::jsonb` })
  payload: Record<string, unknown>;

  /** `NULL` = unread. Indexed above, since "unread count" is on every page. */
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  /** Best-effort, non-authoritative — see the class comment. */
  @Column({ name: 'first_delivered_at', type: 'timestamptz', nullable: true })
  firstDeliveredAt: Date | null;
}
