/**
 * The address blocklist, exhaustively.
 *
 * `classifyAddress` is the whole SSRF decision reduced to a pure function, so
 * it is the one piece here that can be tested to the edge of every range
 * without a socket. Two things are asserted per range and both matter: that the
 * address is refused, and *why* — the reason is what an on-call engineer reads,
 * and `CLOUD_METADATA` versus `LINK_LOCAL` is the difference between "someone
 * fat-fingered a URL" and "someone is fishing for our IAM credentials".
 *
 * The allow cases at the bottom are not filler. A blocklist that refuses
 * everything passes every deny test and ships a platform that can call no
 * provider at all.
 */
import { BlockedAddressReason, classifyAddress } from '@shared/network/egress';

describe('classifyAddress — IPv4', () => {
  const blocked: ReadonlyArray<[string, BlockedAddressReason]> = [
    // Loopback, the canonical case and the whole /8, not just .0.1.
    ['127.0.0.1', BlockedAddressReason.LOOPBACK],
    ['127.1.2.3', BlockedAddressReason.LOOPBACK],
    ['127.255.255.254', BlockedAddressReason.LOOPBACK],

    // Cloud instance metadata. Named separately from the link-local range it
    // sits in — see the file header.
    ['169.254.169.254', BlockedAddressReason.CLOUD_METADATA],
    ['169.254.170.2', BlockedAddressReason.CLOUD_METADATA],
    ['169.254.169.253', BlockedAddressReason.CLOUD_METADATA],
    ['100.100.100.200', BlockedAddressReason.CLOUD_METADATA],
    ['192.0.0.192', BlockedAddressReason.CLOUD_METADATA],

    // The rest of link-local, so the block does not depend on the metadata table.
    ['169.254.0.1', BlockedAddressReason.LINK_LOCAL],
    ['169.254.255.255', BlockedAddressReason.LINK_LOCAL],

    // RFC 1918, including both edges of the awkward /12.
    ['10.0.0.0', BlockedAddressReason.PRIVATE],
    ['10.255.255.255', BlockedAddressReason.PRIVATE],
    ['172.16.0.0', BlockedAddressReason.PRIVATE],
    ['172.20.10.1', BlockedAddressReason.PRIVATE],
    ['172.31.255.255', BlockedAddressReason.PRIVATE],
    ['192.168.0.1', BlockedAddressReason.PRIVATE],
    ['192.168.255.255', BlockedAddressReason.PRIVATE],

    ['0.0.0.0', BlockedAddressReason.UNSPECIFIED],
    ['0.1.2.3', BlockedAddressReason.UNSPECIFIED],
    ['100.64.0.1', BlockedAddressReason.CARRIER_NAT],
    ['100.127.255.255', BlockedAddressReason.CARRIER_NAT],
    ['192.0.0.1', BlockedAddressReason.PROTOCOL_ASSIGNMENT],
    ['192.0.2.5', BlockedAddressReason.DOCUMENTATION],
    ['198.51.100.5', BlockedAddressReason.DOCUMENTATION],
    ['203.0.113.5', BlockedAddressReason.DOCUMENTATION],
    ['198.18.0.1', BlockedAddressReason.BENCHMARK],
    ['198.19.255.255', BlockedAddressReason.BENCHMARK],
    ['192.88.99.1', BlockedAddressReason.RESERVED],
    ['224.0.0.1', BlockedAddressReason.MULTICAST],
    ['239.255.255.255', BlockedAddressReason.MULTICAST],
    ['240.0.0.1', BlockedAddressReason.RESERVED],
    ['255.255.255.255', BlockedAddressReason.BROADCAST],
  ];

  it.each(blocked)('blocks %s as %s', (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason });
  });

  it.each([
    // The addresses immediately outside each range. These are the assertions
    // that catch an off-by-one in a mask, which is the failure mode that turns
    // a blocklist into an outage.
    ['9.255.255.255'],
    ['11.0.0.1'],
    ['100.63.255.255'],
    ['100.128.0.1'],
    ['169.253.255.255'],
    ['169.255.0.1'],
    ['172.15.255.255'],
    ['172.32.0.1'],
    ['192.167.255.255'],
    ['192.169.0.1'],
    ['198.17.255.255'],
    ['198.20.0.1'],
    ['223.255.255.255'],
    ['1.1.1.1'],
    ['8.8.8.8'],
    ['93.184.216.34'],
  ])('allows the public address %s', (address) => {
    expect(classifyAddress(address)).toEqual({ allowed: true, family: 4 });
  });
});

