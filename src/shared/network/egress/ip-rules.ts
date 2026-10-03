/**
 * Which IP addresses this system is allowed to open a socket to.
 *
 * This file is the whole of the SSRF decision, and it is deliberately a pure
 * function over a **resolved address** rather than over a URL string. Every
 * classic SSRF bypass — `http://127.0.0.1.nip.io`, `http://0x7f000001/`,
 * `http://[::ffff:169.254.169.254]/`, a hostname whose A record is `10.0.0.5`,
 * a DNS answer that changes between the check and the connect — is a bypass of
 * *string* matching. None of them survives asking the question after
 * resolution: "is the 32 or 128 bits we are about to `connect(2)` to a public
 * address?"
 *
 * Resolve once, then connect to the resolved address, to close the
 * DNS-rebinding gap between check and connect. That is `resolve-target.ts`'s
 * job; this file supplies the predicate it applies.
 *
 * The list errs toward blocking. A provider whose endpoint lands in the
 * benchmark range gets a rejection they can read and fix. A provider whose
 * endpoint reaches `169.254.169.254` gets our cloud credentials.
 */

import { isIP } from 'node:net';

/** Why an address is refused. Carried into logs and the receipt. */
export enum BlockedAddressReason {
  /** `0.0.0.0/8`, `::` — "this host, this network". */
  UNSPECIFIED = 'UNSPECIFIED',
  /** `127.0.0.0/8`, `::1`. */
  LOOPBACK = 'LOOPBACK',
  /** RFC 1918: `10/8`, `172.16/12`, `192.168/16`. */
  PRIVATE = 'PRIVATE',
  /** RFC 6598 shared address space `100.64/10` — an ISP's, or Alibaba's metadata host. */
  CARRIER_NAT = 'CARRIER_NAT',
  /** `169.254/16`, `fe80::/10`. */
  LINK_LOCAL = 'LINK_LOCAL',
  /**
   * A link-local (or ULA) address that is a known instance-metadata endpoint.
   *
   * Split out from `LINK_LOCAL` purely so that an alert on this reason is an
   * alert on someone deliberately reaching for our cloud credentials, rather
   * than on a provider with a broken DHCP lease.
   */
  CLOUD_METADATA = 'CLOUD_METADATA',
  /** `fc00::/7`. */
  UNIQUE_LOCAL = 'UNIQUE_LOCAL',
  /** `fec0::/10`, deprecated. */
  SITE_LOCAL = 'SITE_LOCAL',
  /** `224/4`, `ff00::/8`. */
  MULTICAST = 'MULTICAST',
  /** `255.255.255.255`. */
  BROADCAST = 'BROADCAST',
  /** `192.0.2/24`, `198.51.100/24`, `203.0.113/24`, `2001:db8::/32`. */
  DOCUMENTATION = 'DOCUMENTATION',
  /** `198.18/15`. */
  BENCHMARK = 'BENCHMARK',
  /** `192.0.0/24` — IETF protocol assignments, which includes Oracle's `192.0.0.192`. */
  PROTOCOL_ASSIGNMENT = 'PROTOCOL_ASSIGNMENT',
  /** `240/4`, Teredo, 6to4, NAT64, discard-only — transition and future-use space. */
  RESERVED = 'RESERVED',
  /** Not an IP address at all. Should be unreachable; treated as blocked, not as allowed. */
  UNPARSEABLE = 'UNPARSEABLE',
}

export interface AllowedAddress {
  readonly allowed: true;
  readonly family: 4 | 6;
}

export interface BlockedAddress {
  readonly allowed: false;
  readonly reason: BlockedAddressReason;
  readonly detail: string;
}

export type AddressVerdict = AllowedAddress | BlockedAddress;

/**
 * Narrow a verdict.
 *
 * A hand-written predicate rather than `if (!verdict.allowed)` because this
 * project compiles with `strictNullChecks: false`, under which TypeScript does
 * not narrow a discriminated union by its boolean discriminant — the check
 * would compile, and `verdict.detail` on the other branch would not. Call sites
 * use this so the compiler stays on the side of the guard.
 */
export function isBlockedVerdict(verdict: AddressVerdict): verdict is BlockedAddress {
  return verdict.allowed === false;
}

/**
 * Instance-metadata endpoints, by exact address.
 *
 * Every one of these is already inside a blocked range, so this table changes
 * no decision — it changes the *reason*, and the reason is what tells an
 * on-call engineer whether they are looking at a misconfiguration or an
 * attack. Keep it that way: never let this table be the only thing blocking an
 * address.
 */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS IMDS, GCP, Azure, DigitalOcean, Oracle
  '169.254.170.2', // AWS ECS task metadata / task IAM role
  '169.254.169.253', // AWS VPC DNS
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud (legacy)
  'fd00:ec2::254', // AWS IMDS over IPv6
]);

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

function parseIpv4(value: string): readonly number[] | null {
  if (isIP(value) !== 4) return null;
  return value.split('.').map((part) => Number(part));
}

