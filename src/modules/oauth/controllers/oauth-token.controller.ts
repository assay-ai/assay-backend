import { createHash } from 'node:crypto';

import { Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { isValidVerifier } from '../domain/pkce';
import { OAuthMetrics, OAuthTokenGrantType } from '../services/oauth-metrics.service';
import {
  OAUTH_MINUTE_SECONDS,
  OAUTH_RATE_LIMITS,
  OAuthRateLimiter,
} from '../services/oauth-rate-limiter.service';
import {
  OAuthError,
  OAuthErrorType,
  OAuthTokenService,
  TokenPair,
  isOAuthError,
} from '../services/oauth-token.service';
import {
  errorName,
  ipKeyOf,
  isFormEncoded,
  retryAfterSeconds,
  sendJson,
  sendOAuthError,
  single,
} from './oauth-response';

/** HTTP status of each token error (RFC 6749 §5.2; spec §6.3.10, §6.3.11). */
const ERROR_STATUS: Readonly<Record<OAuthErrorType, number>> = Object.freeze({
  invalid_request: 400,
  invalid_client: 401,
  invalid_grant: 400,
  unauthorized_client: 400,
  unsupported_grant_type: 400,
  invalid_scope: 400,
  invalid_target: 400,
  // The refresh grace entry could not be stored, so nothing was issued (§6.3.11).
  temporarily_unavailable: 503,
});

const INVALID_REQUEST: OAuthError = { error: 'invalid_request' };

/**
 * `POST {MCP}/oauth/token`, form-encoded (spec §6.3.10, §6.3.11).
 *
 * ```text
 * not form-encoded, a repeated parameter      400 invalid_request
 * 60/min per client_id + IP key               429 + Retry-After
 * grant_type missing / other                  400 invalid_request / unsupported_grant_type
 * authorization_code: code, redirect_uri,
 *   client_id, code_verifier (43–128 chars)   else 400 invalid_request (before the code is burned)
 * refresh_token: refresh_token, client_id     else 400 invalid_request
 * the service's answer                        200 pair | 400 | 401 invalid_client
 *                                             | 503 temporarily_unavailable
 * ```
 *
 * Every answer is `Cache-Control: no-store`, `Pragma: no-cache`, and counted
 * in `assay_oauth_token_total{grant_type, result}`. The body is never logged
 * (R-OA-27): an unexpected error is logged by its class name only.
 *
 * CORS `*` without credentials (`mcp-cors.ts`): a browser client may call it.
 */
@ApiExcludeController()
@Controller('oauth')
export class OAuthTokenController {
  private readonly logger = new Logger(OAuthTokenController.name);

  constructor(
    private readonly tokens: OAuthTokenService,
    private readonly limiter: OAuthRateLimiter,
    private readonly metrics: OAuthMetrics,
  ) {}

  @Post('token')
  @HttpCode(200)
  async token(@Req() req: Request, @Res() res: Response): Promise<void> {
    const body: unknown = isFormEncoded(req) ? req.body : undefined;
    const rawGrantType = single(body, 'grant_type');
    const grantType = grantTypeLabel(rawGrantType);
    try {
      const outcome = await this.handle(req, body, rawGrantType);
      if (outcome === 'rate_limited') {
        this.metrics.incToken(grantType, 'rate_limited');
        res.setHeader('Retry-After', String(retryAfterSeconds(OAUTH_MINUTE_SECONDS)));
        sendOAuthError(res, 429, 'temporarily_unavailable', 'Too many token requests; retry later');
        return;
      }
      if (isOAuthError(outcome)) {
        this.metrics.incToken(grantType, outcome.error);
        sendOAuthError(res, ERROR_STATUS[outcome.error], outcome.error, outcome.error_description);
        return;
      }
      this.metrics.incToken(grantType, 'ok');
      sendJson(res, 200, outcome);
    } catch (error) {
      this.logger.error(`oauth.token failed: ${errorName(error)}`);
      this.metrics.incToken(grantType, 'server_error');
      if (!res.headersSent) sendOAuthError(res, 500, 'server_error');
    }
  }

  private async handle(
    req: Request,
    body: unknown,
    grantType: string | undefined | null,
  ): Promise<TokenPair | OAuthError | 'rate_limited'> {
    // The request's shape first: nothing malformed reaches a counter or a code.
    if (body === undefined) return INVALID_REQUEST;
    const clientId = single(body, 'client_id');
    if (grantType === null || clientId === null) return INVALID_REQUEST;

    const key = `${clientKeyPart(clientId)}:${ipKeyOf(req)}`;
    const count = await this.limiter.count('token', key, OAUTH_MINUTE_SECONDS);
    if (count === null) return { error: 'temporarily_unavailable' };
    if (count > OAUTH_RATE_LIMITS.tokenPerClientAndIpPerMinute) return 'rate_limited';

    if (grantType === undefined || grantType === '') return INVALID_REQUEST;
    if (typeof clientId !== 'string' || clientId === '') return INVALID_REQUEST;

    if (grantType === 'authorization_code') {
      const code = single(body, 'code');
      const redirectUri = single(body, 'redirect_uri');
      const codeVerifier = single(body, 'code_verifier');
      const resource = single(body, 'resource');
      if (
        typeof code !== 'string' ||
        code === '' ||
        typeof redirectUri !== 'string' ||
        redirectUri === '' ||
        resource === null ||
        // RFC 7636 §4.1: a malformed verifier is a malformed request, answered
        // before the code is burned.
        !isValidVerifier(codeVerifier)
      ) {
        return INVALID_REQUEST;
      }
      return this.tokens.exchangeCode({ code, redirectUri, clientId, codeVerifier, resource });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = single(body, 'refresh_token');
      const scope = single(body, 'scope');
      if (typeof refreshToken !== 'string' || refreshToken === '' || scope === null) {
        return INVALID_REQUEST;
      }
      return this.tokens.refresh({ refreshToken, clientId, scope });
    }

    return { error: 'unsupported_grant_type' };
  }
}

/** A closed label: a client cannot mint label values. */
function grantTypeLabel(raw: string | undefined | null): OAuthTokenGrantType {
  return raw === 'authorization_code' || raw === 'refresh_token' ? raw : 'other';
}

/** The `client_id` part of the rate-limit key: hashed, so its length is bounded. */
function clientKeyPart(clientId: string | undefined): string {
  if (typeof clientId !== 'string' || clientId === '') return '-';
  return createHash('sha256').update(clientId).digest('base64url').slice(0, 22);
}
