import { Injectable, Optional } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { NotificationEntity } from '@database/postgres/entities/notification.entity';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { TenantEpochService } from '@shared/cache/redis-cache/tenant-epoch.service';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';

import { ListNotificationsQueryDto, NotificationDto } from '../dto/list-notifications.dto';
import { UnreadCountResponseDto } from '../dto/unread-count.dto';
import { AccountErrors } from '../errors/account.errors';

const NOTIFICATIONS_LIST: ListSpec = {
  alias: 'notification',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'notification.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: NotificationEntity) => row.createdAt),
    },
  },
};

/** `GET /api/v1/notifications` and its siblings. */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly notifications: NotificationRepository,
    @Optional() private readonly epochs?: TenantEpochService,
  ) {}

  async list(
    organizationId: string,
    query: ListNotificationsQueryDto,
  ): Promise<CursorPageDto<NotificationDto>> {
    const qb = this.notifications
      .createQueryBuilder('notification')
      .where('notification.organizationId = :organizationId', { organizationId });

    if (query.event?.length) {
      qb.andWhere('notification.event IN (:...events)', { events: query.event });
    }
    if (query.severity?.length) {
      qb.andWhere('notification.severity IN (:...severities)', { severities: query.severity });
    }
    if (query.unreadOnly) {
      qb.andWhere('notification.readAt IS NULL');
    }

    applyTimeWindow(qb, query, NOTIFICATIONS_LIST);

    const page = await paginate(qb, query, NOTIFICATIONS_LIST);
    return page.map((row) => this.toDto(row));
  }

  async unreadCount(organizationId: string): Promise<UnreadCountResponseDto> {
    const count = await this.notifications.countUnread(organizationId);
    return { count };
  }

  /** Cross-organization id, or no such row → 404, never 403. */
  async markRead(organizationId: string, id: string): Promise<NotificationDto> {
    const notification = await this.notifications.findOneBy({ organizationId, id });
    if (!notification) {
      throw AccountErrors.notificationNotFound({ id });
    }

    // Idempotent: marking an already-read notification read again is not an
    // error, and re-stamping `readAt` would lose the original read time for
    // no benefit.
    if (!notification.readAt) {
      notification.readAt = new Date();
      await this.notifications.update({ organizationId, id }, { readAt: notification.readAt });
      await this.epochs?.bump(organizationId, 'notifications');
    }

    return this.toDto(notification);
  }

  async markAllRead(organizationId: string): Promise<void> {
    await this.notifications.update({ organizationId, readAt: IsNull() }, { readAt: new Date() });
    // The feed, the badge and `/me/status` read the change at once.
    await this.epochs?.bump(organizationId, 'notifications');
  }

  private toDto(entity: NotificationEntity): NotificationDto {
    return {
      id: entity.id,
      event: entity.event,
      severity: entity.severity,
      title: entity.title,
      body: entity.body,
      subjectType: entity.subjectType,
      subjectId: entity.subjectId,
      payload: entity.payload,
      readAt: entity.readAt,
      createdAt: entity.createdAt,
    };
  }
}
