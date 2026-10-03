import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { NotificationDeliveryEntity } from '../entities/notification-delivery.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** The per-channel delivery log. */
@Injectable()
export class NotificationDeliveryRepository extends OrganizationScopedRepository<NotificationDeliveryEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(NotificationDeliveryEntity, dataSource);
  }

  /** Every channel's outcome for one notification, for `GET /notifications/:id/deliveries`. */
  async findForNotification(
    organizationId: string,
    notificationId: string,
  ): Promise<NotificationDeliveryEntity[]> {
    return this.find({ where: { organizationId, notificationId } });
  }
}
