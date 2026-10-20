import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AccountBlockStatusService } from '@modules/account/services/account-block-status.service';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { BuyerDebtService } from '@modules/payment/services/buyer-debt.service';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { MeStatusResponseDto } from '../dto/me-status.dto';

/**
 * `GET /api/v1/me/status` — what the buyer shell polls every minute
 * (`/account/block-status`, `/notifications/unread-count`, `/escrow/debts`),
 * in one read. Each part is that route's own service call and shape; all three
 * are database or in-memory reads, no chain read.
 *
 * `SessionAuthGuard` alone, like all three routes.
 */
@ApiTags('Account')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('me/status')
export class MeStatusController {
  constructor(
    private readonly blockStatus: AccountBlockStatusService,
    private readonly notifications: NotificationsService,
    private readonly debts: BuyerDebtService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Block status, unread alert count and buyer debts, in one read' })
  @ApiResponse({ status: 200, type: MeStatusResponseDto })
  async get(@CurrentSession() session: McpSession): Promise<MeStatusResponseDto> {
    const [unreadCount, debts] = await Promise.all([
      this.notifications.unreadCount(session.organizationId),
      this.debts.list(session),
    ]);
    return {
      blockStatus: this.blockStatus.statusOf(session),
      unreadCount,
      // `EscrowController.listDebts`' own shape.
      debts: { account: session.agentAccount, debts },
    };
  }
}
