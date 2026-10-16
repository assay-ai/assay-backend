import type { NextFunction, Request, Response } from 'express';

/** 180 days, the common minimum for HSTS preload-style policies. */
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * The response headers every HTTP process sets on every response (R17-R-02).
 *
 * - `X-Content-Type-Options: nosniff` — a JSON or CSV body is never run as a
 *   script or stylesheet because a browser guessed its type.
 * - `Content-Security-Policy: frame-ancestors 'none'` and
 *   `X-Frame-Options: DENY` — no page may frame a response (clickjacking on
 *   Swagger UI and Bull Board, the two HTML pages these processes serve).
 *   Nothing stricter: those two pages load their own scripts and styles.
 * - `Referrer-Policy: no-referrer` — a link out of Swagger UI or Bull Board
 *   does not carry the URL it came from.
 * - `Strict-Transport-Security` — only in production. On plain-HTTP localhost
 *   it is ignored at best, and at worst pins `localhost` to HTTPS in the
 *   developer's browser for every other app on that host.
 *
 * `X-Powered-By` is removed separately by `app.disable('x-powered-by')`.
 */
export function securityHeadersMiddleware(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): (request: Request, response: Response, next: NextFunction) => void {
  const production = nodeEnv === 'production';
  return (_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (production) {
      response.setHeader(
        'Strict-Transport-Security',
        `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
      );
    }
    next();
  };
}

/** The Express surface `applyHttpSecurity` needs from a Nest application. */
interface ExpressLikeApp {
  getHttpAdapter(): { getInstance(): { disable(setting: string): unknown } };
  use(...handlers: unknown[]): unknown;
}

/**
 * Drops `X-Powered-By` and installs `securityHeadersMiddleware`. Call it in a
 * bootstrap before `listen`, so the headers are on every response, error
 * responses and 404s included.
 */
export function applyHttpSecurity(app: ExpressLikeApp, nodeEnv = process.env.NODE_ENV): void {
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(securityHeadersMiddleware(nodeEnv));
}
