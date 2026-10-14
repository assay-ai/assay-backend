import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { extractBearerToken } from '@shared/auth/bearer-token';

import { OperatorSignInService } from '../auth/operator-sign-in.service';
import {
  OperatorChallengeBodyDto,
  OperatorChallengeDto,
  OperatorSignInDto,
  OperatorVerifyBodyDto,
} from '../dto/operator-auth.dto';

/**
 * Operator sign-in: a wallet signs an EIP-4361 message, and gets a session.
 *
 * Unguarded by necessity — these are the routes that produce the credential
 * the operator guard checks. `test/unit/operator/override-coverage.spec.ts`
 * names this controller as the one pre-authentication operator controller and
 * pins its three routes. Nothing here acts on anyone but the caller: the
 * challenge writes a five-minute nonce, the verify issues the caller's own
 * session, and logout revokes the session presented.
 */
@ApiTags('Operator')
@Controller('operator/auth')
export class OperatorSignInController {
  constructor(private readonly signIn: OperatorSignInService) {}

  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'The sign-in message for a wallet to sign' })
  @ApiResponse({ status: 200, type: OperatorChallengeDto })
  async challenge(
    @Body() body: OperatorChallengeBodyDto,
    @Req() request: Request,
  ): Promise<OperatorChallengeDto> {
    return this.signIn.challenge(body.address, request.ip ?? 'unknown');
  }

  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange the signed message for an operator session' })
  @ApiResponse({ status: 200, type: OperatorSignInDto })
  @ApiResponse({ status: 401, description: 'OPERATOR_CREDENTIAL_INVALID' })
  @ApiResponse({ status: 403, description: 'OPERATOR_NOT_AUTHORIZED' })
  @ApiResponse({ status: 429, description: 'OPERATOR_AUTH_RATE_LIMITED' })
  async verify(
    @Body() body: OperatorVerifyBodyDto,
    @Req() request: Request,
  ): Promise<OperatorSignInDto> {
    return this.signIn.verify(body.message, body.signature, request.ip ?? 'unknown');
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the session in the Authorization header' })
  async logout(@Req() request: Request): Promise<void> {
    await this.signIn.logout(extractBearerToken(request));
  }
}
