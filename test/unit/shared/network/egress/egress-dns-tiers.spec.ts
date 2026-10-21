import * as http from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';

import {
  EGRESS_CONFIG_HOSTS,
  EGRESS_DNS_LOOKUP,
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
  INTERNAL_EGRESS_POLICY,
  UNTRUSTED_EGRESS_POLICY,
  configOriginEgressHosts,
  dnsServersLookup,
  parseDnsServers,
  resolveEgressTarget,
} from '@shared/network/egress';
import {
  LAST_GOOD_DNS_MAX_AGE_MS,
  LastGoodDnsAnswers,
} from '@shared/network/egress/resolve-target';
import { NetworkModule, singleLabelConfigHosts } from '@shared/network/network.module';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

/**
 * Egress DNS trust tiers (BUG-X-04, lot 1 B7).
 *
 * A host the server's own configuration names (chain RPC, facilitator, Kora),
 * called under INTERNAL_ALLOWED, may reuse its last checked answer also on
 * ENOTFOUND, for at most 10 minutes. Every other host keeps the strict rule:
 * ENOTFOUND fails at once. A cached answer is never served across trust
 * levels and the address check runs on every reuse.
 */
const PUBLIC: LookupAddress = { address: '93.184.216.34', family: 4 };
const PRIVATE: LookupAddress = { address: '10.0.0.5', family: 4 };

const RPC_HOST = 'rpc.chain.example.test';
const RPC_URL = `https://${RPC_HOST}/`;
const PROVIDER_URL = 'https://api.provider.example.test/v1';

