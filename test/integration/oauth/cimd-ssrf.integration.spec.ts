import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as https from 'node:https';
import { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';

import { OAuthClientRepository } from '@database/postgres/repositories/oauth-client.repository';
import { CimdFetcher } from '@modules/oauth/services/cimd.fetcher';
import { MetricsRegistryService } from '@modules/observability/services/metrics-registry.service';
import { EgressConnectOverride, EgressHttpClient, EgressTarget } from '@shared/network/egress';

import {
  Clock,
  FakeOAuthClientRepository,
  FakeOAuthRedis,
  counterValue,
  fakeCache,
  oauthConfig,
  oauthMetrics,
  rateLimiter,
} from '../../unit/oauth/helpers/oauth-fakes';

/**
 * Threat T7: a CIMD `client_id` is a URL a stranger chose. The real
 * `EgressHttpClient`, with only its resolver and socket destination
 * overridden, must refuse every internal destination by the address the name
 * RESOLVES to (not by how the URL is spelled), connect only to the address it
 * checked, follow no redirect, and stop at 16 KB and 5 s.
 *
 * Public-looking names answer with a public address, and
 * the connect override lands those sockets on a local HTTPS server whose
 * certificate is generated for this run. The override runs only after the
 * address check, so it cannot admit anything the check refused.
 */
const PUBLIC_ADDRESS = '93.184.216.34';
const OTHER_PUBLIC_ADDRESS = '93.184.216.35';
const IP_KEY = '198.51.100.20';

/** Host → the DNS answer it gets. */
const answers: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
  'good.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'redirect.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'big.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'slow.example.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'loopback.example.com': [{ address: '127.0.0.1', family: 4 }],
  '127.0.0.1.nip.io': [{ address: '127.0.0.1', family: 4 }],
  'loopback6.example.com': [{ address: '::1', family: 6 }],
  'metadata.example.com': [{ address: '169.254.169.254', family: 4 }],
  'private.example.com': [{ address: '10.0.0.1', family: 4 }],
  'mapped.example.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
  'mapped-metadata.example.com': [{ address: '::ffff:169.254.169.254', family: 6 }],
  'cgnat.example.com': [{ address: '100.64.0.1', family: 4 }],
  'multicast.example.com': [{ address: '224.0.0.1', family: 4 }],
  'ula.example.com': [{ address: 'fd00::1', family: 6 }],
  'mixed.example.com': [
    { address: PUBLIC_ADDRESS, family: 4 },
    { address: '10.0.0.1', family: 4 },
  ],
};

/** `rebind.example.com`: public on the first lookup, private on every later one. */
let rebindLookups = 0;

const lookup = jest.fn(async (hostname: string) => {
  if (hostname === 'rebind.example.com') {
    rebindLookups += 1;
    return rebindLookups === 1
      ? [{ address: OTHER_PUBLIC_ADDRESS, family: 4 as const }]
      : [{ address: '127.0.0.1', family: 4 as const }];
  }
  const answer = answers[hostname];
  if (answer) return answer;
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

/** Every address a socket was opened for, as the guard approved it. */
const dialled: string[] = [];
let serverPort = 0;
const connectOverride: EgressConnectOverride = (target: EgressTarget) => {
  dialled.push(target.address);
  return { address: '127.0.0.1', family: 4, port: serverPort };
};

const hits: string[] = [];
const sockets = new Set<Socket>();
let server: https.Server;
let certDir: string;
let defaultCAs: string[];

function document(url: string): string {
  return JSON.stringify({
    client_id: url,
    client_name: 'Example App',
    redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
  });
}

function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const host = String(req.headers.host);
  hits.push(host);
  const url = `https://${host}${req.url}`;
  switch (host) {
    case 'redirect.example.com':
      res.writeHead(302, { location: 'https://metadata.example.com/latest/meta-data/' });
      res.end();
      return;
    case 'big.example.com': {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client_id: url, padding: 'x'.repeat(20_000) }));
      return;
    }
    case 'slow.example.com': {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      const drip = setInterval(() => res.write(' '), 250);
      res.on('close', () => clearInterval(drip));
      return;
    }
    default:
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(document(url));
  }
}

function setup() {
  const { metrics, registry } = oauthMetrics();
  const redis = new FakeOAuthRedis();
  const clock = new Clock();
  const fetcher = new CimdFetcher(
    new EgressHttpClient(lookup, connectOverride, null),
    new FakeOAuthClientRepository() as unknown as OAuthClientRepository,
    rateLimiter(redis, clock),
    fakeCache(redis),
    metrics,
    oauthConfig(),
  );
  return { fetcher, registry };
}

const fetched = (registry: MetricsRegistryService, result: string) =>
  counterValue(registry, 'assay_oauth_cimd_fetch_total', { result });

