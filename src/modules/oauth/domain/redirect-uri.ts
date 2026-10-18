/**
 * Redirect URI rules (spec §6.3.9, R-OA-7, R-OA-10).
 *
 * ```text
 * 1. loopback    http://127.0.0.1[:port]{path}   RFC 8252 §7.3: the port is ignored
 *                http://[::1][:port]{path}       against a registered loopback URI;
 *                http://localhost[:port]{path}   host and path compare exactly
 * 2. allowlist   OAUTH_REDIRECT_ALLOWLIST, exact string match, `review: false` only
 * 3. nothing else: no prefix, wildcard, query or fragment
 * ```
 *
 * Every comparison is on the raw string. Nothing is parsed with WHATWG `URL`
 * here, because it rewrites (`/a/../b` → `/b`, `HOST` → `host`, `\` → `/`),
 * and a rewrite is exactly where a mismatch between what was checked and what
 * the browser is sent hides. Loopback URIs are spelled lowercase, with no
 * userinfo, percent-escapes or dot segments; anything else is refused.
 */
export interface RedirectAllowlistEntry {
  readonly uri: string;
  /** `true` while the entry is unconfirmed: it is refused until cleared. */
  readonly review: boolean;
}

export type LoopbackHost = '127.0.0.1' | '[::1]' | 'localhost';

interface Loopback {
  readonly host: LoopbackHost;
  readonly path: string;
}

/**
 * `http://` + one of three exact hosts + an optional canonical port + a path
 * of unreserved characters and `/`. No `?`, `#`, `%`, `@`, `\`, whitespace.
 */
const LOOPBACK_RE =
  /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(?::([1-9][0-9]{0,4}))?(\/[A-Za-z0-9\-._~/]*)?$/;

/** A path segment that is `.` or `..`. */
const DOT_SEGMENT_RE = /(^|\/)\.\.?(\/|$)/;

const MAX_URI_LENGTH = 2048;

function parseLoopback(uri: unknown): Loopback | null {
  if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) return null;
  const m = LOOPBACK_RE.exec(uri);
  if (!m) return null;
  const [, host, port, rawPath] = m;
  if (port !== undefined && Number(port) > 65535) return null;
  const path = rawPath ?? '/';
  if (DOT_SEGMENT_RE.test(path)) return null;
  return { host: host as LoopbackHost, path };
}

/** Schemes an allowlist entry may never use, whatever an operator writes. */
const FORBIDDEN_SCHEMES = new Set([
  'http',
  'javascript',
  'data',
  'file',
  'blob',
  'about',
  'vbscript',
  'filesystem',
  'ftp',
  'ws',
  'wss',
  'mailto',
]);

/** Visible ASCII except the characters that make a URI non-exact. */
const PLAIN_URI_RE = /^[!$&'()+,\-./0-9:;=@A-Z_a-z~]+$/;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):(.+)$/;

/**
 * Whether `uri` may sit in `OAUTH_REDIRECT_ALLOWLIST` (§5.2 boot check):
 * an exact, canonical `https` URL with a DNS host, or a private-use scheme
 * (RFC 8252 §7.1). Loopback URIs are not allowlisted: rule 1 admits them.
 */
export function isValidAllowlistUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) return false;
  if (!PLAIN_URI_RE.test(uri)) return false; // also refuses ?, #, *, %, \, whitespace
  const m = SCHEME_RE.exec(uri);
  if (!m) return false;
  const [, scheme, rest] = m;
  if (FORBIDDEN_SCHEMES.has(scheme)) return false;
  if (scheme === 'https') return isCanonicalHttpsUrl(uri);
  // Private-use scheme: something after the colon that is a path, not just a scheme.
  return rest.length > 1 && rest.startsWith('/') && !DOT_SEGMENT_RE.test(rest.replace(/^\/+/, ''));
}

function isCanonicalHttpsUrl(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.href === uri &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.pathname !== '/' &&
    /[a-z]/.test(url.hostname) &&
    !url.hostname.startsWith('[') &&
    !/^[0-9.]+$/.test(url.hostname)
  );
}

function allowlisted(uri: string, allowlist: readonly RedirectAllowlistEntry[]): boolean {
  if (!isValidAllowlistUri(uri)) return false;
  return allowlist.some((entry) => entry.review === false && entry.uri === uri);
}

/**
 * Whether a client may register `uri` (DCR `redirect_uris`, CIMD document):
 * a loopback URI under rule 1, or an allowlisted entry with `review: false`.
 */
export function registrable(uri: string, allowlist: readonly RedirectAllowlistEntry[]): boolean {
  if (typeof uri !== 'string') return false;
  return parseLoopback(uri) !== null || allowlisted(uri, allowlist);
}

/**
 * Whether `/oauth/authorize` may redirect to `requested` for a client that
 * registered `registered`. A loopback request matches a registered loopback URI
 * of the same host and path, any port; anything else must be registered byte
 * for byte and allowlisted (re-checked now, so clearing a review or removing
 * an entry takes effect for clients registered earlier).
 */
export function matches(
  registered: readonly string[],
  requested: string,
  allowlist: readonly RedirectAllowlistEntry[],
): boolean {
  if (typeof requested !== 'string' || !Array.isArray(registered)) return false;
  const loopback = parseLoopback(requested);
  if (loopback) {
    return registered.some((candidate) => {
      const reg = parseLoopback(candidate);
      return reg !== null && reg.host === loopback.host && reg.path === loopback.path;
    });
  }
  return (
    allowlisted(requested, allowlist) && registered.some((candidate) => candidate === requested)
  );
}
