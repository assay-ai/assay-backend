import { json } from 'express';
import type { RequestHandler } from 'express';

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
