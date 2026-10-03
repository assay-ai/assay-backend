import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { NotificationPreferenceEntity } from '../entities/notification-preference.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Per-`(event, channel)` opt-outs. */
@Injectable()
export class NotificationPreferenceRepository extends OrganizationScopedRepository<NotificationPreferenceEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(NotificationPreferenceEntity, dataSource);
  }

  /**
   * The overrides for one event.
   *
   * Scoped to the event rather than loading the organization's whole preference
   * set, because this runs on the notification path: a fan-out reads the rows
   * for the one event it is delivering, not the hundred it is not.
   */
  async findForEvent(
    organizationId: string,
    event: string,
  ): Promise<NotificationPreferenceEntity[]> {
    return this.find({ where: { organizationId, event } });
  }
}
