import { Controller, Get, Inject, Logger, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import { sanitise } from '../domain/client-name';
import { isSupportedChallengeMethod, isValidChallenge } from '../domain/pkce';
import { matches } from '../domain/redirect-uri';
import {
  clearRequestCookie,
  readCookie,
  requestCookieMatches,
  requestCookieName,
  requestCookiesToEvict,
  setRequestCookie,
} from '../domain/request-cookie';
import { normaliseResource } from '../domain/resource';
import { normaliseScope } from '../domain/scope';
import { OAuthClientRegistry, ResolvedClient } from '../services/oauth-client.registry';
import { OAuthMetrics } from '../services/oauth-metrics.service';
import {
  OAUTH_MINUTE_SECONDS,
  OAUTH_RATE_LIMITS,
  OAuthRateLimiter,
} from '../services/oauth-rate-limiter.service';
import {
  OAuthPendingRequest,
  OAuthRequestStore,
  isWellFormedRid,
} from '../services/oauth-request.store';
import { OAuthTokenService } from '../services/oauth-token.service';
import {
  CONTINUE_EXPIRED_PAGE,
  CONTINUE_WRONG_BROWSER_PAGE,
  RATE_LIMITED_PAGE,
  UNAVAILABLE_PAGE,
} from '../views/oauth-pages';
import {
  AuthorizationErrorCode,
  authorizationErrorLocation,
  errorName,
  ipKeyOf,
  redirect,
  retryAfterSeconds,
  sendHtml,
  single,
  withQuery,
} from './oauth-response';

/** `state` is echoed back; longer than this is refused (§6.3.4). */
export const OAUTH_STATE_MAX_LENGTH = 512;
/** The `assay_device` label, after sanitising (§6.3.4). */
export const OAUTH_DEVICE_LABEL_MAX = 32;

/** Why the browser is sent to `{WEB}/connect/authorize-error` instead of the client. */
export type PreRedirectReason =
  | 'client_unknown'
  | 'client_metadata_invalid'
  | 'redirect_uri_mismatch';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET {MCP}/oauth/authorize` and `GET {MCP}/oauth/authorize/continue`
 * (spec §6.3.4, §6.3.5).
 *
 * ```text
 * authorize   rate limit (30/min per IP key)        → 429 page
 *             client_id, then redirect_uri (§6.3.9) → {WEB}/connect/authorize-error?reason=…
 *                                                      never the client
 *             response_type, PKCE (S256), state,
 *             scope, resource                        → redirect_uri?error=…&state=…&iss=…
 *             store the request, set the cookie      → {WEB}/connect/authorize#request={rid}
 * continue    this request's cookie?                 → else the "finish in that browser" page,
 *                                                      and a decided request is discarded
 *             take the request (GETDEL)
 *             approved → mint the code               → redirect_uri?code=…&state=…&iss=…
 *             denied                                 → redirect_uri?error=access_denied&…
 * ```
 *
 * The `rid` travels only in the URL fragment to `{WEB}` and in `continue`'s
 * query (which `LoggingInterceptor` redacts, Task 1.13); the code only in the
 * final redirect. Neither is logged here. Every handler writes its own
 * response and never throws (RFC 6749 shapes, not the platform's).
 *
 * No CORS (`mcp-cors.ts`): these are top-level browser navigations.
 */
@ApiTags('OAuth')
@Controller('oauth/authorize')
export class OAuthAuthorizeController {
  private readonly logger = new Logger(OAuthAuthorizeController.name);

  constructor(
    @Inject(OAUTH_CONFIG) private readonly config: OAuthConfig,
    private readonly registry: OAuthClientRegistry,
    private readonly store: OAuthRequestStore,
    private readonly tokens: OAuthTokenService,
    private readonly limiter: OAuthRateLimiter,
    private readonly metrics: OAuthMetrics,
    private readonly clients: OAuthClientRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Start an authorization request (RFC 6749 §4.1.1, PKCE S256)' })
  async authorize(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      await this.handleAuthorize(req, res);
    } catch (error) {
      this.logger.error(`oauth.authorize failed: ${errorName(error)}`);
      if (!res.headersSent) sendHtml(res, 503, UNAVAILABLE_PAGE);
    }
  }

  @Get('continue')
  @ApiOperation({ summary: 'Finish an approved or denied request in the browser that started it' })
  async continue(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      await this.handleContinue(req, res);
    } catch (error) {
      this.logger.error(`oauth.continue failed: ${errorName(error)}`);
      if (!res.headersSent) sendHtml(res, 503, UNAVAILABLE_PAGE);
    }
  }

  private async handleAuthorize(req: Request, res: Response): Promise<void> {
    const ipKey = ipKeyOf(req);
    const count = await this.limiter.count('authorize-ip', ipKey, OAUTH_MINUTE_SECONDS);
    if (count === null) {
      // The limiter fails closed: with Redis down nothing could be stored anyway.
      sendHtml(res, 503, UNAVAILABLE_PAGE);
      return;
    }
    if (count > OAUTH_RATE_LIMITS.authorizePerIpPerMinute) {
      this.metrics.incAuthorize('rate_limited');
      res.setHeader('Retry-After', String(retryAfterSeconds(OAUTH_MINUTE_SECONDS)));
      sendHtml(res, 429, RATE_LIMITED_PAGE);
      return;
    }

    const query = req.query;

    // Step 1: the client, then its redirect URI. Until both hold, nothing
    // goes to the client: the browser is sent to our own error page.
    const clientId = single(query, 'client_id');
    if (typeof clientId !== 'string' || clientId === '') {
      this.preRedirectFailure(res, 'client_unknown');
      return;
    }
    const resolved = await this.registry.resolve(clientId, ipKey);
    if ('error' in resolved) {
      this.preRedirectFailure(res, resolved.error);
      return;
    }
    const client = resolved;
    const redirectUri = single(query, 'redirect_uri');
    if (
      typeof redirectUri !== 'string' ||
      !matches(client.redirectUris, redirectUri, this.config.redirectAllowlist)
    ) {
      this.preRedirectFailure(res, 'redirect_uri_mismatch');
      return;
    }

    // Step 2: everything else fails back to the client, with `state` and `iss`.
    const rawState = single(query, 'state');
    const stateUsable =
      rawState === undefined ||
      (typeof rawState === 'string' && rawState.length <= OAUTH_STATE_MAX_LENGTH);
    const state = typeof rawState === 'string' && stateUsable ? rawState : null;
    const fail = (error: AuthorizationErrorCode, outcome: 'invalid_request' | 'invalid_target') => {
      this.metrics.incAuthorize(outcome);
      redirect(res, authorizationErrorLocation(redirectUri, error, state, this.config.issuer));
    };

    if (!stateUsable) return fail('invalid_request', 'invalid_request');
    const responseType = single(query, 'response_type');
    if (typeof responseType !== 'string' || responseType === '') {
      return fail('invalid_request', 'invalid_request');
    }
    // RFC 6749 §4.1.2.1; counted with the malformed requests (closed labels).
    if (responseType !== 'code') return fail('unsupported_response_type', 'invalid_request');
    const codeChallenge = single(query, 'code_challenge');
    if (!isValidChallenge(codeChallenge)) return fail('invalid_request', 'invalid_request');
    if (!isSupportedChallengeMethod(single(query, 'code_challenge_method'))) {
      return fail('invalid_request', 'invalid_request');
    }
    const rawScope = single(query, 'scope');
    if (rawScope === null) return fail('invalid_request', 'invalid_request');
    const rawResource = single(query, 'resource');
    if (rawResource === null) return fail('invalid_request', 'invalid_request');
    if (!normaliseResource(rawResource, this.config.issuer).ok) {
      return fail('invalid_target', 'invalid_target');
    }

    const secret = this.config.requestCookieSecret;
    if (secret === null) {
      // Only the MCP app holds the secret; without it no browser can be bound.
      this.logger.error('oauth.authorize: the request-cookie secret is not configured');
      redirect(
        res,
        authorizationErrorLocation(
          redirectUri,
          'temporarily_unavailable',
          state,
          this.config.issuer,
        ),
      );
      return;
    }

    // Step 3: store the request, bind it to this browser, send the person to consent.
    const builtin = client.kind === OAuthClientKind.BUILTIN;
    let rid: string;
    try {
      rid = await this.store.create({
        oauthClientId: client.id,
        redirectUri,
        codeChallenge,
        scope: normaliseScope(rawScope),
        state,
        device: builtin ? deviceLabel(single(query, 'assay_device')) : null,
        replaces: builtin ? replacedCredentialId(single(query, 'assay_replaces')) : null,
      });
    } catch (error) {
      this.logger.error(`oauth.authorize: request not stored: ${errorName(error)}`);
      redirect(
        res,
        authorizationErrorLocation(
          redirectUri,
          'temporarily_unavailable',
          state,
          this.config.issuer,
        ),
      );
      return;
    }
    await this.stampClient(client);
    this.metrics.incAuthorize('stored');

    // One cookie per request; past MAX_REQUEST_COOKIES the oldest are expired.
    res.setHeader('Set-Cookie', [
      ...requestCookiesToEvict(req.headers.cookie).map(clearRequestCookie),
      setRequestCookie(secret, rid),
    ]);
    // A fragment: the rid never reaches a server log or a Referer.
    redirect(res, `${this.config.webAppUrl}/connect/authorize#request=${rid}`);
  }

  private async handleContinue(req: Request, res: Response): Promise<void> {
    const secret = this.config.requestCookieSecret;
    if (secret === null) {
      // Not the MCP app, or misconfigured: no browser binding can be checked,
      // so no code is ever minted. The request is left in place.
      this.logger.error('oauth.continue: the request-cookie secret is not configured');
      sendHtml(res, 503, UNAVAILABLE_PAGE);
      return;
    }

    const rid = single(req.query, 'request');
    if (!isWellFormedRid(rid)) {
      this.metrics.incConsent('not_found');
      sendHtml(res, 404, CONTINUE_EXPIRED_PAGE);
      return;
    }
    const cookieName = requestCookieName(secret, rid);
    if (!requestCookieMatches(secret, rid, readCookie(req.headers.cookie, cookieName))) {
      // Another browser (or none). If the request was already approved or
      // denied, the person who decided it is not in the browser that started
      // it: discard it, so neither they nor whoever started it can finish it
      // (T8). An undecided request stays, so a stray tab cannot end a flow
      // before the person has decided. Both answers are the same page.
      this.metrics.incConsent('continue_cookie_missing');
      await this.store.discardIfDecided(rid);
      sendHtml(res, 403, CONTINUE_WRONG_BROWSER_PAGE);
      return;
    }

    // This browser's request: from here on, the cookie has done its job.
    res.setHeader('Set-Cookie', clearRequestCookie(cookieName));
    const request = await this.store.take(rid);
    if (!request) {
      this.metrics.incConsent('not_found');
      sendHtml(res, 404, CONTINUE_EXPIRED_PAGE);
      return;
    }

    if (request.denied) {
      redirect(
        res,
        authorizationErrorLocation(
          request.redirectUri,
          'access_denied',
          request.state,
          this.config.issuer,
        ),
      );
      return;
    }
    if (!request.approval || !request.boundOrganizationId) {
      // Taken in the browser that started it, before anyone decided: the
      // request is gone and nothing is issued. The client and its redirect
      // were validated when the request was stored, so it is told, rather than
      // left waiting.
      redirect(
        res,
        authorizationErrorLocation(
          request.redirectUri,
          'access_denied',
          request.state,
          this.config.issuer,
          'The request was not approved',
        ),
      );
      return;
    }

    let code: string;
    try {
      code = await this.tokens.mintCode(request, request.approval);
    } catch (error) {
      this.logger.error(`oauth.continue: code not minted: ${errorName(error)}`);
      redirect(res, this.failedMint(request));
      return;
    }
    redirect(
      res,
      withQuery(request.redirectUri, { code, state: request.state, iss: this.config.issuer }),
    );
  }

  private failedMint(request: OAuthPendingRequest): string {
    return authorizationErrorLocation(
      request.redirectUri,
      'temporarily_unavailable',
      request.state,
      this.config.issuer,
    );
  }

  private preRedirectFailure(res: Response, reason: PreRedirectReason): void {
    this.metrics.incAuthorize(reason);
    redirect(res, withQuery(`${this.config.webAppUrl}/connect/authorize-error`, { reason }));
  }

  /** Best effort: a failed stamp must not fail the sign-in. */
  private async stampClient(client: ResolvedClient): Promise<void> {
    try {
      await this.clients.touchLastUsed(client.id);
    } catch (error) {
      this.logger.warn(`oauth.authorize: last_used_at not stamped: ${errorName(error)}`);
    }
  }
}

/** `assay_device`, sanitised; `null` when absent, empty, or longer than 32 characters. */
function deviceLabel(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  return sanitise(raw, OAUTH_DEVICE_LABEL_MAX);
}

/**
 * `assay_replaces`, when it is a credential id. Whether it may be replaced
 * (same organization, built-in client, agent) is the consent API's check; a
 * value of another shape is dropped here.
 */
function replacedCredentialId(raw: string | undefined | null): string | null {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}