describe('classifyAddress — IPv6', () => {
  const blocked: ReadonlyArray<[string, BlockedAddressReason]> = [
    ['::1', BlockedAddressReason.LOOPBACK],
    ['0:0:0:0:0:0:0:1', BlockedAddressReason.LOOPBACK],
    ['::', BlockedAddressReason.UNSPECIFIED],

    // IPv4-mapped. The socket is an IPv4 socket, so the IPv4 rules decide —
    // this is the `http://[::ffff:169.254.169.254]/` bypass.
    ['::ffff:127.0.0.1', BlockedAddressReason.LOOPBACK],
    ['::ffff:169.254.169.254', BlockedAddressReason.CLOUD_METADATA],
    ['::ffff:10.0.0.5', BlockedAddressReason.PRIVATE],
    ['::ffff:192.168.1.1', BlockedAddressReason.PRIVATE],

    // NAT64 and 6to4 embed an IPv4 address in the middle of a v6 one.
    ['64:ff9b::10.0.0.5', BlockedAddressReason.PRIVATE],
    ['64:ff9b::169.254.169.254', BlockedAddressReason.CLOUD_METADATA],
    ['2002:a00:1::1', BlockedAddressReason.PRIVATE],
    ['2002:0808:0808::1', BlockedAddressReason.RESERVED],

    ['fc00::1', BlockedAddressReason.UNIQUE_LOCAL],
    ['fd00::1', BlockedAddressReason.UNIQUE_LOCAL],
    ['fdff:ffff::1', BlockedAddressReason.UNIQUE_LOCAL],
    ['fd00:ec2::254', BlockedAddressReason.CLOUD_METADATA],

    ['fe80::1', BlockedAddressReason.LINK_LOCAL],
    ['fe80::a9fe:a9fe', BlockedAddressReason.LINK_LOCAL],
    ['febf::1', BlockedAddressReason.LINK_LOCAL],
    ['fec0::1', BlockedAddressReason.SITE_LOCAL],
    ['ff02::1', BlockedAddressReason.MULTICAST],
    ['ff00::', BlockedAddressReason.MULTICAST],

    // IPv4-translated (`::ffff:0:0/96`) — one `:0:` away from the mapped form
    // and a real gap in the first version of these rules, found by an
    // adversarial review. `::ffff:0:a9fe:a9fe` is the metadata address.
    ['::ffff:0:a9fe:a9fe', BlockedAddressReason.RESERVED],
    ['::ffff:0:7f00:1', BlockedAddressReason.RESERVED],

    // NAT64 local-use prefix (RFC 8215). The operator picks the bits after
    // `64:ff9b`, so testing the well-known `/96` alone let these through.
    ['64:ff9b:1::a9fe:a9fe', BlockedAddressReason.CLOUD_METADATA],
    ['64:ff9b:1::7f00:1', BlockedAddressReason.LOOPBACK],

    ['2001:db8::1', BlockedAddressReason.DOCUMENTATION],
    ['2001::1', BlockedAddressReason.RESERVED],
    ['100::1', BlockedAddressReason.RESERVED],
    ['::127.0.0.1', BlockedAddressReason.RESERVED],
  ];

  it.each(blocked)('blocks %s as %s', (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason });
  });

  it.each([['2606:4700:4700::1111'], ['2a00:1450:4001:800::200e'], ['2001:4860:4860::8888']])(
    'allows the public address %s',
    (address) => {
      expect(classifyAddress(address)).toEqual({ allowed: true, family: 6 });
    },
  );

  it('ignores a zone id when deciding', () => {
    expect(classifyAddress('fe80::1%eth0')).toMatchObject({
      allowed: false,
      reason: BlockedAddressReason.LINK_LOCAL,
    });
  });
});

describe('classifyAddress — anything that is not an address', () => {
  /**
   * The default direction of the function. Every one of these is a value that
   * could reach the guard through a bug, a hand-written config, or a resolver
   * returning something unexpected — and every one has to land on *blocked*.
   * A guard whose unknown case is "allow" is not a guard.
   */
  it.each([
    [''],
    ['localhost'],
    ['127.0.0.1.nip.io'],
    ['0x7f000001'],
    ['2130706433'],
    ['127.0.0.1:8080'],
    ['::ffff:'],
    ['not an address'],
    [null as unknown as string],
    [undefined as unknown as string],
  ])('blocks %p as unparseable', (value) => {
    const verdict = classifyAddress(value);
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason: BlockedAddressReason.UNPARSEABLE });
  });
});
