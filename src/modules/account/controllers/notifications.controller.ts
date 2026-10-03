import { Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { ListNotificationsQueryDto, NotificationDto } from '../dto/list-notifications.dto';
import { NotificationIdParamDto } from '../dto/mark-notification-read.dto';
import { UnreadCountResponseDto } from '../dto/unread-count.dto';
import { NotificationsService } from '../services/notifications.service';

/**
 * The notification feed.
 *
 * `organizationId` comes from `@CurrentSession()` and nowhere else — see
 * `SessionAuthGuard`. `unread-count` is its own endpoint rather than a field on
 * the page envelope — see `UnreadCountResponseDto` for why.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'The notification feed, newest first' })
  @ApiCursorPage(NotificationDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<CursorPageDto<NotificationDto>> {
    return this.notifications.list(session.organizationId, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notification count — the badge every page shows' })
  @ApiResponse({ status: 200, description: 'The count', type: UnreadCountResponseDto })
  async unreadCount(@CurrentSession() session: McpSession): Promise<UnreadCountResponseDto> {
    return this.notifications.unreadCount(session.organizationId);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiResponse({ status: 200, description: 'The notification, now read', type: NotificationDto })
  @ApiResponse({ status: 404, description: 'No such notification in this organization' })
  async markRead(
    @CurrentSession() session: McpSession,
    @Param() params: NotificationIdParamDto,
  ): Promise<NotificationDto> {
    return this.notifications.markRead(session.organizationId, params.id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark every unread notification read' })
  @ApiResponse({ status: 201, description: 'Done' })
  async markAllRead(@CurrentSession() session: McpSession): Promise<void> {
    await this.notifications.markAllRead(session.organizationId);
  }
}
