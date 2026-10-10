import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { NotificationChannelRepository } from '@database/postgres/repositories/notification-channel.repository';
import { NotificationDeliveryRepository } from '@database/postgres/repositories/notification-delivery.repository';
import { NotificationPreferenceRepository } from '@database/postgres/repositories/notification-preference.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';

import { NOTIFICATION_CATALOGUE } from '../constants/notification-catalogue';
import { NotificationChannelDto } from '../dto/notification-channel.dto';
import { NotificationDeliveryDto } from '../dto/notification-delivery.dto';
import {
  NotificationPreferenceDto,
  UpsertNotificationPreferenceItemDto,
} from '../dto/notification-preference.dto';
import { NotificationErrors } from '../errors/notification.errors';
import { NotificationChannel, NotificationEvent } from '../ports/notification.port';

/**
 * The settings surface over `notification_channels` and
 * `notification_preferences` — everything
 * `NotificationService.notify` reads at fan-out time, seen and edited by an
 * organization.
 */
@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly channels: NotificationChannelRepository,
    private readonly preferences: NotificationPreferenceRepository,
    private readonly notifications: NotificationRepository,
    private readonly deliveries: NotificationDeliveryRepository,
  ) {}

  async listChannels(organizationId: string): Promise<NotificationChannelDto[]> {
    const rows = await this.channels.findForOrganization(organizationId);
    return rows.map((row) => ({
      id: row.id,
      channel: row.channel as NotificationChannel,
      destination: row.destination,
      enabled: row.enabled,
      verifiedAt: row.verifiedAt,
      createdAt: row.createdAt,
    }));
  }

  /**
   * `IN_APP` is refused before this runs — see the controller. Upserts on
   * `(organizationId, channel)`: a destination is configured once per channel,
   * never twice. A blank or `null` destination is refused: every non-`IN_APP`
   * channel needs one, and `undefined` keeps the stored one.
   */
  async upsertChannel(
    organizationId: string,
    channel: NotificationChannel,
    destination: string | null | undefined,
    enabled: boolean,
  ): Promise<NotificationChannelDto> {
    const existing = (await this.channels.findForOrganization(organizationId)).find(
      (row) => row.channel === channel,
    );

    const provided = destination === undefined ? undefined : (destination?.trim() ?? '');
    if (provided === '' || (provided === undefined && !existing?.destination)) {
      throw NotificationErrors.destinationRequired({ channel });
    }

    if (existing) {
      const nextDestination = provided === undefined ? existing.destination : provided;
      // Changing the destination invalidates any prior verification —
      // `NotificationChannelEntity`'s own class comment: "`updated_at >
      // verified_at` is a re-verify."
      const nextVerifiedAt = nextDestination !== existing.destination ? null : existing.verifiedAt;

      await this.channels.update(
        { organizationId, id: existing.id },
        { destination: nextDestination, enabled, verifiedAt: nextVerifiedAt },
      );

      return {
        id: existing.id,
        channel,
        destination: nextDestination,
        enabled,
        verifiedAt: nextVerifiedAt,
        createdAt: existing.createdAt,
      };
    }

    const id = randomUUID();
    const createdAt = new Date();
    await this.channels.insert({
      id,
      organizationId,
      channel,
      destination: provided as string,
      enabled,
      verifiedAt: null,
    });

    return { id, channel, destination: provided as string, enabled, verifiedAt: null, createdAt };
  }

  async listPreferences(organizationId: string): Promise<NotificationPreferenceDto[]> {
    const rows = await this.preferences.find({ where: { organizationId } });
    return rows.map((row) => ({
      id: row.id,
      event: row.event as NotificationEvent,
      channel: row.channel as NotificationChannel,
      enabled: row.enabled,
    }));
  }

  /**
   * Bulk upsert on `(organizationId, event, channel)`.
   *
   * Refuses the whole batch, before writing anything, if any item disables a
   * `nonSuppressible` event — a partial save that silently dropped just the
   * dangerous toggle would be worse than refusing outright, since the caller
   * would see the other toggles land and reasonably assume this one did too.
   */
  async upsertPreferences(
    organizationId: string,
    items: readonly UpsertNotificationPreferenceItemDto[],
  ): Promise<NotificationPreferenceDto[]> {
    for (const item of items) {
      const definition = NOTIFICATION_CATALOGUE[item.event];
      if (definition.nonSuppressible && !item.enabled) {
        throw NotificationErrors.nonSuppressibleEvent({ event: item.event, channel: item.channel });
      }
    }

    for (const item of items) {
      const existing = await this.preferences.findOneBy({
        organizationId,
        event: item.event,
        channel: item.channel,
      });

      if (existing) {
        await this.preferences.update(
          { organizationId, id: existing.id },
          { enabled: item.enabled },
        );
      } else {
        await this.preferences.insert({
          id: randomUUID(),
          organizationId,
          event: item.event,
          channel: item.channel,
          enabled: item.enabled,
        });
      }
    }

    return this.listPreferences(organizationId);
  }

  async listDeliveries(
    organizationId: string,
    notificationId: string,
  ): Promise<NotificationDeliveryDto[]> {
    const notification = await this.notifications.findOneBy({
      organizationId,
      id: notificationId,
    });
    if (!notification) {
      throw NotificationErrors.notFound({ id: notificationId });
    }

    const rows = await this.deliveries.findForNotification(organizationId, notificationId);
    return rows.map((row) => ({
      id: row.id,
      channel: row.channel as NotificationChannel,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      deliveredAt: row.deliveredAt,
      createdAt: row.createdAt,
    }));
  }
}
