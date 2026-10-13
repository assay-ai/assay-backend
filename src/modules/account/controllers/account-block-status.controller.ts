import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { AccountBlockStatusDto } from '../dto/account-block-status.dto';
import { AccountBlockStatusService } from '../services/account-block-status.service';

/**
 * Whether the signed-in account is blocked, for the dashboard's banner.
 *
 * A `GET`, so a blocked person's session reaches it — that is the point. A
 * blocked agent credential never does: it has no session to read with.
 */
@ApiTags('Account')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('account/block-status')
export class AccountBlockStatusController {
  constructor(private readonly status: AccountBlockStatusService) {}

  @Get()
  @ApiOperation({ summary: 'Whether this account is blocked, and since when' })
  @ApiResponse({ status: 200, type: AccountBlockStatusDto })
  get(@CurrentSession() session: McpSession): AccountBlockStatusDto {
    return this.status.statusOf(session);
  }
}
