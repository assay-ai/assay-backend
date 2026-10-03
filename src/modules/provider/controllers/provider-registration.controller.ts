import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentSession, SessionAuthGuard } from '@shared/auth';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import {
  GetProviderRegistrationResponseDto,
  UpdateProviderAccountBodyDto,
} from '../dto/get-provider-registration.dto';
import { RegisterProviderBodyDto, RegisterProviderResponseDto } from '../dto/register-provider.dto';
import { ProviderRegistrationService } from '../services/provider-registration.service';

/**
 * `POST /providers`, `GET /providers/me/registration`,
 * `PATCH /providers/me/registration`.
 *
 * `organizationId` comes from `@CurrentSession()` only — never from the body —
 * for the reason `SessionAuthGuard`'s own comment gives: accepting it as input
 * would let any caller with a valid token register or edit another tenant's
 * provider by naming a different id. `POST /` does not even have an id to
 * accept; the row it creates is keyed to `session.organizationId` inside the
 * service.
 *
 * Distinct from `ProviderController` (`@Controller('providers/me')`, the
 * existing profile/stats/traffic/stake surface) — different route prefix,
 * same guard, no overlapping paths.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('providers')
export class ProviderRegistrationController {
  constructor(private readonly registration: ProviderRegistrationService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Register the calling organization as a provider. Open — no approval step.',
  })
  @ApiResponse({ status: 201, type: RegisterProviderResponseDto })
  @ApiResponse({ status: 409, description: 'This organization has already registered' })
  async register(
    @CurrentSession() session: McpSession,
    @Body() body: RegisterProviderBodyDto,
  ): Promise<RegisterProviderResponseDto> {
    return this.registration.register(session, body);
  }

  @Get('me/registration')
  @ApiOperation({
    summary: 'The onboarding state frame pM65r renders: the row, the four steps, terms, egress IPs',
  })
  @ApiResponse({ status: 200, type: GetProviderRegistrationResponseDto })
  @ApiResponse({ status: 404, description: 'This organization has no provider record' })
  async getRegistration(
    @CurrentSession() session: McpSession,
  ): Promise<GetProviderRegistrationResponseDto> {
    return this.registration.getRegistration(session.organizationId);
  }

  @Patch('me/registration')
  @ApiOperation({
    summary: 'Patch legal name, contacts or timezone; optionally re-accept moved terms',
  })
  @ApiResponse({ status: 200, type: GetProviderRegistrationResponseDto })
  @ApiResponse({ status: 404, description: 'This organization has no provider record' })
  async updateAccount(
    @CurrentSession() session: McpSession,
    @Body() body: UpdateProviderAccountBodyDto,
  ): Promise<GetProviderRegistrationResponseDto> {
    return this.registration.updateAccount(session, body);
  }
}
