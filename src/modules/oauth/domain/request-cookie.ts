import { createHmac, timingSafeEqual } from 'node:crypto';

import { OAUTH_PENDING_REQUEST_TTL_SECONDS } from '../constants/oauth.constants';

/**
 * The browser binding of a pending authorization request (spec §6.3.4 step 3,
 * §6.3.5, R-OA-8). One cookie per request, so several sign-ins started
 * together in one browser do not overwrite each other:
 *
 * ```text
 * mac   = hex(HMAC-SHA256(OAUTH_REQUEST_COOKIE_SECRET, rid))
 * name  = __Host-assay_oar_{mac[0..16]}
 * value = {issued at, unix seconds, base 36}.{mac}
 * Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600     (MCP host only)
 * ```
 *
 * `/oauth/authorize` sets it; `continue` mints a code only in a browser that
 * holds the cookie of its `rid`. Name and value hold a MAC, never the `rid`.
 * The issue time is not authenticated: it only orders this browser's own
 * cookies when the oldest must go (a `__Host-` cookie cannot be set by any
 * other host).
 *
 * A browser keeps at most {@link MAX_REQUEST_COOKIES}: setting one more
 * expires the oldest.
 */
export const REQUEST_COOKIE_PREFIX = '__Host-assay_oar_';

/** Pending sign-ins one browser can hold at once; the oldest beyond this is expired. */
export const MAX_REQUEST_COOKIES = 5;

const COOKIE_ATTRIBUTES = `Path=/; HttpOnly; Secure; SameSite=Lax`;
const NAME_HEX_LENGTH = 16;
const VALUE_RE = /^([0-9a-z]{1,11})\.([0-9a-f]{64})$/;
/** The exact name of a binding cookie; nothing else is ever evicted. */
const NAME_RE = new RegExp(`^${REQUEST_COOKIE_PREFIX}[0-9a-f]{${NAME_HEX_LENGTH}}$`);

function mac(secret: Buffer, rid: string): string {
  return createHmac('sha256', secret).update(rid, 'utf8').digest('hex');
}

/** The cookie name of `rid`'s binding. */
export function requestCookieName(secret: Buffer, rid: string): string {
  return `${REQUEST_COOKIE_PREFIX}${mac(secret, rid).slice(0, NAME_HEX_LENGTH)}`;
}

/** The cookie value of `rid`'s binding, issued at `nowMs`. */
export function requestCookieValue(
  secret: Buffer,
  rid: string,
  nowMs: number = Date.now(),
): string {
  return `${Math.floor(nowMs / 1000).toString(36)}.${mac(secret, rid)}`;
}

/** The `Set-Cookie` header value that binds `rid` to this browser. */
export function setRequestCookie(secret: Buffer, rid: string, nowMs: number = Date.now()): string {
  return (
    `${requestCookieName(secret, rid)}=${requestCookieValue(secret, rid, nowMs)}; ` +
    `${COOKIE_ATTRIBUTES}; Max-Age=${OAUTH_PENDING_REQUEST_TTL_SECONDS}`
  );
}

/** The `Set-Cookie` header value that removes the cookie called `name`. */
export function clearRequestCookie(name: string): string {
  return `${name}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/** Every `name=value` pair of a `Cookie` header, in order. */
function pairs(header: string | string[] | undefined): Array<[string, string]> {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (typeof raw !== 'string' || raw === '') return [];
  const out: Array<[string, string]> = [];
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return out;
}

/**
 * The value of the cookie called `name`, or `null`. If it appears more than
 * once, the request is refused (`null`) rather than one copy being picked.
 */
export function readCookie(header: string | string[] | undefined, name: string): string | null {
  let found: string | null = null;
  for (const [key, value] of pairs(header)) {
    if (key !== name) continue;
    if (found !== null) return null;
    found = value;
  }
  return found;
}

/** Whether `presented` is the cookie value of `rid`, the MAC compared in constant time. */
export function requestCookieMatches(
  secret: Buffer,
  rid: string,
  presented: string | null,
): boolean {
  const parsed = presented === null ? null : VALUE_RE.exec(presented);
  if (!parsed) return false;
  const expected = Buffer.from(mac(secret, rid), 'ascii');
  const actual = Buffer.from(parsed[2], 'ascii');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The binding cookies to expire so that, with one more set, the browser holds
 * at most {@link MAX_REQUEST_COOKIES}: the oldest by issue time. A cookie
 * whose issue time cannot be read counts as the oldest. Only a name of the
 * exact binding format (`__Host-assay_oar_` and 16 lower-case hex digits)
 * counts, so a name sent in the `Cookie` header is never echoed into a
 * `Set-Cookie` unless it is one this server could have set.
 */
export function requestCookiesToEvict(header: string | string[] | undefined): string[] {
  const held = new Map<string, number>();
  for (const [name, value] of pairs(header)) {
    if (!NAME_RE.test(name)) continue;
    const parsed = VALUE_RE.exec(value);
    const issued = parsed ? parseInt(parsed[1], 36) : -1;
    held.set(name, Math.min(held.get(name) ?? Infinity, issued));
  }
  const excess = held.size + 1 - MAX_REQUEST_COOKIES;
  if (excess <= 0) return [];
  return [...held.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, excess)
    .map(([name]) => name);
}
