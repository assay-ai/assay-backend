import { Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import {
  OAUTH_MINUTE_SECONDS,
  OAUTH_RATE_LIMITS,
  OAuthRateLimiter,
} from '../services/oauth-rate-limiter.service';
import { OAuthTokenService } from '../services/oauth-token.service';
import {
  clientAndIpKey,
  errorName,
  ipKeyOf,
  isFormEncoded,
  retryAfterSeconds,
  sendOAuthError,
  setNoStore,
  single,
} from './oauth-response';

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
 * The one exception is the rate limit, on counters of its own: the token
 * endpoint's, per `client_id` and IP key, 60 a minute; and, as revocation
 * looks a token up whatever client it names, 120 a minute per IP key alone,
 * so a caller rotating `client_id` is bounded too. Past either the answer is 503 with
 * `Retry-After`, which RFC 7009 §2.2.1 tells a client to retry. With Redis
 * unreachable the revocation still runs: refusing a logout would only keep a
 * token alive.
 *
 * CORS `*` without credentials (`mcp-cors.ts`). The body is never logged.
 */
@ApiTags('OAuth')
@Controller('oauth')
export class OAuthRevokeController {
  private readonly logger = new Logger(OAuthRevokeController.name);

  constructor(
    private readonly tokens: OAuthTokenService,
    private readonly limiter: OAuthRateLimiter,
  ) {}

  @Post('revoke')
  @ApiOperation({ summary: 'Revoke a refresh or access token (RFC 7009)' })
  @HttpCode(200)
  async revoke(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const body: unknown = isFormEncoded(req) ? req.body : undefined;
      const token = single(body, 'token');
      const clientId = single(body, 'client_id');
      const perIp = await this.limiter.count('revoke-ip', ipKeyOf(req), OAUTH_MINUTE_SECONDS);
      const count = await this.limiter.count(
        'revoke',
        clientAndIpKey(clientId, req),
        OAUTH_MINUTE_SECONDS,
      );
      if (
        (perIp !== null && perIp > OAUTH_RATE_LIMITS.revokePerIpPerMinute) ||
        (count !== null && count > OAUTH_RATE_LIMITS.tokenPerClientAndIpPerMinute)
      ) {
        res.setHeader('Retry-After', String(retryAfterSeconds(OAUTH_MINUTE_SECONDS)));
        sendOAuthError(res, 503, 'temporarily_unavailable', 'Too many revocations; retry later');
        return;
      }
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
