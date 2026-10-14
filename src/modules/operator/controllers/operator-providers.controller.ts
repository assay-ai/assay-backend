import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { VerifyProviderBodyDto } from '../dto/operator-console.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorProviderVerificationService } from '../services/operator-provider-verification.service';

/**
 * The provider-label surface. `V-7`.
 *
 * Same three guards, in the same order and for the same three questions, as
 * `OperatorCasesController` — see its class comment. Like every route on this
 * prefix it reads and writes across organizations by construction: the subject
 * of a verification is a provider who is never the caller, and an operator has
 * no tenant of their own.
 *
 * There is no operator screen behind this yet; it is callable by hand only.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator')
export class OperatorProvidersController {
  constructor(private readonly verification: OperatorProviderVerificationService) {}

  /** `V-7` — the only writer of `providers.verified`. */
  @Post('providers/:providerId/verification')
  @Override('V-7')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.BD)
  @ApiOperation({ summary: 'Set or clear a provider’s verified label' })
  @ApiResponse({ status: 404, description: 'No such provider' })
  async setVerification(
    @CurrentOperator() operator: OperatorSession,
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() body: VerifyProviderBodyDto,
  ) {
    return this.verification.setVerification(operator, providerId, body, requestIdOf());
  }
}

/**
 * The request id for the override row: the one this server minted for the
 * request (review L-7), never the caller's `x-request-id`, so a client cannot
 * point the entry at an unrelated trace. Log lines of the same request carry
 * it as `serverRequestId` beside the caller's `requestId`.
 */
function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
