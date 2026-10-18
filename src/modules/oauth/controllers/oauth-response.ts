import { createHash } from 'node:crypto';

import type { Request, Response } from 'express';

import { oauthIpKey } from '../services/oauth-rate-limiter.service';

/**
 * How the OAuth protocol endpoints on `{MCP}` answer (spec §6.3).
 *
 * Every handler writes through `@Res()` with these helpers and never throws to
 * `AllExceptionsFilter`, so a third-party client always gets the RFC 6749
 * shapes: `{error, error_description?}` bodies (§5.2) and `error`, `state`,
 * `iss` redirect parameters (§4.1.2.1, RFC 9207).
 *
 * Nothing a client sent is echoed into a body, a header or a log, except
 * `state` into its own redirect, as RFC 6749 requires. Descriptions are fixed
 * text: never a token, a code, a request id or a hash (R-OA-27).
 */

/** RFC 6749 §5.1: token-bearing responses must not be cached. */
export function setNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/** A JSON body with `Cache-Control: no-store`. */
export function sendJson(res: Response, status: number, body: unknown): void {
  setNoStore(res);
  res.status(status).type('application/json').send(JSON.stringify(body));
}

/** An RFC 6749 §5.2 error body. */
export function sendOAuthError(
  res: Response,
  status: number,
  error: string,
  description?: string,
): void {
  sendJson(res, status, description ? { error, error_description: description } : { error });
}

/** A `302` to `location`, never cached. */
export function redirect(res: Response, location: string): void {
  setNoStore(res);
  res.setHeader('Location', location);
  res.status(302).end();
}

/** An HTML page (the error and 429 pages), never cached. */
export function sendHtml(res: Response, status: number, html: string): void {
  setNoStore(res);
  res.status(status).type('text/html; charset=utf-8').send(html);
}

/**
 * `uri` with `params` appended as query parameters. A registered redirect
 * URI carries no query (§6.3.9 rule 3), but a `&` is used if it ever does,
 * so nothing is overwritten. `null` values are left out.
 */
export function withQuery(uri: string, params: Record<string, string | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) query.append(key, value);
  }
  const encoded = query.toString();
  if (encoded === '') return uri;
  return `${uri}${uri.includes('?') ? '&' : '?'}${encoded}`;
}

/** The fixed `error_description` of each authorization error the server sends. */
export const AUTHORIZATION_ERROR_DESCRIPTIONS = Object.freeze({
  invalid_request: 'The authorization request is missing a parameter or has an invalid one',
  unsupported_response_type: 'Only response_type=code is supported',
  invalid_scope: 'The requested scope is not supported',
  invalid_target: 'The resource must be this MCP server',
  access_denied: 'The person declined the request',
  temporarily_unavailable: 'The server cannot handle the request now; try again',
});

export type AuthorizationErrorCode = keyof typeof AUTHORIZATION_ERROR_DESCRIPTIONS;

/**
 * The redirect of a failed authorization request (RFC 6749 §4.1.2.1), with
 * `iss` (RFC 9207) and the client's `state` when it sent a usable one.
 */
export function authorizationErrorLocation(
  redirectUri: string,
  error: AuthorizationErrorCode,
  state: string | null,
  issuer: string,
  /** Fixed text replacing the error's usual description. */
  description: string = AUTHORIZATION_ERROR_DESCRIPTIONS[error],
): string {
  return withQuery(redirectUri, {
    error,
    error_description: description,
    state,
    iss: issuer,
  });
}

/**
 * A request parameter as one string. A missing parameter is `undefined`; a
 * repeated one, or a nested one (`a[b]=…`), is `null`: RFC 6749 §3.1 forbids
 * repeating a parameter, so the caller refuses it.
 */
export function single(source: unknown, name: string): string | undefined | null {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/** The rate-limit key of the caller: IPv4 as is, IPv6 by its /64. */
export function ipKeyOf(req: Request): string {
  return oauthIpKey(req.ip);
}

/**
 * The rate-limit key of `/oauth/token` and `/oauth/revoke` (§6.3.10): the
 * `client_id` (hashed, so its length is bounded) and the caller's IP key.
 */
export function clientAndIpKey(clientId: string | undefined | null, req: Request): string {
  const client =
    typeof clientId === 'string' && clientId !== ''
      ? createHash('sha256').update(clientId).digest('base64url').slice(0, 22)
      : '-';
  return `${client}:${ipKeyOf(req)}`;
}

/** Whether the request body is form-encoded (RFC 6749 §4.1.3, RFC 7009 §2.1). */
export function isFormEncoded(req: Request): boolean {
  return req.is('application/x-www-form-urlencoded') === 'application/x-www-form-urlencoded';
}

/** The seconds left in the current fixed window of `windowSeconds`. */
export function retryAfterSeconds(windowSeconds: number, now: number = Date.now()): number {
  const windowMs = windowSeconds * 1000;
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

/** The name of an unexpected error, for a log line that cannot carry a secret. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
