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
  // Not every Node release refuses a malformed `xn--` label in domainToASCII,
  // so each one is decoded here as well.
  if (!ascii.split('.').every(validPunycodeLabel)) return null;
  const parsed = parse(ascii, { allowPrivateDomains: true });
  if (parsed.isIp !== false || !parsed.domain) return null;
  if (!parsed.isIcann && !parsed.isPrivate) return null;
  return { registrable: parsed.domain, host: ascii };
}

/**
 * An `xn--` label must decode as RFC 3492 punycode to at least one non-ASCII
 * code point; any other label passes. `xn--zz` (no valid digits) and
 * `xn--abc-` (decodes to plain ASCII) are both refused.
 */
function validPunycodeLabel(label: string): boolean {
  if (!label.startsWith('xn--')) return true;
  const decoded = decodePunycode(label.slice(4));
  return decoded !== null && [...decoded].some((c) => c.codePointAt(0)! > 0x7f);
}

/** RFC 3492 decoder; `null` on any malformed input. */
function decodePunycode(input: string): string | null {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const digit = (c: number): number =>
    c >= 0x30 && c <= 0x39 ? c - 22 : c >= 0x61 && c <= 0x7a ? c - 0x61 : base;
  const adapt = (delta: number, points: number, first: boolean): number => {
    let d = first ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };

  const cut = input.lastIndexOf('-');
  const output = cut > 0 ? Array.from(input.slice(0, cut), (c) => c.codePointAt(0)!) : [];
  let i = 0;
  let n = 0x80;
  let bias = 72;
  for (let pos = cut > 0 ? cut + 1 : 0; pos < input.length; ) {
    const oldI = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (pos >= input.length) return null;
      const d = digit(input.charCodeAt(pos++));
      if (d >= base) return null;
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      w *= base - t;
      if (i > 0x7fffffff || w > 0x7fffffff) return null;
    }
    bias = adapt(i - oldI, output.length + 1, oldI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}
