import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import {
  NotificationChannelDto,
  NotificationChannelParamDto,
  UpsertNotificationChannelBodyDto,
} from '../dto/notification-channel.dto';
import { NotificationDeliveryDto, NotificationIdParamDto } from '../dto/notification-delivery.dto';
import {
  NotificationPreferenceDto,
  UpsertNotificationPreferencesBodyDto,
} from '../dto/notification-preference.dto';
import { NotificationChannel } from '../ports/notification.port';
import { NotificationSettingsService } from '../services/notification-settings.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * Where an organization sees and edits its own
 * notification destinations, preferences, and per-notification delivery
 * outcomes.
 *
 * `organizationId` comes from `@CurrentSession()` only, same pattern as
 * `NotificationsController` in the account module.
 */
@ApiTags('Notification settings')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller()
export class NotificationSettingsController {
  constructor(private readonly settings: NotificationSettingsService) {}

  @Get('notification-channels')
  @TenantCache({ ttl: 60, vary: 'org', epochs: ['notifications'] })
  @ApiOperation({ summary: "An organization's configured notification destinations" })
  @ApiResponse({ status: 200, type: [NotificationChannelDto] })
  async listChannels(@CurrentSession() session: McpSession): Promise<NotificationChannelDto[]> {
    return this.settings.listChannels(session.organizationId);
  }

  // Where alerts go, and which are sent, is how a person watches the agent;
  // the agent must not be able to redirect or mute them.
  @Put('notification-channels/:channel')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: 'Configure (or reconfigure) one channel destination' })
  @ApiResponse({ status: 200, type: NotificationChannelDto })
  async upsertChannel(
    @CurrentSession() session: McpSession,
    @Param() params: NotificationChannelParamDto,
    @Body() body: UpsertNotificationChannelBodyDto,
  ): Promise<NotificationChannelDto> {
    // `IN_APP` needs no destination and is never disabled — see
    // `NotificationChannelEntity`'s class comment. Refused here rather than
    // silently accepted and ignored, so a caller finds out immediately rather
    // than wondering later why the row never changed.
    if (params.channel === NotificationChannel.IN_APP) {
      return {
        id: 'in-app',
        channel: NotificationChannel.IN_APP,
        destination: null,
        enabled: true,
        verifiedAt: null,
        createdAt: new Date(0),
      };
    }

    return this.settings.upsertChannel(
      session.organizationId,
      params.channel,
      body.destination,
      body.enabled,
      auditActorOf(session),
    );
  }

  @Get('notification-preferences')
  @TenantCache({ ttl: 60, vary: 'org', epochs: ['notifications'] })
  @ApiOperation({ summary: 'Per-event opt-outs; absence means the catalogue default' })
  @ApiResponse({ status: 200, type: [NotificationPreferenceDto] })
  async listPreferences(
    @CurrentSession() session: McpSession,
  ): Promise<NotificationPreferenceDto[]> {
    return this.settings.listPreferences(session.organizationId);
  }

  @Put('notification-preferences')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: 'Bulk-upsert event/channel preferences' })
  @ApiResponse({ status: 200, type: [NotificationPreferenceDto] })
  @ApiResponse({ status: 400, description: 'A `nonSuppressible` event was disabled' })
  async upsertPreferences(
    @CurrentSession() session: McpSession,
    @Body() body: UpsertNotificationPreferencesBodyDto,
  ): Promise<NotificationPreferenceDto[]> {
    return this.settings.upsertPreferences(
      session.organizationId,
      body.preferences,
      auditActorOf(session),
    );
  }

  @Get('notifications/:id/deliveries')
  @ApiOperation({ summary: 'Every channel outcome for one notification' })
  @ApiResponse({ status: 200, type: [NotificationDeliveryDto] })
  @ApiResponse({ status: 404, description: 'No such notification in this organization' })
  async listDeliveries(
    @CurrentSession() session: McpSession,
    @Param() params: NotificationIdParamDto,
  ): Promise<NotificationDeliveryDto[]> {
    return this.settings.listDeliveries(session.organizationId, params.id);
  }
}
