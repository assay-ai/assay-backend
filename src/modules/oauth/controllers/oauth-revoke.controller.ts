import { Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { OAuthTokenService } from '../services/oauth-token.service';
import { errorName, isFormEncoded, setNoStore, single } from './oauth-response';

/**
 * `POST {MCP}/oauth/revoke` (RFC 7009, spec §6.3.12): `token`, optional
 * `token_type_hint`, `client_id`. A refresh token revokes its grant, an
 * access token itself (`OAuthTokenService.revoke`).
 *
 * Always `200` with an empty body, whatever happened: an unknown, malformed,
 * already revoked or other client's token, a malformed request, or a failure
 * here. The answer never tells a caller whether a token existed. The hint is
 * not needed: the token's prefix says what it is.
 *
 * CORS `*` without credentials (`mcp-cors.ts`). The body is never logged.
 */
@ApiExcludeController()
@Controller('oauth')
export class OAuthRevokeController {
  private readonly logger = new Logger(OAuthRevokeController.name);

  constructor(private readonly tokens: OAuthTokenService) {}

  @Post('revoke')
  @HttpCode(200)
  async revoke(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const body: unknown = isFormEncoded(req) ? req.body : undefined;
      const token = single(body, 'token');
      const clientId = single(body, 'client_id');
      if (typeof token === 'string' && token !== '' && typeof clientId === 'string') {
        await this.tokens.revoke({ token, clientId });
      }
    } catch (error) {
      this.logger.error(`oauth.revoke failed: ${errorName(error)}`);
    }
    setNoStore(res);
    res.status(200).end();
  }
}
