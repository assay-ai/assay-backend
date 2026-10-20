import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { ListProviderPayoutsQueryDto, ProviderPayoutDto } from '../dto/get-provider-payouts.dto';
import { ProviderPayoutsService } from '../services/provider-payouts.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/payouts')
export class ProviderPayoutsController {
  constructor(private readonly payouts: ProviderPayoutsService) {}

  @Get()
  @TenantCache({ ttl: 5, vary: 'org', epochs: ['provider'], singleFlight: true })
  @ApiOperation({ summary: 'Payout batches, newest first' })
  @ApiCursorPage(ProviderPayoutDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListProviderPayoutsQueryDto,
  ): Promise<CursorPageDto<ProviderPayoutDto>> {
    return this.payouts.listPayouts(session.organizationId, query);
  }
}
