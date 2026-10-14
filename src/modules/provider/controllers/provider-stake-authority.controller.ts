import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import {
  CreateStakeAuthorityChallengeBodyDto,
  CreateStakeAuthorityChallengeResponseDto,
  ProveStakeAuthorityBodyDto,
  ProveStakeAuthorityResponseDto,
} from '../dto/prove-stake-authority.dto';
import { ProviderStakeAuthorityService } from '../services/provider-stake-authority.service';

/**
 * `POST /providers/me/stake-authority/challenge` and
 * `POST /providers/me/stake-authority`.
 *
 * `organizationId` and `credentialId` come from `@CurrentSession()` only —
 * see `SessionAuthGuard`. There is no admin route, no CLI script and no
 * support path anywhere in this module that reaches
 * `ProviderStakeAuthorityService`, which is what "console only" has to mean
 * for a link that decides whose collateral a slash attestation points at: a
 * channel where a human can be talked into typing a pubkey on someone else's
 * behalf is the whole attack, and `PayoutProofChannel` has one member for the
 * same reason.
 *
 * `POST` on the collection rather than `PUT`, matching the payout pair: the
 * request does not carry the resource, it redeems a nonce, and the result is
 * decided by a signature the platform verifies rather than by what was sent.
 */
@ApiTags('Provider')
@ApiBearerAuth()
// Person-only (review A-1): the stake authority controls the provider's
// capital, so a machine credential may neither name nor prove one.
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('providers/me/stake-authority')
export class ProviderStakeAuthorityController {
  constructor(private readonly stakeAuthority: ProviderStakeAuthorityService) {}

  @Post('challenge')
  @ApiOperation({
    summary: 'Issue a nonce to sign — prove you control the wallet that opened the stake account',
  })
  @ApiResponse({ status: 201, type: CreateStakeAuthorityChallengeResponseDto })
  @ApiResponse({ status: 404, description: 'No provider record for this organization yet' })
  async createChallenge(
    @CurrentSession() session: McpSession,
    @Body() body: CreateStakeAuthorityChallengeBodyDto,
  ): Promise<CreateStakeAuthorityChallengeResponseDto> {
    return this.stakeAuthority.issueChallenge(session, body);
  }

  @Post()
  @ApiOperation({ summary: 'Redeem a signed challenge and prove the stake authority' })
  @ApiResponse({ status: 201, type: ProveStakeAuthorityResponseDto })
  @ApiResponse({ status: 400, description: 'Signature does not verify against the challenge' })
  @ApiResponse({
    status: 409,
    description:
      'Challenge expired or already used, another provider proved that account first, or your ' +
      'current stake authority still names an account holding slashable collateral — bonded, ' +
      'unbonding or exposed',
  })
  @ApiResponse({
    status: 503,
    description:
      'The current stake account could not be read, so the authority was not changed. The check ' +
      'fails closed: an account that cannot be read is never treated as an empty one. Nothing ' +
      'was consumed — retry with the same challenge while it is still valid',
  })
  async prove(
    @CurrentSession() session: McpSession,
    @Body() body: ProveStakeAuthorityBodyDto,
  ): Promise<ProveStakeAuthorityResponseDto> {
    return this.stakeAuthority.prove(session, body);
  }
}
