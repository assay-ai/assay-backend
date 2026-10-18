import { createHmac, timingSafeEqual } from 'node:crypto';

import { OAUTH_PENDING_REQUEST_TTL_SECONDS } from '../constants/oauth.constants';

/**
 * The browser binding of a pending authorization request (spec §6.3.4 step 3,
 * §6.3.5, R-OA-8):
 *
 * ```text
 * __Host-assay_oar = hex(HMAC-SHA256(OAUTH_REQUEST_COOKIE_SECRET, rid))
 * Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600     (MCP host only)
 * ```
 *
 * `/oauth/authorize` sets it; `continue` mints a code only in a browser that
 * holds the value for its `rid`. The cookie holds a MAC, never the `rid`, so
 * it reveals nothing that could bind or approve the request.
 */
export const REQUEST_COOKIE_NAME = '__Host-assay_oar';

const COOKIE_ATTRIBUTES = `Path=/; HttpOnly; Secure; SameSite=Lax`;

export function requestCookieValue(secret: Buffer, rid: string): string {
  return createHmac('sha256', secret).update(rid, 'utf8').digest('hex');
}

/** The `Set-Cookie` header value that binds `rid` to this browser. */
export function setRequestCookie(secret: Buffer, rid: string): string {
  return `${REQUEST_COOKIE_NAME}=${requestCookieValue(secret, rid)}; ${COOKIE_ATTRIBUTES}; Max-Age=${OAUTH_PENDING_REQUEST_TTL_SECONDS}`;
}

/** The `Set-Cookie` header value that removes it. */
export function clearRequestCookie(): string {
  return `${REQUEST_COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/**
 * The value of `__Host-assay_oar` in a `Cookie` header, or `null`. Only the
 * exact name counts; if it appears more than once, the request is refused
 * (`null`) rather than one copy being picked.
 */
export function readRequestCookie(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (typeof raw !== 'string' || raw === '') return null;
  let found: string | null = null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== REQUEST_COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found;
}

/** Whether `presented` is the cookie value of `rid`, compared in constant time. */
export function requestCookieMatches(
  secret: Buffer,
  rid: string,
  presented: string | null,
): boolean {
  if (presented === null || !/^[0-9a-f]{64}$/.test(presented)) return false;
  const expected = Buffer.from(requestCookieValue(secret, rid), 'ascii');
  const actual = Buffer.from(presented, 'ascii');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
