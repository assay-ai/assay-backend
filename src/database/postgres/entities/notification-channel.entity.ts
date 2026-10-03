import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntity } from './organization-scoped.entity';

/**
 * Where an organization's notifications are sent.
 *
 * The **registry**, not the preference. This row answers "what is the email
 * address, is Slack configured at all, has the address been verified"; whether
 * a *particular event* uses it is `notification_preferences`. Two tables
 * because a destination is configured once and verified, while a preference is
 * toggled per event forever — folding them together would mean re-verifying an
 * address every time somebody muted one event.
 *
 * `IN_APP` is the dashboard inbox. It needs no destination, is always
 * available, and is the reason the notification centre can answer "what
 * happened while I was away" even for an organization that has configured
 * nothing.
 */
@Entity('notification_channels')
@Index('idx_notification_channels_organization_id', ['organizationId'])
export class NotificationChannelEntity extends OrganizationScopedEntity {
  /** `IN_APP` | `EMAIL` | `PUSH` | `SLACK` | `WEBHOOK` — `NotificationChannel`. */
  @Column({ name: 'channel', type: 'varchar', length: 16 })
  channel: string;

  /**
   * Email address, push token, Slack webhook URL, HTTP callback.
   *
   * `NULL` only for `IN_APP`, enforced by `chk_notification_channels_destination`:
   * a channel without somewhere to send to fails at delivery time instead of at
   * configuration time, which is the wrong moment to find out.
   */
  @Column({ name: 'destination', type: 'varchar', length: 512, nullable: true })
  destination: string | null;

  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled: boolean;

  /**
   * `NULL` = unverified.
   *
   * Email must be verified before it is relied on. Kept as a timestamp rather
   * than a boolean so "verified, but before the address was last changed" is
   * expressible — `updated_at > verified_at` is a re-verify.
   */
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;
}