function blocked(reason: BlockedAddressReason, detail: string): AddressVerdict {
  return { allowed: false, reason, detail };
}

function classifyIpv4Octets(octets: readonly number[], display: string): AddressVerdict {
  const [a, b, c, d] = octets;

  if (METADATA_ADDRESSES.has(display)) {
    return blocked(BlockedAddressReason.CLOUD_METADATA, `${display} is an instance-metadata host`);
  }

  if (a === 0) return blocked(BlockedAddressReason.UNSPECIFIED, `${display} is in 0.0.0.0/8`);
  if (a === 10) return blocked(BlockedAddressReason.PRIVATE, `${display} is in 10.0.0.0/8`);
  if (a === 127) return blocked(BlockedAddressReason.LOOPBACK, `${display} is in 127.0.0.0/8`);

  if (a === 100 && b >= 64 && b <= 127) {
    return blocked(BlockedAddressReason.CARRIER_NAT, `${display} is in 100.64.0.0/10`);
  }
  if (a === 169 && b === 254) {
    return blocked(BlockedAddressReason.LINK_LOCAL, `${display} is in 169.254.0.0/16`);
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return blocked(BlockedAddressReason.PRIVATE, `${display} is in 172.16.0.0/12`);
  }
  if (a === 192 && b === 168) {
    return blocked(BlockedAddressReason.PRIVATE, `${display} is in 192.168.0.0/16`);
  }
  if (a === 192 && b === 0 && c === 0) {
    return blocked(BlockedAddressReason.PROTOCOL_ASSIGNMENT, `${display} is in 192.0.0.0/24`);
  }
  if (a === 192 && b === 0 && c === 2) {
    return blocked(BlockedAddressReason.DOCUMENTATION, `${display} is in 192.0.2.0/24`);
  }
  if (a === 192 && b === 88 && c === 99) {
    return blocked(BlockedAddressReason.RESERVED, `${display} is in 192.88.99.0/24 (6to4 relay)`);
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return blocked(BlockedAddressReason.BENCHMARK, `${display} is in 198.18.0.0/15`);
  }
  if (a === 198 && b === 51 && c === 100) {
    return blocked(BlockedAddressReason.DOCUMENTATION, `${display} is in 198.51.100.0/24`);
  }
  if (a === 203 && b === 0 && c === 113) {
    return blocked(BlockedAddressReason.DOCUMENTATION, `${display} is in 203.0.113.0/24`);
  }
  if (a >= 224 && a <= 239) {
    return blocked(BlockedAddressReason.MULTICAST, `${display} is in 224.0.0.0/4`);
  }
  if (a === 255 && b === 255 && c === 255 && d === 255) {
    return blocked(BlockedAddressReason.BROADCAST, `${display} is the broadcast address`);
  }
  if (a >= 240) {
    return blocked(BlockedAddressReason.RESERVED, `${display} is in 240.0.0.0/4`);
  }

  return { allowed: true, family: 4 };
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/**
 * Expand an IPv6 literal into its eight 16-bit groups.
 *
 * Written by hand rather than pulled from a package because the parse is the
 * security boundary: a dependency that returns `null` on a form it does not
 * recognise, on a code path that treats `null` as "not blocked", is a silent
 * hole. Here an unparseable value is a *blocked* value — see
 * {@link classifyAddress}.
 */
function parseIpv6(value: string): readonly number[] | null {
  if (isIP(value) !== 6) return null;

  // Node accepts a zone id (`fe80::1%eth0`); the zone is not part of the address.
  const withoutZone = value.split('%')[0];

  const parseGroups = (text: string): number[] | null => {
    if (text === '') return [];
    const out: number[] = [];
    const parts = text.split(':');
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.includes('.')) {
        // A trailing dotted-quad (`::ffff:1.2.3.4`) occupies the last two groups.
        if (i !== parts.length - 1) return null;
        const octets = parseIpv4(part);
        if (!octets) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (part === '' || part.length > 4) return null;
      const group = Number.parseInt(part, 16);
      if (!Number.isInteger(group) || group < 0 || group > 0xffff) return null;
      out.push(group);
    }
    return out;
  };

  const compression = withoutZone.indexOf('::');
  if (compression === -1) {
    const groups = parseGroups(withoutZone);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parseGroups(withoutZone.slice(0, compression));
  const tail = parseGroups(withoutZone.slice(compression + 2));
  if (!head || !tail) return null;

  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;

  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function embeddedIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function classifyIpv6Groups(groups: readonly number[], display: string): AddressVerdict {
  const normalized = display.split('%')[0].toLowerCase();
  if (METADATA_ADDRESSES.has(normalized)) {
    return blocked(BlockedAddressReason.CLOUD_METADATA, `${display} is an instance-metadata host`);
  }

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (leadingZero && g5 === 0 && g6 === 0 && g7 === 0) {
    return blocked(BlockedAddressReason.UNSPECIFIED, `${display} is ::`);
  }
  if (leadingZero && g5 === 0 && g6 === 0 && g7 === 1) {
    return blocked(BlockedAddressReason.LOOPBACK, `${display} is ::1`);
  }

  // IPv4-mapped (`::ffff:a.b.c.d`). The socket this produces is an IPv4 socket,
  // so the IPv4 rules are the ones that must decide.
  if (leadingZero && g5 === 0xffff) {
    return reclassifyEmbedded(embeddedIpv4(g6, g7), display, '::ffff:0:0/96');
  }
  // IPv4-compatible (`::a.b.c.d`), deprecated. Blocked outright: there is no
  // legitimate provider endpoint here, and unwrapping it is a bypass surface.
  if (leadingZero && g5 === 0) {
    return blocked(BlockedAddressReason.RESERVED, `${display} is IPv4-compatible (deprecated)`);
  }
  // IPv4-translated (`::ffff:0:a.b.c.d`, RFC 6145 `::ffff:0:0/96`). One `:0:`
  // away from the mapped form above and easy to miss for exactly that reason —
  // `::ffff:0:a9fe:a9fe` is the metadata address wearing a different hat.
  // Blocked rather than unwrapped: SIIT translation is not something a provider
  // endpoint legitimately arrives as.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return blocked(
      BlockedAddressReason.RESERVED,
      `${display} is in ::ffff:0:0/96 (IPv4-translated)`,
    );
  }
  // NAT64. `64:ff9b::/96` is the well-known prefix; `64:ff9b:1::/48` is the
  // local-use prefix of RFC 8215, which an operator picks freely — so the test
  // is on the first two groups only, and the trailing 32 bits are reclassified
  // either way.
  if (g0 === 0x0064 && g1 === 0xff9b) {
    return reclassifyEmbedded(embeddedIpv4(g6, g7), display, '64:ff9b::/32');
  }
  // 6to4: the IPv4 address is in the next 32 bits.
  if (g0 === 0x2002) {
    const verdict = reclassifyEmbedded(embeddedIpv4(g1, g2), display, '2002::/16');
    if (isBlockedVerdict(verdict)) return verdict;
    return blocked(BlockedAddressReason.RESERVED, `${display} is in 2002::/16 (6to4, deprecated)`);
  }
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return blocked(BlockedAddressReason.RESERVED, `${display} is in 100::/64 (discard-only)`);
  }
  if (g0 === 0x2001 && g1 === 0x0000) {
    return blocked(BlockedAddressReason.RESERVED, `${display} is in 2001::/32 (Teredo)`);
  }
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return blocked(BlockedAddressReason.DOCUMENTATION, `${display} is in 2001:db8::/32`);
  }
  if ((g0 & 0xfe00) === 0xfc00) {
    return blocked(BlockedAddressReason.UNIQUE_LOCAL, `${display} is in fc00::/7`);
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return blocked(BlockedAddressReason.LINK_LOCAL, `${display} is in fe80::/10`);
  }
  if ((g0 & 0xffc0) === 0xfec0) {
    return blocked(BlockedAddressReason.SITE_LOCAL, `${display} is in fec0::/10`);
  }
  if ((g0 & 0xff00) === 0xff00) {
    return blocked(BlockedAddressReason.MULTICAST, `${display} is in ff00::/8`);
  }

  return { allowed: true, family: 6 };
}

