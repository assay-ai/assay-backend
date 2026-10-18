import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { sendOAuthError } from '@modules/oauth/controllers/oauth-response';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

import { routedPathname } from './mcp-cors';

/** The OAuth endpoints whose bodies a client posts (spec §6.3.8, §6.3.10, §6.3.12). */
const OAUTH_BODY_ROUTES: ReadonlySet<string> = new Set([
  '/oauth/token',
  '/oauth/revoke',
  '/oauth/register',
]);

/** The statuses of a body the parser refused: malformed, too large, unsupported. */
const BODY_PARSER_STATUSES: ReadonlySet<number> = new Set([400, 413, 415]);

/**
 * The MCP app's single global filter: `AllExceptionsFilter`, except for a
 * body the parser refused on `POST /oauth/token`, `/oauth/revoke` or
 * `/oauth/register`. That failure happens before the controller runs, so it
 * would leave in the platform's error shape; an OAuth client parses RFC 6749
 * `{error}` instead, so it gets `400 {"error":"invalid_request"}`, not cached.
 *
 * Those handlers never throw (they write their own answers), so on those
 * routes a parser error reaching a filter can only come from the body.
 */
@Catch()
export class McpExceptionsFilter implements ExceptionFilter {
  private readonly platform = new AllExceptionsFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http') {
      const request = host.switchToHttp().getRequest<Request>();
      const response = host.switchToHttp().getResponse<Response>();
      if (isOAuthBodyError(request, exception) && !response.headersSent) {
        sendOAuthError(response, 400, 'invalid_request');
        return;
      }
    }
    this.platform.catch(exception, host);
  }
}

function isOAuthBodyError(request: Request, exception: unknown): boolean {
  if (request.method !== 'POST') return false;
  if (!isBodyParserError(exception)) return false;
  const routed = routedPathname(request.originalUrl ?? request.url ?? '/');
  if (routed === null) return false;
  let path = routed.toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return OAUTH_BODY_ROUTES.has(path);
}

/**
 * A body the parser refused: Nest wraps a malformed body in a
 * `BadRequestException`; other parser failures (too large, bad charset or
 * encoding) arrive as the parser's own `http-errors` error, with a 4xx
 * `status` and a `type` such as `entity.too.large`.
 */
function isBodyParserError(exception: unknown): boolean {
  if (exception instanceof HttpException) return BODY_PARSER_STATUSES.has(exception.getStatus());
  if (!(exception instanceof Error)) return false;
  const { status, type } = exception as Error & { status?: unknown; type?: unknown };
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    typeof type === 'string' &&
    /^(entity|request|charset|encoding|parameters)\./.test(type)
  );
}
