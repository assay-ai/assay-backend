import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntity } from './organization-scoped.entity';

/**
 * One organization's opt-out for one `(event, channel)` pair.
 *
 * **Absence means the catalogue's default.** Rows are written only when
 * somebody changes something, so a new organization has none and still receives
 * everything `NOTIFICATION_CATALOGUE` says it should. Seeding a row per event
 * per channel at signup would be 100+ rows saying "as documented", and the
 * first catalogue change would leave every one of them stale.
 *
 * A row cannot switch off an event the catalogue marks `nonSuppressible` — the
 * withdrawal, destination-addition and consent paths. That rule lives in the
 * service rather than in a CHECK here because the catalogue is code: a
 * constraint would have to be migrated every time an event's suppressibility
 * changed, and would then be a second, disagreeing source of truth.
 */
@Entity('notification_preferences')
@Index('idx_notification_preferences_organization_id', ['organizationId'])
export class NotificationPreferenceEntity extends OrganizationScopedEntity {
  /** An event name from `NotificationEvent` — `balance.low`, `velocity.anomaly`, … */
  @Column({ name: 'event', type: 'varchar', length: 64 })
  event: string;

  /** `IN_APP` | `EMAIL` | `PUSH` | `SLACK` | `WEBHOOK` — `NotificationChannel`. */
  @Column({ name: 'channel', type: 'varchar', length: 16 })
  channel: string;

  @Column({ name: 'enabled', type: 'boolean' })
  enabled: boolean;
}