function reclassifyEmbedded(ipv4: string, display: string, prefix: string): AddressVerdict {
  const octets = parseIpv4(ipv4);
  if (!octets) {
    return blocked(BlockedAddressReason.UNPARSEABLE, `${display} embeds an unreadable IPv4`);
  }
  const verdict = classifyIpv4Octets(octets, ipv4);
  if (!isBlockedVerdict(verdict)) return verdict;
  return blocked(verdict.reason, `${display} (${prefix}) embeds ${verdict.detail}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decide whether one already-resolved address may be connected to.
 *
 * Anything that is not a parseable, publicly routable unicast address is
 * refused. Note the direction of the default: this returns `allowed: true` only
 * from the bottom of an explicit allow-path. A new address family, a parse this
 * function does not understand, a value that arrived as `undefined` — all land
 * on a `blocked` return, never on a fall-through that permits the connection.
 */
export function classifyAddress(value: string): AddressVerdict {
  if (typeof value !== 'string' || value.length === 0) {
    return blocked(BlockedAddressReason.UNPARSEABLE, 'empty address');
  }

  const family = isIP(value.split('%')[0]);

  if (family === 4) {
    const octets = parseIpv4(value);
    if (!octets)
      return blocked(BlockedAddressReason.UNPARSEABLE, `${value} is not an IPv4 address`);
    return classifyIpv4Octets(octets, value);
  }

  if (family === 6) {
    const groups = parseIpv6(value);
    if (!groups)
      return blocked(BlockedAddressReason.UNPARSEABLE, `${value} is not an IPv6 address`);
    return classifyIpv6Groups(groups, value);
  }

  return blocked(BlockedAddressReason.UNPARSEABLE, `${value} is not an IP address`);
}

/** Convenience predicate for call sites that only need the boolean. */
export function isBlockedAddress(value: string): boolean {
  return isBlockedVerdict(classifyAddress(value));
}
