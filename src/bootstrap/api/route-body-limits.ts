import { json } from 'express';
import type { RequestHandler } from 'express';

import { buildApiCorsOptionsDelegate } from '@shared/security/cors-policy';

/**
 * Routes whose JSON body may exceed the default 100 KB, and their limit.
 *
 * `POST /provider/tools/try` takes a pasted OpenAPI document (capped at
 * 512 KB of text by its DTO), so its parser allows 600 KB; every other
 * route keeps the default. Mounted before Nest's own body parser: that parser
 * skips a request already parsed, so the larger limit applies to exactly
 * these paths and nowhere else.
 */
export const ROUTE_BODY_LIMITS: ReadonlyArray<{ readonly path: string; readonly limit: string }> =
  Object.freeze([{ path: '/api/v1/provider/tools/try', limit: '600kb' }]);

export function applyRouteBodyLimits(app: {
  use(path: string, handler: RequestHandler): unknown;
}): void {
  for (const { path, limit } of ROUTE_BODY_LIMITS) {
    const parse = json({ limit });
    app.use(path, function routeScopedJsonParser(req, res, next) {
      parse(req, res, next);
    });
  }
}

/**
 * The API's CORS policy, then the route-scoped parsers — in that order, and
 * in one place so the order cannot drift. A body a route parser refuses (413)
 * then still carries the CORS headers, and the page can read the error
 * instead of failing the fetch.
 */
export function applyApiCorsAndRouteBodyLimits(
  app: {
    enableCors(options: ReturnType<typeof buildApiCorsOptionsDelegate>): void;
    use(path: string, handler: RequestHandler): unknown;
  },
  allowedOrigins: readonly string[],
): void {
  app.enableCors(buildApiCorsOptionsDelegate(allowedOrigins));
  applyRouteBodyLimits(app);
}