beforeAll(async () => {
  // A throwaway key and certificate for this run only; nothing is committed.
  certDir = mkdtempSync(join(tmpdir(), 'cimd-ssrf-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=example.com',
      '-addext',
      'subjectAltName=DNS:*.example.com,DNS:127.0.0.1.nip.io',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(join(certDir, 'cert.pem'), 'utf8');
  const key = readFileSync(join(certDir, 'key.pem'), 'utf8');
  defaultCAs = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...defaultCAs, cert]);

  server = https.createServer({ cert, key }, handle);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  tls.setDefaultCACertificates(defaultCAs);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(certDir, { recursive: true, force: true });
});

beforeEach(() => {
  dialled.length = 0;
  hits.length = 0;
  lookup.mockClear();
});

describe('CIMD fetch SSRF (T7) — real EgressHttpClient', () => {
  it('fetches a public document (the harness works)', async () => {
    const { fetcher, registry } = setup();
    const outcome = await fetcher.fetch('https://good.example.com/client.json', IP_KEY);
    expect(outcome.ok).toBe(true);
    expect(dialled).toEqual([PUBLIC_ADDRESS]);
    expect(await fetched(registry, 'ok')).toBe(1);
  });

  it.each([
    ['127.0.0.1', 'loopback.example.com'],
    ['127.0.0.1 behind a name spelled like an address', '127.0.0.1.nip.io'],
    ['::1', 'loopback6.example.com'],
    ['169.254.169.254', 'metadata.example.com'],
    ['10.0.0.1', 'private.example.com'],
    ['::ffff:127.0.0.1', 'mapped.example.com'],
    ['::ffff:169.254.169.254', 'mapped-metadata.example.com'],
    ['100.64.0.1 (CGNAT)', 'cgnat.example.com'],
    ['224.0.0.1 (multicast)', 'multicast.example.com'],
    ['fd00::1 (unique local)', 'ula.example.com'],
    ['one public and one private answer', 'mixed.example.com'],
  ])('%s → blocked_address, never dialled', async (_label, host) => {
    const { fetcher, registry } = setup();
    const outcome = await fetcher.fetch(`https://${host}/client.json`, IP_KEY);
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
    expect(lookup).toHaveBeenCalledWith(host);
    expect(dialled).toEqual([]);
    expect(hits).toEqual([]);
    expect(await fetched(registry, 'blocked_address')).toBe(1);
  });

  it('DNS rebinding: one lookup per fetch, the socket goes to the checked address, the next answer is refused', async () => {
    rebindLookups = 0;
    const { fetcher, registry } = setup();

    // First answer public: resolved once and pinned. No second lookup happens
    // between the check and the connect for a private answer to slip into.
    const first = await fetcher.fetch('https://rebind.example.com/a.json', IP_KEY);
    expect(first.ok).toBe(true);
    expect(rebindLookups).toBe(1);
    expect(dialled).toEqual([OTHER_PUBLIC_ADDRESS]);

    // Second answer private: a fresh fetch resolves again and is refused.
    const second = await fetcher.fetch('https://rebind.example.com/b.json', IP_KEY);
    expect(second).toEqual({ ok: false, reason: 'invalid' });
    expect(rebindLookups).toBe(2);
    expect(dialled).toEqual([OTHER_PUBLIC_ADDRESS]);
    expect(await fetched(registry, 'blocked_address')).toBe(1);
  });

  it('302 to an internal address → refused; the Location is never resolved or dialled', async () => {
    const { fetcher, registry } = setup();
    const outcome = await fetcher.fetch('https://redirect.example.com/client.json', IP_KEY);
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
    expect(lookup).not.toHaveBeenCalledWith('metadata.example.com');
    expect(dialled).toEqual([PUBLIC_ADDRESS]);
    expect(hits).toEqual(['redirect.example.com']);
    expect(await fetched(registry, 'status')).toBe(1);
  });

  it('more than 16 KB → too_large', async () => {
    const { fetcher, registry } = setup();
    const outcome = await fetcher.fetch('https://big.example.com/client.json', IP_KEY);
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
    expect(await fetched(registry, 'too_large')).toBe(1);
  });

  it('a slow drip past 5 s → timeout, within the 5 s budget', async () => {
    const { fetcher, registry } = setup();
    const started = Date.now();
    const outcome = await fetcher.fetch('https://slow.example.com/client.json', IP_KEY);
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(6500);
    expect(await fetched(registry, 'timeout')).toBe(1);
  });

  it('an IP-literal client_id is refused before any lookup or socket', async () => {
    const { fetcher } = setup();
    for (const url of [
      'https://127.0.0.1/client.json',
      'https://[::1]/client.json',
      'https://169.254.169.254/latest/meta-data/',
      'https://0x7f000001/client.json',
    ]) {
      expect(await fetcher.fetch(url, IP_KEY)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(dialled).toEqual([]);
  });
});
