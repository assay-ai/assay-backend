import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Route-scoped CORS for the API service.
 *
 * Two policies, chosen per request:
 *
 * - **Public reads** (`GET`/`HEAD` under `/api/v1/public/`, and the preflight
 *   for one): `Access-Control-Allow-Origin: *`, never
 *   `Access-Control-Allow-Credentials`, only `GET`/`HEAD`/`OPTIONS`. These
 *   responses are the same for every caller and are cacheable at the CDN
 *   (`CDN-Cache-Control: public`). Cloudflare does not key its cache on
 *   `Vary: Origin`, so an origin-reflecting policy would let whichever request
 *   fills the cache first (a bot with no `Origin`, a foreign site) decide the
 *   CORS header every visitor gets until the entry expires. A fixed `*` is the
 *   same for everyone, so the cached copy is always right.
 *
 *   `*` without credentials cannot be used to act as a signed-in user: the
 *   browser refuses to expose a credentialed (cookie) response that carries
 *   `*`, and a site that does not hold the user's bearer token has nothing to
 *   put in `Authorization`. `Authorization` is still listed in the allowed
 *   headers only because the dashboard's API client attaches it to every call
 *   when signed in; the public handlers ignore it.
 *
 * - **Everything else**, including writes under `/public/` such as
 *   `POST /public/demo/run`: the `CORS_ALLOWED_ORIGINS` allowlist with
 *   credentials, as before (R17-R-02).
 *
 * The public test is deliberately narrow: an exact `/api/v1/public/` prefix
 * (case-sensitive, so it can only be narrower than Express's case-insensitive
 * routing), no dot segments or encoded slashes/dots, and a safe method. Any
 * request that fails it gets the stricter allowlist policy.
 */
export const PUBLIC_READ_PATH_PREFIX = '/api/v1/public/';

const PUBLIC_READ_METHODS = new Set(['GET', 'HEAD']);

/** Response headers a browser client of either policy may read. */
const SHARED_EXPOSED_HEADERS = ['Retry-After'];

export const API_EXPOSED_HEADERS: readonly string[] = [
  'Content-Disposition',
  'X-Assay-Export-Total-Matching',
  'X-Assay-Export-Row-Count',
  'X-Assay-Export-Truncated',
  ...SHARED_EXPOSED_HEADERS,
];

export const PUBLIC_READ_CORS_OPTIONS: Readonly<CorsOptions> = Object.freeze({
  origin: '*',
  credentials: false,
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Accept', 'Authorization', 'Cache-Control', 'Content-Type'],
  exposedHeaders: [...SHARED_EXPOSED_HEADERS],
  maxAge: 600,
});

interface CorsRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
}

function pathnameOf(req: CorsRequestLike): string | null {
  const raw = req.originalUrl ?? req.url;
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const queryAt = raw.search(/[?#]/);
  return queryAt === -1 ? raw : raw.slice(0, queryAt);
}

/** True when the request is a read of a public, CDN-cacheable route. */
export function isPublicReadRequest(req: CorsRequestLike): boolean {
  const path = pathnameOf(req);
  if (path === null || !path.startsWith(PUBLIC_READ_PATH_PREFIX)) return false;
  // No dot segments, no encoded '/', '.' or '\', no backslashes, no '//'.
  if (/(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c|\\|\/\//i.test(path)) return false;

  const method = (req.method ?? '').toUpperCase();
  if (PUBLIC_READ_METHODS.has(method)) return true;
  if (method !== 'OPTIONS') return false;
  const requested = req.headers?.['access-control-request-method'];
  const value = Array.isArray(requested) ? requested[0] : requested;
  return typeof value === 'string' && PUBLIC_READ_METHODS.has(value.trim().toUpperCase());
}

/** The allowlist policy for every non-public request. */
export function allowlistCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  return {
    origin: [...allowedOrigins],
    credentials: true,
    exposedHeaders: [...API_EXPOSED_HEADERS],
  };
}

export function buildApiCorsOptionsDelegate(
  allowedOrigins: readonly string[],
): CorsOptionsDelegate<CorsRequestLike> {
  const allowlist = allowlistCorsOptions(allowedOrigins);
  return (req, callback) => {
    callback(null, isPublicReadRequest(req) ? { ...PUBLIC_READ_CORS_OPTIONS } : allowlist);
  };
}
