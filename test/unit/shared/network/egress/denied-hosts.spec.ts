/**
 * Assay's own hosts are never an outbound target (D20): a provider endpoint or
 * client metadata URL naming one would have the relay call back into our own
 * origin from inside Cloudflare, past the zone's WAF.
 */
import {
  EGRESS_DENIED_HOST_SUFFIXES_ENV,
  EgressFailureKind,
  UNTRUSTED_EGRESS_POLICY,
  deniedHostSuffixes,
  isDeniedHost,
  resolveEgressTarget,
} from '@shared/network/egress';

describe('isDeniedHost', () => {
  it.each([
    'goassay.ai',
    'api.goassay.ai',
    'mcp-dev.goassay.ai',
    'a.b.egress.goassay.ai',
    'API.GOASSAY.AI',
    'goassay.ai.',
    'api.goassay.ai.',
  ])('refuses %s', (host) => {
    expect(isDeniedHost(host)).toBe(true);
  });

  it.each(['notgoassay.ai', 'goassay.ai.example.com', 'goassay.aix', 'example.com', ''])(
    'allows %s',
    (host) => {
      expect(isDeniedHost(host)).toBe(false);
    },
  );

  it('compares the punycode form URL.hostname gives an internationalised name', () => {
    // A Cyrillic "а" in place of the Latin one is another domain, not ours.
    expect(isDeniedHost(new URL('https://api.goаssay.ai/').hostname)).toBe(false);
    expect(isDeniedHost(new URL('https://API.GoAssay.AI./x').hostname)).toBe(true);
  });

  it('reads EGRESS_DENIED_HOST_SUFFIXES, falling back to goassay.ai', () => {
    expect(deniedHostSuffixes({})).toEqual(['goassay.ai']);
    expect(deniedHostSuffixes({ [EGRESS_DENIED_HOST_SUFFIXES_ENV]: ' ' })).toEqual(['goassay.ai']);
    expect(
      deniedHostSuffixes({ [EGRESS_DENIED_HOST_SUFFIXES_ENV]: 'GoAssay.ai., example.org' }),
    ).toEqual(['goassay.ai', 'example.org']);
    expect(isDeniedHost('x.example.org', ['goassay.ai', 'example.org'])).toBe(true);
  });
});

describe('resolveEgressTarget and our own hosts', () => {
  it('refuses one of our hosts before any lookup', async () => {
    const lookup = jest.fn(async () => [{ address: '104.18.24.69', family: 4 }]);

    await expect(
      resolveEgressTarget('https://api.goassay.ai/v1/x', UNTRUSTED_EGRESS_POLICY, lookup),
    ).rejects.toMatchObject({ kind: EgressFailureKind.BLOCKED_ADDRESS });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('still resolves a look-alike that is not ours', async () => {
    const lookup = jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

    await expect(
      resolveEgressTarget('https://goassay.ai.example.com/', UNTRUSTED_EGRESS_POLICY, lookup),
    ).resolves.toMatchObject({ address: '93.184.216.34' });
  });
});
