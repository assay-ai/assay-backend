import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { NotificationChannelEntity } from '../entities/notification-channel.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** An organization's configured notification destinations. */
@Injectable()
export class NotificationChannelRepository extends OrganizationScopedRepository<NotificationChannelEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(NotificationChannelEntity, dataSource);
  }

  /**
   * Every channel this organization has configured, enabled or not.
   *
   * The disabled ones are returned deliberately: the notification service has
   * to write a `SUPPRESSED` delivery row for them, and it cannot suppress a
   * channel it was never told about.
   */
  async findForOrganization(organizationId: string): Promise<NotificationChannelEntity[]> {
    return this.find({ where: { organizationId } });
  }
}
