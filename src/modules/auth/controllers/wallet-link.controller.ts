import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { extractBearerToken } from '@shared/auth';

import { LinkWalletResponseDto } from '../dto/link-wallet.dto';
import { WalletLinkService } from '../services/wallet-link.service';

/**
 * `POST /api/v1/auth/wallet/link` — see {@link WalletLinkService} for why this
 * route exists and why it is not behind `SessionAuthGuard`.
 *
 * `POST` rather than `GET` because it writes: a successful call sets
 * `agents.primary_account_id`. 200 rather than 201 because it creates no
 * resource of its own — it reports on one that already exists.
 */
@ApiTags('Auth')
@ApiBearerAuth()
@Controller('auth')
export class WalletLinkController {
  constructor(private readonly walletLink: WalletLinkService) {}

  @Post('wallet/link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-read this identity from Privy and link its Solana wallet if there is one now',
  })
  @ApiResponse({ status: 200, type: LinkWalletResponseDto })
  @ApiResponse({ status: 401, description: 'The access token did not verify' })
  @ApiResponse({ status: 403, description: 'The agent or its organization is suspended' })
  link(@Req() request: Request): Promise<LinkWalletResponseDto> {
    return this.walletLink.link(extractBearerToken(request));
  }
}
