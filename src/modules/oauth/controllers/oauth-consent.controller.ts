import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

import {
  ApproveOAuthRequestBodyDto,
  OAuthConsentRequestDto,
  OAuthRedirectDto,
} from '../dto/oauth-consent.dto';
import { OAuthConsentService } from '../services/oauth-consent.service';

/**
 * `{API}/oauth/requests/{rid}`: the consent page's API (spec §6.3.5).
 *
 * A person only (R-OA-24): `SessionAuthGuard` resolves the bearer, and
 * `HumanSessionGuard` refuses an agent key or an OAuth access token with
 * `AUTH_HUMAN_SESSION_REQUIRED`, so no app can approve itself. The Privy
 * bearer travels in a header, never a cookie, so there is no CSRF surface.
 *
 * `rid` is in the path, so the request logger must redact it (R-OA-27,
 * Task 1.13). Nothing here logs it, and no error message names it.
 */
@ApiTags('OAuth')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@Controller('oauth/requests')
export class OAuthConsentController {
  constructor(private readonly consent: OAuthConsentService) {}

  @Get(':rid')
  @ApiOperation({
    summary:
      'A pending app sign-in, for the consent page. The first organization to read it owns it',
  })
  @ApiResponse({ status: 200, type: OAuthConsentRequestDto })
  @ApiResponse({ status: 403, description: 'AUTH_HUMAN_SESSION_REQUIRED' })
  @ApiResponse({
    status: 404,
    description: 'OAUTH_REQUEST_NOT_FOUND (unknown, expired, other org)',
  })
  @ApiResponse({ status: 409, description: 'OAUTH_REQUEST_ALREADY_DECIDED' })
  read(
    @CurrentSession() session: McpSession,
    @Param('rid') rid: string,
  ): Promise<OAuthConsentRequestDto> {
    return this.consent.read(session, rid);
  }

  @Post(':rid/approve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Approve the app as one of your agents. Mints nothing: the page then goes to redirectTo',
  })
  @ApiResponse({ status: 200, type: OAuthRedirectDto })
  @ApiResponse({ status: 404, description: 'OAUTH_REQUEST_NOT_FOUND, ACCOUNT_AGENT_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'OAUTH_REQUEST_ALREADY_DECIDED, OAUTH_AGENT_NOT_ACTIVE, OAUTH_GRANT_LIMIT_REACHED',
  })
  approve(
    @CurrentSession() session: McpSession,
    @Param('rid') rid: string,
    @Body() body: ApproveOAuthRequestBodyDto,
  ): Promise<OAuthRedirectDto> {
    return this.consent.approve(session, rid, body);
  }

  @Post(':rid/deny')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refuse the app. The page then goes to redirectTo' })
  @ApiResponse({ status: 200, type: OAuthRedirectDto })
  @ApiResponse({ status: 404, description: 'OAUTH_REQUEST_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'OAUTH_REQUEST_ALREADY_DECIDED' })
  deny(
    @CurrentSession() session: McpSession,
    @Param('rid') rid: string,
  ): Promise<OAuthRedirectDto> {
    return this.consent.deny(session, rid);
  }
}
