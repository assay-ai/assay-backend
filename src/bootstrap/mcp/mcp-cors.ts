import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';

/**
 * CORS on the MCP host, per route family (spec §6.3).
 *
 * ```text
 * /.well-known/*                               *, GET/POST/OPTIONS, Content-Type,
 *                                               MCP-Protocol-Version
 * /oauth/token, /oauth/revoke                   *, GET/POST/OPTIONS, Content-Type
 * every other /oauth/* (register, authorize…)    none
 * a target that is not a path (`*`, odd forms)  none
 * everything else (the MCP catch-all)            *, MCP headers, exposes the challenge
 * ```
 *
 * Never with credentials: every credential here is a header or a form field,
 * not a cookie, and `*` with credentials is the pairing R17-R-02 removed.
 * `/oauth/register` (L4) and `/oauth/authorize*` get no CORS at all, and so
 * does any other `/oauth/*` path: under `/oauth` a route is cross-origin only
 * when it is listed here.
 *
 * The path is the one the router matches: the pathname of the request
 * target (`parseurl` semantics, so an absolute-form target
 * `http://host/oauth/register` is `/oauth/register`), compared
 * case-insensitively and without one trailing slash, as Express routes it:
 * `/OAuth/Register/` is still register. A target that yields no pathname
 * starting with `/` gets no CORS.
 */

/**
 * How long a browser may reuse a preflight on this host, in seconds (7200 is
 * Chromium's cap). A browser-hosted agent sends `Authorization` and the MCP
 * headers on every call, none of them safelisted, so without it each call
 * pays an `OPTIONS` round trip; the answers below depend only on the route.
 */
export const MCP_PREFLIGHT_MAX_AGE_SECONDS = 7200;

/** The MCP catch-all: a browser-hosted agent may call it. */
export const MCP_CATCH_ALL_CORS: CorsOptions = Object.freeze({
  origin: '*',
  maxAge: MCP_PREFLIGHT_MAX_AGE_SECONDS,
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
  exposedHeaders: ['mcp-session-id', 'mcp-protocol-version', 'www-authenticate', 'retry-after'],
});

/**
 * Discovery documents. `MCP-Protocol-Version` is allowed because the MCP SDK
 * sends it on every metadata fetch; it is not a credential, and without it a
 * browser client pays a failed preflight and a retry on each document.
 */
export const WELL_KNOWN_CORS: CorsOptions = Object.freeze({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'MCP-Protocol-Version'],
  credentials: false,
  maxAge: MCP_PREFLIGHT_MAX_AGE_SECONDS,
});

/** Token and revocation: public endpoints a browser client may call. */
export const OAUTH_PUBLIC_CORS: CorsOptions = Object.freeze({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
  maxAge: MCP_PREFLIGHT_MAX_AGE_SECONDS,
});

/** No CORS headers at all: the `cors` middleware passes the request on untouched. */
export const NO_CORS: CorsOptions = Object.freeze({ origin: false });

const OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set(['/oauth/token', '/oauth/revoke']);

/** An absolute-form request target's scheme and authority (RFC 9112 §3.2.2). */
const ABSOLUTE_FORM_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/**
 * The pathname the router matches for a request target: no query, no
 * fragment, the scheme and authority of an absolute-form target removed (an
 * empty path is `/`). `null` when the target is not a path at all.
 */
export function routedPathname(target: string): string | null {
  let rest = target;
  if (!rest.startsWith('/')) {
    const authority = ABSOLUTE_FORM_PREFIX.exec(rest);
    if (!authority) return null;
    rest = rest.slice(authority[0].length);
  }
  const path = rest.split(/[?#]/, 1)[0];
  if (path === '') return '/';
  return path.startsWith('/') ? path : null;
}

export function corsOptionsForPath(target: string): CorsOptions {
  const routed = routedPathname(target);
  if (routed === null) return NO_CORS;
  let path = routed.toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  if (path === '/.well-known' || path.startsWith('/.well-known/')) return WELL_KNOWN_CORS;
  if (OAUTH_PUBLIC_PATHS.has(path)) return OAUTH_PUBLIC_CORS;
  if (path === '/oauth' || path.startsWith('/oauth/')) return NO_CORS;
  return MCP_CATCH_ALL_CORS;
}

/** For `app.enableCors` in `bootstrap/mcp/main.ts`. */
export const mcpCorsOptions: CorsOptionsDelegate<Request> = (request, callback) =>
  callback(null, corsOptionsForPath(request.originalUrl ?? request.url ?? '/'));
