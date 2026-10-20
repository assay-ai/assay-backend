import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AccountBlockStatusService } from '@modules/account/services/account-block-status.service';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { BuyerDebtService } from '@modules/payment/services/buyer-debt.service';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { MeStatusResponseDto } from '../dto/me-status.dto';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `GET /api/v1/me/status` — what the buyer shell polls every minute
 * (`/account/block-status`, `/notifications/unread-count`, `/escrow/debts`),
 * in one read. Each part is that route's own service call and shape; all three
 * are database or in-memory reads, no chain read. A part that fails is `null`
 * and the rest still answer, so the shell degrades as three polls did.
 *
 * `SessionAuthGuard` alone, like all three routes.
 */
@ApiTags('Account')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('me/status')
export class MeStatusController {
  private readonly logger = new Logger(MeStatusController.name);

  constructor(
    private readonly blockStatus: AccountBlockStatusService,
    private readonly notifications: NotificationsService,
    private readonly debts: BuyerDebtService,
  ) {}

  @Get()
  @TenantCache({
    ttl: 5,
    vary: 'agent',
    epochs: ['money', 'notifications'],
    // A part that could not be read answers null: never kept for the next poll.
    cacheIf: (body) => Object.values(body as object).every((part) => part !== null),
  })
  @ApiOperation({ summary: 'Block status, unread alert count and buyer debts, in one read' })
  @ApiResponse({ status: 200, type: MeStatusResponseDto })
  async get(@CurrentSession() session: McpSession): Promise<MeStatusResponseDto> {
    // Each part on its own: one that fails is `null` and the others still
    // answer, as three separate polls did — a failed debts read must not take
    // the bell's count or the block banner down with it.
    const [blockStatus, unreadCount, debts] = await Promise.all([
      this.part('blockStatus', async () => this.blockStatus.statusOf(session)),
      this.part('unreadCount', () => this.notifications.unreadCount(session.organizationId)),
      // `EscrowController.listDebts`' own shape.
      this.part('debts', async () => ({
        account: session.agentAccount,
        debts: await this.debts.list(session),
      })),
    ]);
    return { blockStatus, unreadCount, debts };
  }

  private async part<T>(name: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(
        `me/status: ${name} could not be read, answering null — ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
  }
}
