import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { NotificationEntity } from '../entities/notification.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** The notification feed and its unread count. */
@Injectable()
export class NotificationRepository extends OrganizationScopedRepository<NotificationEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(NotificationEntity, dataSource);
  }

  /**
   * Unread count, served by the partial index `idx_notifications_unread`.
   *
   * The one `COUNT(*)` on this surface, and it is affordable precisely because
   * the index it rides only contains unread rows — the set it counts stays
   * small by construction, unlike a count over the whole feed.
   */
  async countUnread(organizationId: string): Promise<number> {
    return this.count({ where: { organizationId, readAt: IsNull() } });
  }

  /**
   * Whether this organization holds a notification of `event` whose payload
   * contains `payload` (jsonb `@>`). Served by `idx_notifications_event`.
   */
  async existsWithPayload(
    organizationId: string,
    event: string,
    payload: Record<string, string>,
  ): Promise<boolean> {
    const row = await this.createQueryBuilder('notification')
      .select('1', 'one')
      .where('notification.organizationId = :organizationId', { organizationId })
      .andWhere('notification.event = :event', { event })
      .andWhere('notification.payload @> CAST(:payload AS jsonb)', {
        payload: JSON.stringify(payload),
      })
      .limit(1)
      .getRawOne<{ one: number }>();
    return row !== undefined && row !== null;
  }
}
