import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';

/**
 * CORS on the MCP host, per route family (spec §6.3).
 *
 * ```text
 * /.well-known/*, /oauth/token, /oauth/revoke   *, GET/POST/OPTIONS, Content-Type
 * every other /oauth/* (register, authorize…)    none
 * everything else (the MCP catch-all)            *, MCP headers, exposes the challenge
 * ```
 *
 * Never with credentials: every credential here is a header or a form field,
 * not a cookie, and `*` with credentials is the pairing R17-R-02 removed.
 * `/oauth/register` (L4) and `/oauth/authorize*` get no CORS at all, and so
 * does any other `/oauth/*` path: under `/oauth` a route is cross-origin only
 * when it is listed here.
 *
 * Express matches routes case-insensitively and ignores one trailing slash,
 * so the path is compared the same way: `/OAuth/Register/` is still register.
 */

/** The MCP catch-all: a browser-hosted agent may call it. */
export const MCP_CATCH_ALL_CORS: CorsOptions = Object.freeze({
  origin: '*',
  // `Authorization` is not CORS-safelisted, so it is allowed explicitly;
  // `mcp-session-id` / `mcp-protocol-version` are the Streamable HTTP headers
  // and `mcp-method` / `mcp-name` the ones protocol 2026-07-28 adds.
  allowedHeaders: [
    'content-type',
    'authorization',
    'mcp-session-id',
    'mcp-protocol-version',
    'mcp-method',
    'mcp-name',
  ],
  // `www-authenticate`: an OAuth client in a browser reads the 401 challenge
  // to find the protected resource metadata (R-OA-3).
  exposedHeaders: ['mcp-session-id', 'mcp-protocol-version', 'www-authenticate'],
});

/** Discovery, token and revocation: public endpoints a browser client may call. */
export const OAUTH_PUBLIC_CORS: CorsOptions = Object.freeze({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
});

/** No CORS headers at all: the `cors` middleware passes the request on untouched. */
export const NO_CORS: CorsOptions = Object.freeze({ origin: false });

const OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set(['/oauth/token', '/oauth/revoke']);

export function corsOptionsForPath(rawPath: string): CorsOptions {
  let path = rawPath.split('?', 1)[0].toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  if (path === '/.well-known' || path.startsWith('/.well-known/')) return OAUTH_PUBLIC_CORS;
  if (OAUTH_PUBLIC_PATHS.has(path)) return OAUTH_PUBLIC_CORS;
  if (path === '/oauth' || path.startsWith('/oauth/')) return NO_CORS;
  return MCP_CATCH_ALL_CORS;
}

/** For `app.enableCors` in `bootstrap/mcp/main.ts`. */
export const mcpCorsOptions: CorsOptionsDelegate<Request> = (request, callback) =>
  callback(null, corsOptionsForPath(request.originalUrl ?? request.url ?? '/'));