function dnsError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ${code} host`);
  error.code = code;
  return error;
}

function scripted(...answers: Array<LookupAddress[] | Error>) {
  let call = 0;
  return jest.fn(async (_hostname: string) => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

async function refusal(promise: Promise<unknown>): Promise<EgressError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressError);
    return error as EgressError;
  }
  throw new Error('expected a refusal');
}

describe('resolveEgressTarget — config tier vs strict tier', () => {
  let now: number;
  let cache: LastGoodDnsAnswers;
  const configHosts: ReadonlySet<string> = new Set([RPC_HOST]);

  beforeEach(() => {
    now = 5_000_000;
    cache = new LastGoodDnsAnswers(LAST_GOOD_DNS_MAX_AGE_MS, () => now);
  });

  it('config RPC host, ENOTFOUND: retries once, then reuses the checked answer within 10 min', async () => {
    await resolveEgressTarget(
      RPC_URL,
      INTERNAL_EGRESS_POLICY,
      scripted([PUBLIC]),
      cache,
      configHosts,
    );
    now += 9 * 60 * 1000;

    const failing = scripted(dnsError('ENOTFOUND'));
    const target = await resolveEgressTarget(
      RPC_URL,
      INTERNAL_EGRESS_POLICY,
      failing,
      cache,
      configHosts,
    );
    expect(target.address).toBe(PUBLIC.address);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('config RPC host, ENOTFOUND: DNS_FAILED once the answer is older than 10 min', async () => {
    await resolveEgressTarget(
      RPC_URL,
      INTERNAL_EGRESS_POLICY,
      scripted([PUBLIC]),
      cache,
      configHosts,
    );
    now += LAST_GOOD_DNS_MAX_AGE_MS + 1;

    const error = await refusal(
      resolveEgressTarget(
        RPC_URL,
        INTERNAL_EGRESS_POLICY,
        scripted(dnsError('ENOTFOUND')),
        cache,
        configHosts,
      ),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('config RPC host, ENOTFOUND, never resolved before: DNS_FAILED', async () => {
    const error = await refusal(
      resolveEgressTarget(
        RPC_URL,
        INTERNAL_EGRESS_POLICY,
        scripted(dnsError('ENOTFOUND')),
        cache,
        configHosts,
      ),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('matches the config host case-insensitively', async () => {
    const url = `https://${RPC_HOST.toUpperCase()}/`;
    await resolveEgressTarget(url, INTERNAL_EGRESS_POLICY, scripted([PUBLIC]), cache, configHosts);
    const target = await resolveEgressTarget(
      url,
      INTERNAL_EGRESS_POLICY,
      scripted(dnsError('ENOTFOUND')),
      cache,
      configHosts,
    );
    expect(target.address).toBe(PUBLIC.address);
  });

  it('provider host, ENOTFOUND: no retry and no reuse', async () => {
    await resolveEgressTarget(
      PROVIDER_URL,
      UNTRUSTED_EGRESS_POLICY,
      scripted([PUBLIC]),
      cache,
      configHosts,
    );
    const lookup = scripted(dnsError('ENOTFOUND'));
    const error = await refusal(
      resolveEgressTarget(PROVIDER_URL, UNTRUSTED_EGRESS_POLICY, lookup, cache, configHosts),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a provider URL on a config host is still strict (the tier needs INTERNAL_ALLOWED too)', async () => {
    await resolveEgressTarget(
      RPC_URL,
      UNTRUSTED_EGRESS_POLICY,
      scripted([PUBLIC]),
      cache,
      configHosts,
    );
    const lookup = scripted(dnsError('ENOTFOUND'));
    const error = await refusal(
      resolveEgressTarget(RPC_URL, UNTRUSTED_EGRESS_POLICY, lookup, cache, configHosts),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('an INTERNAL_ALLOWED host that is not in the config list is strict', async () => {
    const url = 'http://localhost:4100/client.json';
    await resolveEgressTarget(url, INTERNAL_EGRESS_POLICY, scripted([PUBLIC]), cache, configHosts);
    const error = await refusal(
      resolveEgressTarget(
        url,
        INTERNAL_EGRESS_POLICY,
        scripted(dnsError('ENOTFOUND')),
        cache,
        configHosts,
      ),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('without a config list nothing is on the config tier', async () => {
    await resolveEgressTarget(RPC_URL, INTERNAL_EGRESS_POLICY, scripted([PUBLIC]), cache);
    const error = await refusal(
      resolveEgressTarget(RPC_URL, INTERNAL_EGRESS_POLICY, scripted(dnsError('ENOTFOUND')), cache),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('private address never: a config host’s private answer is never served to a public-only hop', async () => {
    // The operator's own node on a private address, allowed under INTERNAL_ALLOWED.
    await resolveEgressTarget(
      RPC_URL,
      INTERNAL_EGRESS_POLICY,
      scripted([PRIVATE]),
      cache,
      configHosts,
    );

    // A redirect hop is PUBLIC_ONLY (hopPolicy): neither ENOTFOUND nor a
    // transient code may hand it the stored private address.
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      const error = await refusal(
        resolveEgressTarget(
          RPC_URL,
          UNTRUSTED_EGRESS_POLICY,
          scripted(dnsError(code)),
          cache,
          configHosts,
        ),
      );
      expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
    }
  });

  it('private address never: a public-only reuse of a private entry is refused by the guard', async () => {
    cache.remember(`${UNTRUSTED_EGRESS_POLICY.trust}|${RPC_HOST}`, [PRIVATE]);
    const error = await refusal(
      resolveEgressTarget(
        RPC_URL,
        UNTRUSTED_EGRESS_POLICY,
        scripted(dnsError('EAI_AGAIN')),
        cache,
        configHosts,
      ),
    );
    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
  });

  it('private address never: a fresh private answer for a public-only call is refused, config host or not', async () => {
    await resolveEgressTarget(
      RPC_URL,
      UNTRUSTED_EGRESS_POLICY,
      scripted([PUBLIC]),
      cache,
      configHosts,
    );
    const error = await refusal(
      resolveEgressTarget(
        RPC_URL,
        UNTRUSTED_EGRESS_POLICY,
        scripted([PRIVATE]),
        cache,
        configHosts,
      ),
    );
    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
  });
});

describe('configOriginEgressHosts', () => {
  function from(env: Record<string, string>) {
    return configOriginEgressHosts((name) => env[name]);
  }

  it('takes the hosts of EVM_RPC_URLS, FACILITATOR_URL and KORA_RPC_URL', () => {
    const hosts = from({
      EVM_RPC_URLS: JSON.stringify({
        'eip155:46630': 'https://RPC.Testnet.Example.test/key',
        'eip155:84532': 'https://sepolia.example.test',
      }),
      FACILITATOR_URL: 'https://facilitator.internal.example.test:3100',
      KORA_RPC_URL: 'http://kora.internal.example.test:8080',
    });
    expect([...hosts].sort()).toEqual([
      'facilitator.internal.example.test',
      'kora.internal.example.test',
      'rpc.testnet.example.test',
      'sepolia.example.test',
    ]);
  });

  it('skips IP literals, malformed values and other schemes', () => {
    const hosts = from({
      EVM_RPC_URLS: '{not json',
      FACILITATOR_URL: 'http://127.0.0.1:3100',
      KORA_RPC_URL: 'ftp://kora.example.test',
    });
    expect(hosts.size).toBe(0);
  });

  it('leaves loopback names out (review M-2)', () => {
    const hosts = from({
      FACILITATOR_URL: 'http://localhost:3100',
      KORA_RPC_URL: 'http://kora.localhost:8080',
    });
    expect(hosts.size).toBe(0);
  });

  it('reads no other variable (a provider or alert URL never becomes a config host)', () => {
    const hosts = from({
      ALERT_WEBHOOK_URL: 'https://hooks.example.test/x',
      PUBLIC_RPC_URLS: JSON.stringify({ 'eip155:1': 'https://browser-rpc.example.test' }),
    });
    expect(hosts.size).toBe(0);
  });
});

describe('DNS_SERVERS', () => {
  it('parses a list of IP addresses with optional ports', () => {
    expect(parseDnsServers(undefined)).toBeNull();
    expect(parseDnsServers('  ')).toBeNull();
    expect(parseDnsServers('1.1.1.1, 8.8.8.8:53 [2606:4700:4700::1111]:53,::1')).toEqual([
      '1.1.1.1',
      '8.8.8.8:53',
      '[2606:4700:4700::1111]:53',
      '::1',
    ]);
  });

  it.each(['dns.example.test', '1.1.1.1:0', '1.1.1.1:70000', '[1.1.1.1]:53', '1.1.1'])(
    'refuses %s and names the variable, never the value',
    (raw) => {
      expect(() => parseDnsServers(raw)).toThrow(/^DNS_SERVERS must be/);
    },
  );

  function resolver(v4: string[] | NodeJS.ErrnoException, v6: string[] | NodeJS.ErrnoException) {
    const answer = (value: string[] | NodeJS.ErrnoException) =>
      jest.fn(async () => {
        if (value instanceof Error) throw value;
        return value;
      });
    return { resolve4: answer(v4), resolve6: answer(v6) };
  }

  it('returns A then AAAA records', async () => {
    const lookup = dnsServersLookup(['1.1.1.1'], {
      resolver: resolver(['93.184.216.34'], ['2606:2800:220:1::1']),
    });
    await expect(lookup('rpc.example.test')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
  });

  it('uses the family that answered when the other has no record', async () => {
    const lookup = dnsServersLookup(['1.1.1.1'], {
      resolver: resolver(['93.184.216.34'], dnsError('ENODATA')),
    });
    await expect(lookup('rpc.example.test')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('NXDOMAIN or no record at all → ENOTFOUND, like getaddrinfo', async () => {
    const lookup = dnsServersLookup(['1.1.1.1'], {
      resolver: resolver(dnsError('ENOTFOUND'), dnsError('ENODATA')),
    });
    await expect(lookup('gone.example.test')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('an unreachable server → EAI_AGAIN; a timeout stays ETIMEOUT', async () => {
    const refused = dnsServersLookup(['1.1.1.1'], {
      resolver: resolver(dnsError('ECONNREFUSED'), dnsError('ECONNREFUSED')),
    });
    await expect(refused('rpc.example.test')).rejects.toMatchObject({ code: 'EAI_AGAIN' });

    const timeout = dnsServersLookup(['1.1.1.1'], {
      resolver: resolver(dnsError('ETIMEOUT'), dnsError('ENODATA')),
    });
    await expect(timeout('rpc.example.test')).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });

  it('keeps the system lookup for localhost names', async () => {
    const r = resolver(['93.184.216.34'], []);
    const system = scripted([{ address: '127.0.0.1', family: 4 }]);
    const lookup = dnsServersLookup(['1.1.1.1'], { resolver: r, systemLookup: system });
    await expect(lookup('app.localhost')).resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);
    expect(r.resolve4).not.toHaveBeenCalled();
  });

  it('its answers still go through the address check', async () => {
    const lookup = dnsServersLookup(['1.1.1.1'], { resolver: resolver(['10.0.0.5'], []) });
    const error = await refusal(resolveEgressTarget(PROVIDER_URL, UNTRUSTED_EGRESS_POLICY, lookup));
    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
  });
});

describe('EgressHttpClient — tiers end to end', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      // `/start?to=<url>` answers a redirect; everything else is a plain 200.
      const to = new URL(req.url ?? '/', 'http://local').searchParams.get('to');
      if (to) {
        res.statusCode = 302;
        res.setHeader('location', to);
        res.end();
        return;
      }
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A resolver that answers until `down` is set, then says ENOTFOUND. */
  function flakyClient(configHosts: ReadonlySet<string>) {
    const state = { down: false };
    const lookup = jest.fn(async () => {
      if (state.down) throw dnsError('ENOTFOUND');
      return [PUBLIC];
    });
    const client = new EgressHttpClient(
      lookup,
      () => ({ address: '127.0.0.1', family: 4, port }),
      null,
      configHosts,
    );
    return { client, state };
  }

  it('a config RPC host keeps working through ENOTFOUND; a provider host does not', async () => {
    const { client, state } = flakyClient(new Set(['rpc.chain.example.test']));
    const rpc = { url: 'http://rpc.chain.example.test/', policy: INTERNAL_EGRESS_POLICY };
    const provider = { url: 'http://api.provider.example.test/', policy: UNTRUSTED_EGRESS_POLICY };

    await client.request(rpc);
    await client.request(provider);
    state.down = true;

    await expect(client.request(rpc)).resolves.toMatchObject({ status: 200 });
    const error = await refusal(client.request(provider));
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it.each([
    ['another config host', 'http://facilitator.internal.example.test/ok'],
    ['a provider host', 'http://api.provider.example.test/ok'],
  ])(
    'a redirect from a config host to %s is strict: ENOTFOUND on hop 1 is DNS_FAILED (review M-1)',
    async (_what, target) => {
      const { client, state } = flakyClient(
        new Set(['rpc.chain.example.test', 'facilitator.internal.example.test']),
      );
      // Both hosts resolved before, under both trust levels, so a stored answer
      // exists for hop 1 whichever key it would look under.
      await client.request({ url: target, policy: INTERNAL_EGRESS_POLICY });
      await client.request({ url: target, policy: UNTRUSTED_EGRESS_POLICY });
      const start = {
        url: `http://rpc.chain.example.test/start?to=${encodeURIComponent(target)}`,
        policy: INTERNAL_EGRESS_POLICY,
      };
      await expect(client.request(start)).resolves.toMatchObject({ status: 200, redirects: 1 });

      state.down = true;

      // Hop 0 (the config host, INTERNAL_ALLOWED) may reuse; hop 1 is PUBLIC_ONLY
      // and must not, whatever host the Location names.
      await expect(
        client.request({ url: 'http://rpc.chain.example.test/ok', policy: INTERNAL_EGRESS_POLICY }),
      ).resolves.toMatchObject({ status: 200 });
      const error = await refusal(client.request(start));
      expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
      expect(error.message).toContain(new URL(target).hostname);
    },
  );
});

describe('NetworkModule wiring', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('builds the config host list from the environment and leaves DNS to the system by default', async () => {
    process.env.EVM_RPC_URLS = JSON.stringify({ 'eip155:46630': 'https://rpc.chain.example.test' });
    process.env.FACILITATOR_URL = 'http://facilitator.internal.example.test:3100';
    delete process.env.DNS_SERVERS;

    const moduleRef = await Test.createTestingModule({ imports: [NetworkModule] }).compile();
    const hosts = moduleRef.get<ReadonlySet<string>>(EGRESS_CONFIG_HOSTS);
    expect([...hosts].sort()).toEqual([
      'facilitator.internal.example.test',
      'rpc.chain.example.test',
    ]);
    expect(moduleRef.get(EGRESS_DNS_LOOKUP)).toBeUndefined();
    await moduleRef.close();
  });

  it('DNS_SERVERS set: warns at boot about a config host with no dot (review M-3)', async () => {
    process.env.DNS_SERVERS = '1.1.1.1';
    process.env.KORA_RPC_URL = 'http://kora:8080';
    process.env.FACILITATOR_URL = 'https://facilitator.internal.example.test';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const moduleRef = await Test.createTestingModule({ imports: [NetworkModule] }).compile();
      const warnings = warn.mock.calls.map(([message]) => String(message));
      expect(warnings.some((m) => m.includes('"kora"') && m.includes('DNS_SERVERS'))).toBe(true);
      expect(warnings.some((m) => m.includes('facilitator.internal'))).toBe(false);
      await moduleRef.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('singleLabelConfigHosts names only the hosts without a dot', () => {
    const config = new ConfigService({
      EVM_RPC_URLS: JSON.stringify({ 'eip155:46630': 'http://anvil:8545' }),
      FACILITATOR_URL: 'https://facilitator.example.test',
    });
    expect(singleLabelConfigHosts(config)).toEqual(['anvil']);
  });

  it('DNS_SERVERS set: the lookup is a function; malformed: the boot fails', async () => {
    process.env.DNS_SERVERS = '1.1.1.1';
    const moduleRef = await Test.createTestingModule({ imports: [NetworkModule] }).compile();
    expect(typeof moduleRef.get(EGRESS_DNS_LOOKUP)).toBe('function');
    await moduleRef.close();

    process.env.DNS_SERVERS = 'dns.example.test';
    await expect(Test.createTestingModule({ imports: [NetworkModule] }).compile()).rejects.toThrow(
      /DNS_SERVERS must be/,
    );
  });
});
