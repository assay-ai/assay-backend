import { All, Controller, Inject, Optional, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { sessionBlockedError } from '@modules/blocklist/services/blocklist-session.source';
import { challengeHeader } from '@modules/oauth/domain/www-authenticate';
import { MCP_HOST_CONFIG, McpHostConfig } from '@modules/toolset/config/mcp-host.config';
import { attributionOf } from '@modules/toolset/domain/attribution';
import {
  browserRedirectTarget,
  canonicalUrl,
  isBrowserRequest,
  parseMcpUrl,
} from '@modules/toolset/domain/mcp-url';
import { AccessResolver } from '@modules/toolset/services/access.resolver';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { BaseError } from '@shared/errors/base.error';

import { MCP_BEARER_SCHEME_RE } from '../constants/mcp.constants';
import { McpErrorCode, McpErrors } from '../errors/mcp.errors';
import { McpScope } from '../ports/mcp-scope';
import { MCP_SESSION_SOURCE, McpSession, McpSessionPort } from '../ports/mcp-session.port';
import {
  MCP_UNAUTHORIZED_RECORDER,
  McpUnauthorizedRecorder,
  unauthorizedReasonOf,
} from '../ports/mcp-unauthorized.port';
import { McpAuthFailureThrottle } from '../services/mcp-auth-failure-throttle.service';
import { McpHttpBridge } from '../services/mcp-http-bridge';
import { McpServerFactory } from '../services/mcp-server.factory';

/**
 * The Streamable HTTP transport, on every path of the MCP host
 * (`mcp.assay.ai`, design spec §7.4).
 *
 * Each URL is its own MCP server: `/` serves the whole catalogue and
 * `/my/{slug}` the organization's own toolset; the forms later phases serve
 * parse already and answer 404 until then. One key works on every URL.
 *
 * ```text
 * request ─▶ parse the URL (canonical form)        unknown form        → 404
 *         ─▶ a browser? (before auth)              302 to the web app
 *         ─▶ this address sent too many bad tokens  → 429, no lookup
 *         ─▶ authenticate                           no or bad token     → 401
 *                                                   + WWW-Authenticate
 *         ─▶ resolve the URL for this org           not here / not his  → 404
 *         ─▶ resolve the caller's access (cached, invalidated on write)
 *         ─▶ one MCP server bound to session + scope, for this request only
 *            (protocol 2026-07-28 or a 2025-era client: `McpHttpBridge`)
 * ```
 *
 * Sessionless: nothing is carried between requests but the session token, so
 * the service scales horizontally with no sticky sessions.
 *
 * ## Why this bypasses the platform's HTTP conventions
 *
 * Every body here is JSON-RPC 2.0, defined by the MCP specification, so
 * nothing goes through `TransformInterceptor` and the response is written to
 * `@Res()` directly. What is *not* bypassed is everything that happens before
 * a transport exists: an unknown URL, a missing token and another
 * organization's toolset leave as the platform's ordinary `404` / `401`.
 *
 * ## `@All` rather than `@Post`
 *
 * Streamable HTTP uses `GET` for the server-to-client stream and `DELETE` to
 * end a session; the bridge answers both with a protocol-correct `405`,
 * where routing only `POST` would have Nest answer them with a `404` an MCP
 * client cannot interpret.
 *
 * `/health` is the MCP service's own `HealthcheckController`, registered by
 * the root module before this catch-all, so it keeps answering.
 */
@Controller()
export class McpController {
  private readonly bridge: McpHttpBridge;

  constructor(
    @Inject(MCP_SESSION_SOURCE) private readonly sessions: McpSessionPort,
    private readonly servers: McpServerFactory,
    private readonly endpoints: McpEndpointResolver,
    private readonly access: AccessResolver,
    @Inject(MCP_HOST_CONFIG) private readonly host: McpHostConfig,
    // The MCP app's 401 counter (`OAuthMcpModule`); absent elsewhere.
    @Optional()
    @Inject(MCP_UNAUTHORIZED_RECORDER)
    private readonly unauthorized?: McpUnauthorizedRecorder,
    // Refused-credential count per address (`McpHttpModule`); absent in unit tests.
    @Optional() private readonly authFailures?: McpAuthFailureThrottle,
  ) {
    this.bridge = new McpHttpBridge((session, scope) => this.servers.create(session, scope));
  }

  @All('{*path}')
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const parsed = parseMcpUrl(request.originalUrl);

    // A person's browser gets the web page for this URL, before any
    // authentication: a browser has no token, and a 401 would explain
    // nothing. The redirect itself reveals nothing private.
    if (isBrowserRequest(request)) {
      const target = browserRedirectTarget(
        this.host.webAppUrl,
        parsed,
        parsed ? canonicalUrl(this.host.mcpPublicUrl, parsed) : null,
      );
      response.redirect(302, target);
      return;
    }

    if (!parsed) throw McpErrors.urlNotFound();

    const session = await this.authenticate(request, response);
    // A blocked person's session exists so the dashboard can read; nothing on
    // this endpoint is a read of the account's own data — `tools/list` is the
    // shop and `tools/call` spends — so it is refused whole.
    if (session.blocked) throw sessionBlockedError(session.blocked);

    const view = await this.endpoints.resolve(session.organizationId, parsed);
    const scope: McpScope = {
      view,
      access: await this.access.resolve(session),
      attribution: attributionOf(view),
    };

    await this.bridge.serve(request, response, { session, scope });
  }

  /**
   * The session, or the refusal. A missing or invalid credential
   * (`MCP_CREDENTIAL_INVALID`) also gets the OAuth challenge (spec §6.3.3,
   * R-OA-3), naming the protected resource metadata of the path the client
   * asked for, so it can sign in from the URL alone. Identified refusals
   * (suspended agent or organization, no wallet) keep their status and get no
   * header: the credential is fine, and signing in again would not help.
   */
  private async authenticate(request: Request, response: Response): Promise<McpSession> {
    const token = bearerToken(request);
    const retryAfter = (await this.authFailures?.blockedForSeconds(request.ip)) ?? 0;
    if (retryAfter > 0) {
      response.setHeader('Retry-After', String(retryAfter));
      throw McpErrors.authRateLimited();
    }
    try {
      return await this.sessions.resolve(token);
    } catch (error) {
      if (error instanceof BaseError && error.errorCode === McpErrorCode.MCP_CREDENTIAL_INVALID) {
        // Only a made-up token is counted. A missing one is the first step of
        // an OAuth sign-in, and an expired, revoked or wrong-audience one was a
        // real credential: OAuth access tokens expire every hour, so counting
        // them would block a hosted connector's whole shared egress address.
        if (token !== null && (unauthorizedReasonOf(error) ?? 'unknown') === 'unknown') {
          await this.authFailures?.recordFailure(request.ip);
        }
        this.unauthorized?.record(
          token === null ? 'missing' : (unauthorizedReasonOf(error) ?? 'unknown'),
        );
        response.setHeader(
          'WWW-Authenticate',
          challengeHeader(this.host.mcpPublicUrl, request.originalUrl, token !== null),
        );
      }
      throw error;
    }
  }
}

/**
 * `Authorization: Bearer <token>`, or nothing. Every malformed variant is
 * `null`: a missing token and an invalid one are refused identically.
 */
function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const scheme = MCP_BEARER_SCHEME_RE.exec(header);
  if (!scheme) return null;

  const token = header.slice(scheme[0].length).trim();
  return token.length > 0 ? token : null;
}
