import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import {
  CheckConnectivityBodyDto,
  CheckConnectivityResponseDto,
  DeclareEndpointBodyDto,
} from '../dto/check-connectivity.dto';
import {
  GetProviderVerificationParamsDto,
  GetProviderVerificationResponseDto,
} from '../dto/get-provider-verification.dto';
import { ProviderConnectivityService } from '../services/provider-connectivity.service';
import { ProviderVerificationService } from '../services/provider-verification.service';

/**
 * The connectivity check and the `verified` label's read side.
 *
 * A separate controller from `provider.controller.ts` (`@Controller('providers
 * /me')`) rather than an addition to it, so the two concerns stay
 * independent.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers')
export class ProviderConnectivityController {
  constructor(
    private readonly connectivity: ProviderConnectivityService,
    private readonly verification: ProviderVerificationService,
  ) {}

  // Person-only (review A-1), like every provider write: the probe makes the
  // platform call out to a URL the caller names.
  @Post('me/connectivity-check')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({
    summary:
      'Probe an endpoint from the platform egress IPs — "Check we can reach it". Never saves.',
  })
  @ApiResponse({
    status: 200,
    type: CheckConnectivityResponseDto,
    description:
      'Always 200, including UNREACHABLE and BLOCKED outcomes — the result is the payload.',
  })
  @ApiResponse({ status: 400, description: 'No endpoint given and none saved on the provider row' })
  async checkConnectivity(
    @CurrentSession() session: McpSession,
    @Body() body: CheckConnectivityBodyDto,
  ): Promise<CheckConnectivityResponseDto> {
    const result = await this.connectivity.check(session.organizationId, body.endpoint);
    return { ...result };
  }

  // Person-only (review A-1): the endpoint is where buyer traffic goes.
  @Put('me/endpoint')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({
    summary:
      'Declare and save the registration-time endpoint — rejected on the spot if unreachable',
  })
  @ApiResponse({ status: 200, type: CheckConnectivityResponseDto })
  @ApiResponse({
    status: 400,
    description: 'The connectivity check did not come back REACHABLE — nothing was saved',
  })
  async declareEndpoint(
    @CurrentSession() session: McpSession,
    @Body() body: DeclareEndpointBodyDto,
  ): Promise<CheckConnectivityResponseDto> {
    const result = await this.connectivity.declareEndpoint(session.organizationId, body.endpoint);
    return { ...result, saved: true };
  }

  @Get(':providerId/verification')
  @ApiOperation({
    summary: 'The `verified` label for a catalogue listing — informational, not a gate',
  })
  @ApiParam({ name: 'providerId', description: 'Same value as the provider organization id' })
  @ApiResponse({ status: 200, type: GetProviderVerificationResponseDto })
  @ApiResponse({ status: 400, description: 'providerId is not a UUID' })
  @ApiResponse({
    status: 404,
    description:
      "No provider with this id, or not one the caller may read: only the caller's own " +
      'provider, or a provider one of its calls was routed to (any outcome)',
  })
  async getVerification(
    @CurrentSession() session: McpSession,
    @Param() params: GetProviderVerificationParamsDto,
  ): Promise<GetProviderVerificationResponseDto> {
    return this.verification.getVerificationFor(session.organizationId, params.providerId);
  }
}
