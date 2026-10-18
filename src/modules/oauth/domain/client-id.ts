import { registrableDomain } from './registrable-domain';

/**
 * What kind of OAuth client a `client_id` names (spec §6.3.6, §6.3.7).
 *
 * ```text
 * BUILTIN  {MCP}/oauth/clients/assay-mcp, byte for byte; resolved in process
 * DCR      ^dcr_[A-Za-z0-9_-]{22}$
 * CIMD     https; no userinfo; no fragment; port absent or 443; DNS host with a
 *          public registrable domain, not an IP literal; path not `/`; ≤ 512
 *          chars; spelled canonically. Under `allowHttpLoopback` (e2e only),
 *          `http://localhost[:port]/…` too.
 * UNKNOWN  anything else
 * ```
 *
 * "Canonically" means the string is what WHATWG `URL` would serialise it to
 * (lowercase host, no dot segments, punycode, no `\`). The document must carry
 * the same `client_id` byte for byte, so a spelling the fetch would rewrite is
 * refused rather than normalised.
 *
 * No other URL on the MCP origin is a CIMD document: we never fetch ourselves.
 */
export type ClientKind = 'BUILTIN' | 'CIMD' | 'DCR' | 'UNKNOWN';

export interface ClassifyOptions {
  readonly mcpPublicUrl: string;
  /** `OAUTH_ALLOW_HTTP_CIMD_LOOPBACK`; refused in production at boot. */
  readonly allowHttpLoopback: boolean;
}

export const BUILTIN_CLIENT_PATH = '/oauth/clients/assay-mcp';
export const CIMD_MAX_LENGTH = 512;
const DCR_RE = /^dcr_[A-Za-z0-9_-]{22}$/;

export function builtinClientId(mcpPublicUrl: string): string {
  return `${mcpPublicUrl}${BUILTIN_CLIENT_PATH}`;
}

export function classify(clientId: string, options: ClassifyOptions): { kind: ClientKind } {
  if (typeof clientId !== 'string') return { kind: 'UNKNOWN' };
  if (clientId === builtinClientId(options.mcpPublicUrl)) return { kind: 'BUILTIN' };
  if (DCR_RE.test(clientId)) return { kind: 'DCR' };
  if (isCimdUrl(clientId, options)) return { kind: 'CIMD' };
  return { kind: 'UNKNOWN' };
}

function isCimdUrl(raw: string, options: ClassifyOptions): boolean {
  if (raw.length > CIMD_MAX_LENGTH) return false;
  // Raw checks before parsing: WHATWG drops an empty fragment and rewrites `\`.
  if (raw.includes('#') || raw.includes('\\') || /[\s\p{Cc}]/u.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // An empty userinfo (`https://@x.com/c`) is dropped by WHATWG; the canonical check refuses it.
  if (url.username !== '' || url.password !== '') return false;
  if (url.pathname === '/' || url.hash !== '') return false;
  if (!isCanonical(raw, url)) return false;
  if (sameOrigin(url, options.mcpPublicUrl)) return false;

  if (url.protocol === 'https:') {
    // WHATWG serialises :443 as no port; any other port survives.
    if (url.port !== '') return false;
    const domain = registrableDomain(url.hostname);
    return domain !== null && domain.host === url.hostname;
  }
  return (
    options.allowHttpLoopback === true && url.protocol === 'http:' && url.hostname === 'localhost'
  );
}

/** `raw` is the serialisation of `url`, allowing an explicit `:443` on https. */
function isCanonical(raw: string, url: URL): boolean {
  if (raw === url.href) return true;
  if (url.protocol !== 'https:') return false;
  return raw === `https://${url.hostname}:443${url.pathname}${url.search}`;
}

function sameOrigin(url: URL, mcpPublicUrl: string): boolean {
  try {
    return url.origin === new URL(mcpPublicUrl).origin;
  } catch {
    return false;
  }
}
