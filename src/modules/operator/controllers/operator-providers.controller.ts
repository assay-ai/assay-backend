import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

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
    @Param('providerId') providerId: string,
    @Body() body: VerifyProviderBodyDto,
    @Req() request: Request,
  ) {
    return this.verification.setVerification(operator, providerId, body, requestIdOf(request));
  }
}

/**
 * The request id, for cross-system tracing on the override row.
 *
 * Read off the header the platform already sets rather than generated here: an
 * id minted at this layer would trace the override to nothing upstream of it,
 * which is the half of the trace an incident actually needs.
 */
function requestIdOf(request: Request): string | null {
  const header = request.headers['x-request-id'];
  if (typeof header === 'string') return header.slice(0, 64);
  if (Array.isArray(header) && header.length > 0) return header[0].slice(0, 64);
  return null;
}
