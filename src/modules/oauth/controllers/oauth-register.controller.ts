import { Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { DcrService } from '../services/dcr.service';
import { OAUTH_HOUR_SECONDS } from '../services/oauth-rate-limiter.service';
import { errorName, ipKeyOf, retryAfterSeconds, sendJson, sendOAuthError } from './oauth-response';

/**
 * `POST {MCP}/oauth/register`: dynamic client registration (spec §6.3.8,
 * RFC 7591, R-OA-10). Open, public clients only; `DcrService` validates and
 * applies every limit (20/h per IP key, the /48 and daily caps), all failing
 * closed.
 *
 * ```text
 * registered                  201 {client_id, …}        no secret, no management URI
 * invalid metadata            400 invalid_redirect_uri | invalid_client_metadata
 * over a limit, Redis down    429 + Retry-After
 * ```
 *
 * No CORS (L4, `mcp-cors.ts`): a browser page cannot register clients. The
 * body is never logged.
 */
@ApiExcludeController()
@Controller('oauth')
export class OAuthRegisterController {
  private readonly logger = new Logger(OAuthRegisterController.name);

  constructor(private readonly dcr: DcrService) {}

  @Post('register')
  @HttpCode(201)
  async register(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      // A body that is not JSON is no metadata at all: validated as such.
      const body: unknown = req.is('application/json') ? req.body : undefined;
      const result = await this.dcr.register(body, ipKeyOf(req));
      if (result.ok === true) {
        sendJson(res, 201, result.body);
        return;
      }
      if (result.error === 'rate_limited') {
        res.setHeader('Retry-After', String(retryAfterSeconds(OAUTH_HOUR_SECONDS)));
        sendOAuthError(res, 429, 'temporarily_unavailable', 'Too many registrations; retry later');
        return;
      }
      sendOAuthError(res, 400, result.error);
    } catch (error) {
      this.logger.error(`oauth.register failed: ${errorName(error)}`);
      if (!res.headersSent) sendOAuthError(res, 500, 'server_error');
    }
  }
}
