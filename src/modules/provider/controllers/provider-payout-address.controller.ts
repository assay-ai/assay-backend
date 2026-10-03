import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import {
  CreatePayoutChallengeBodyDto,
  CreatePayoutChallengeResponseDto,
  ProvePayoutAddressBodyDto,
  ProvePayoutAddressResponseDto,
} from '../dto/prove-payout-address.dto';
import { ProviderPayoutAddressService } from '../services/provider-payout-address.service';

/**
 * `POST /providers/me/payout-address/challenge` and
 * `POST /providers/me/payout-address`.
 *
 * `organizationId` and `credentialId` come from `@CurrentSession()` only —
 * see `SessionAuthGuard`. That is the whole of what makes this surface
 * "console only": there is no admin
 * route, no CLI script and no email path anywhere in this module that can
 * reach `ProviderPayoutAddressService`, and the only way to authenticate to
 * *this* one is the same session-token guard every other self-service
 * provider route uses.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers/me/payout-address')
export class ProviderPayoutAddressController {
  constructor(private readonly payoutAddress: ProviderPayoutAddressService) {}

  @Post('challenge')
  @ApiOperation({
    summary: 'Issue a nonce to sign — "Sign a nonce to prove you control this wallet"',
  })
  @ApiResponse({ status: 201, type: CreatePayoutChallengeResponseDto })
  @ApiResponse({ status: 404, description: 'No provider record for this organization yet' })
  async createChallenge(
    @CurrentSession() session: McpSession,
    @Body() body: CreatePayoutChallengeBodyDto,
  ): Promise<CreatePayoutChallengeResponseDto> {
    return this.payoutAddress.issueChallenge(session, body);
  }

  @Post()
  @ApiOperation({ summary: 'Redeem a signed challenge and prove the payout address' })
  @ApiResponse({ status: 201, type: ProvePayoutAddressResponseDto })
  @ApiResponse({ status: 400, description: 'Signature does not verify against the challenge' })
  @ApiResponse({ status: 409, description: 'Challenge expired, or already used' })
  async prove(
    @CurrentSession() session: McpSession,
    @Body() body: ProvePayoutAddressBodyDto,
  ): Promise<ProvePayoutAddressResponseDto> {
    return this.payoutAddress.prove(session, body);
  }
}
