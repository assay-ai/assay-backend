import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import {
  GetProviderReconciliationQueryDto,
  GetProviderReconciliationResponseDto,
} from '../dto/provider-reconciliation.dto';
import { ProviderReconciliationService } from '../services/provider-reconciliation.service';

/**
 * `GET /providers/me/reconciliation`. Separate controller from
 * `ProviderController` (`@Controller('providers/me')`), the same idiom
 * `ProviderPayoutsController` / `ProviderStakeIntentController` etc. already
 * use for a `providers/me/*` sub-resource — see those files.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/reconciliation')
export class ProviderReconciliationController {
  constructor(private readonly reconciliation: ProviderReconciliationService) {}

  @Get()
  @ApiOperation({
    summary:
      'Why we credited you less than you served: class breakdown, gross/take/net and the ' +
      'batches that paid it — our side alone, no uploaded log required',
  })
  @ApiResponse({ status: 200, type: GetProviderReconciliationResponseDto })
  async getReconciliation(
    @CurrentSession() session: McpSession,
    @Query() query: GetProviderReconciliationQueryDto,
  ): Promise<GetProviderReconciliationResponseDto> {
    return this.reconciliation.getReconciliation(session.organizationId, query);
  }
}
