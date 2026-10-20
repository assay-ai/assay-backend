import { domainToASCII } from 'node:url';

import { parse } from 'tldts';

/**
 * The registrable domain (eTLD+1) shown on the consent page (spec §6.3.5,
 * R-OA-25), from the Public Suffix List, both ICANN and private sections, so
 * `foo.github.io` is its own site rather than `github.io`.
 *
 * IDNs come back as punycode (`app.bücher.de` → `xn--bcher-kva.de`), so a
 * look-alike Unicode name is shown as what it really is.
 *
 * `null` for anything that is not a DNS name under a listed public suffix: IP
 * literals, single labels, `localhost`, unlisted or special-use TLDs, a public
 * suffix on its own, a trailing dot, invalid punycode. A CIMD `client_id`
 * whose host has no registrable domain is refused (§6.3.7).
 */
export interface RegistrableDomain {
  /** eTLD+1, lowercase ASCII. */
  readonly registrable: string;
  /** The full host, lowercase ASCII. */
  readonly host: string;
}

const ASCII_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function registrableDomain(host: string): RegistrableDomain | null {
  if (typeof host !== 'string' || host === '' || host.endsWith('.')) return null;
  // domainToASCII would silently cut a port, a path or userinfo off; refuse them instead.
  if (/[\s/\\:@?#[\]%]/.test(host)) return null;
  // domainToASCII lowercases, applies UTS #46 and returns '' when the name is invalid.
  const ascii = domainToASCII(host);
  if (!ascii || !ASCII_HOST_RE.test(ascii)) return null;
  const parsed = parse(ascii, { allowPrivateDomains: true });
  if (parsed.isIp !== false || !parsed.domain) return null;
  if (!parsed.isIcann && !parsed.isPrivate) return null;
  return { registrable: parsed.domain, host: ascii };
}
