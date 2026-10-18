/**
 * The relay transport: provider-typed URLs leave through the egress relay
 * (`workers/egress-relay/`), and the backend still resolves, checks and
 * re-checks every hop first.
 *
 * The relay here is a local `http.createServer` speaking protocol v1 the same
 * way the Worker does: `POST /v1/relay` with a bearer and a JSON envelope; the
 * provider's answer comes back with `x-assay-relay: upstream`, a relay failure
 * as `502` + `x-assay-relay: error` + `{ kind }`. The provider itself is never
 * dialled — each test says what the "provider" answered.
 */
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';

import {
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
  UNTRUSTED_EGRESS_POLICY,
  withLimits,
} from '@shared/network/egress';
import { EgressRelayConfig, takeEgressRelayConfig } from '@shared/network/egress';
import { resetEnvSigningKeyCacheForTests } from '@modules/verification/signing/backends/env-key-source';
import {
  ResponseClass,
  TransportErrorKind,
  canEverSlash,
  classifyTransportError,
} from '@modules/tool/domain/classification';

const ZONE: Readonly<Record<string, { address: string; family: 4 | 6 }>> = {
  'p.test': { address: '93.184.216.34', family: 4 },
  'other.test': { address: '93.184.216.35', family: 4 },
  'internal.test': { address: '10.0.0.5', family: 4 },
};

const lookup = jest.fn(async (hostname: string) => {
  if (ZONE[hostname]) return [ZONE[hostname]];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

interface Envelope {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
}

interface RelayCall {
  path: string;
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  envelope: Envelope;
}

interface RelayAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

const TOKEN = randomBytes(32).toString('hex');

let relay: http.Server;
let relayPort: number;
let connections = 0;
let calls: RelayCall[] = [];
let directHits: string[] = [];
/** What the relay answers for an envelope. Set per test. */
let answer: (envelope: Envelope) => RelayAnswer;
const sockets: Array<{ destroy: () => void }> = [];

const upstream = (status: number, body: string | Buffer, headers: Record<string, string> = {}) =>
  ({ status, body, headers: { ...headers, 'x-assay-relay': 'upstream' } }) as RelayAnswer;

const relayError = (kind: string): RelayAnswer => ({
  status: 502,
  headers: { 'content-type': 'application/json', 'x-assay-relay': 'error' },
  body: JSON.stringify({ kind }),
});

function config(): EgressRelayConfig {
  return { url: new URL(`http://127.0.0.1:${relayPort}`), token: TOKEN };
}

const clients: EgressHttpClient[] = [];
function relayClient(): EgressHttpClient {
  const client = new EgressHttpClient(lookup, undefined, config());
  clients.push(client);
  return client;
}

const RELAYED = Object.freeze({ ...UNTRUSTED_EGRESS_POLICY, relay: true });

async function expectEgressError(promise: Promise<unknown>): Promise<EgressError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressError);
    return error as EgressError;
  }
  throw new Error('expected the request to fail, but it resolved');
}

beforeAll(async () => {
  relay = http.createServer((req, res) => {
    if (req.url !== '/v1/relay') {
      directHits.push(`${req.method} ${req.url}`);
      req.resume();
      res.end('direct');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Envelope;
      calls.push({
        path: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        envelope,
      });
      const out = answer(envelope);
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body ?? '');
    });
  });
  relay.on('connection', (socket) => {
    connections += 1;
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  relayPort = (relay.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const client of clients) client.onModuleDestroy();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  directHits = [];
  connections = 0;
  answer = () => upstream(200, '{}');
  lookup.mockClear();
});

describe('relay: true with a relay configured', () => {
  it('sends a protocol-v1 envelope and returns the relayed status and body', async () => {
    answer = () => upstream(201, '{"ok":true}', { 'content-type': 'application/json' });

    const response = await relayClient().request({
      url: 'https://p.test/v1?q=1',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vendor-auth': 'k' },
      body: '{"a":1}',
      policy: RELAYED,
    });

    expect(response.status).toBe(201);
    expect(response.body).toBe('{"ok":true}');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['x-assay-relay']).toBeUndefined();
    expect(response.url).toBe('https://p.test/v1?q=1');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v1/relay');
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.contentType).toBe('application/json');
    expect(call.envelope).toEqual({
      url: 'https://p.test/v1?q=1',
      method: 'POST',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-vendor-auth': 'k',
        'accept-encoding': 'identity',
      }),
      body: '{"a":1}',
      timeoutMs: expect.any(Number),
      maxResponseBytes: UNTRUSTED_EGRESS_POLICY.limits.maxResponseBytes,
    });
    expect(call.envelope.timeoutMs).toBeGreaterThan(0);
    expect(call.envelope.timeoutMs).toBeLessThanOrEqual(
      UNTRUSTED_EGRESS_POLICY.limits.totalTimeoutMs,
    );
    expect(call.envelope.headers).not.toHaveProperty('host');
  });

  it('sends a null body for a request without one', async () => {
    await relayClient().request({ url: 'https://p.test/', policy: RELAYED });

    expect(calls[0].envelope.method).toBe('GET');
    expect(calls[0].envelope.body).toBeNull();
  });

  it('resolves and checks the target before the relay is called', async () => {
    const error = await expectEgressError(
      relayClient().request({ url: 'https://internal.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(calls).toHaveLength(0);
  });

  it('withLimits keeps relay: true', async () => {
    const narrowed = withLimits(RELAYED, { maxResponseBytes: 1024 });
    expect(narrowed.relay).toBe(true);

    await relayClient().request({ url: 'https://p.test/', policy: narrowed });
    expect(calls[0].envelope.maxResponseBytes).toBe(1024);
  });
});

describe('relay unset or not configured', () => {
  /** Direct calls land on the same local server, at a non-relay path. */
  function directClient(relayConfig?: EgressRelayConfig): EgressHttpClient {
    const client = new EgressHttpClient(
      lookup,
      () => ({ address: '127.0.0.1', family: 4, port: relayPort }),
      relayConfig,
    );
    clients.push(client);
    return client;
  }

  it('never calls the relay with relay: false', async () => {
    const response = await directClient(config()).request({
      url: 'http://p.test/plain',
      policy: { ...UNTRUSTED_EGRESS_POLICY, relay: false },
    });

    expect(response.body).toBe('direct');
    expect(calls).toHaveLength(0);
    expect(directHits).toEqual(['GET /plain']);
  });

  it('never calls the relay when the policy is omitted', async () => {
    const response = await directClient(config()).request({ url: 'http://p.test/plain' });

    expect(response.body).toBe('direct');
    expect(calls).toHaveLength(0);
    expect(directHits).toEqual(['GET /plain']);
  });

  it('goes direct when relay: true but no relay is configured', async () => {
    const response = await directClient().request({ url: 'http://p.test/plain', policy: RELAYED });

    expect(response.body).toBe('direct');
    expect(calls).toHaveLength(0);
    expect(directHits).toEqual(['GET /plain']);
  });
});

describe('redirects through the relay', () => {
  it('re-checks a relayed 302 to a private address and never relays the second hop', async () => {
    answer = () => upstream(302, '', { location: 'https://internal.test/steal' });

    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/start', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(calls).toHaveLength(1);
  });

  it('strips credentials from the envelope after a cross-origin redirect', async () => {
    answer = (envelope) =>
      envelope.url.startsWith('https://p.test/')
        ? upstream(302, '', { location: 'https://other.test/next' })
        : upstream(200, 'done');

    const response = await relayClient().request({
      url: 'https://p.test/start',
      headers: { 'x-vendor-auth': 'secret', signature: 'sig', accept: 'application/json' },
      policy: RELAYED,
    });

    expect(response.body).toBe('done');
    expect(response.redirects).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].envelope.headers['x-vendor-auth']).toBe('secret');
    expect(calls[1].envelope.url).toBe('https://other.test/next');
    expect(calls[1].envelope.headers).not.toHaveProperty('x-vendor-auth');
    expect(calls[1].envelope.headers).not.toHaveProperty('signature');
    expect(calls[1].envelope.headers['accept']).toBe('application/json');
  });
});

describe('relay failures', () => {
  it('a response without x-assay-relay is RELAY_UNAVAILABLE', async () => {
    answer = () => ({ status: 200, body: '<html>cloudflare</html>' });

    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.RELAY_UNAVAILABLE);
  });

  it('a 502 without x-assay-relay is RELAY_UNAVAILABLE', async () => {
    answer = () => ({ status: 502, body: 'bad gateway' });

    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.RELAY_UNAVAILABLE);
  });

  it('UNAUTHORIZED is RELAY_UNAVAILABLE and the token appears nowhere', async () => {
    const logged: string[] = [];
    const methods = ['log', 'error', 'warn', 'debug', 'verbose'] as const;
    const spies = methods.map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    answer = () => relayError('UNAUTHORIZED');

    try {
      const error = await expectEgressError(
        relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
      );

      expect(error.kind).toBe(EgressFailureKind.RELAY_UNAVAILABLE);
      expect(error.message).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(JSON.stringify(error.context ?? {})).not.toContain(TOKEN);
      expect(String(error.cause ?? '')).not.toContain(TOKEN);
      expect(error.stack ?? '').not.toContain(TOKEN);
      expect(logged.join('\n')).not.toContain(TOKEN);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('BAD_REQUEST is RELAY_UNAVAILABLE', async () => {
    answer = () => relayError('BAD_REQUEST');

    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.RELAY_UNAVAILABLE);
  });

  it('an unreadable error body is RELAY_UNAVAILABLE', async () => {
    answer = () => ({ status: 502, headers: { 'x-assay-relay': 'error' }, body: 'nope' });

    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.RELAY_UNAVAILABLE);
  });

  it.each([
    ['TIMEOUT', EgressFailureKind.TIMEOUT],
    ['CONNECT', EgressFailureKind.CONNECTION_FAILED],
    ['BLOCKED_TARGET', EgressFailureKind.BLOCKED_ADDRESS],
    ['TOO_LARGE', EgressFailureKind.RESPONSE_TOO_LARGE],
  ])('relay kind %s maps to %s', async (kind, expected) => {
    answer = () => relayError(kind);

    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(expected);
  });

  it('an unreachable relay is RELAY_UNAVAILABLE, with no direct fallback', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    let directDials = 0;
    const client = new EgressHttpClient(
      lookup,
      () => {
        directDials += 1;
        return { address: '127.0.0.1', family: 4, port: relayPort };
      },
      { url: new URL(`http://127.0.0.1:${deadPort}`), token: TOKEN },
    );
    clients.push(client);

    const error = await expectEgressError(
      client.request({ url: 'https://p.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.RELAY_UNAVAILABLE);
    expect(error.message).not.toContain(TOKEN);
    expect(directDials).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a 6 MiB relayed body hits the size cap', async () => {
    answer = () => upstream(200, Buffer.alloc(6 * 1024 * 1024, 0x61));

    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
    );

    expect(error.kind).toBe(EgressFailureKind.RESPONSE_TOO_LARGE);
  });

  it('a relay that stalls is cut by the client timers', async () => {
    const stalled = http.createServer(() => undefined);
    const stalledSockets: Array<{ destroy: () => void }> = [];
    stalled.on('connection', (s) => stalledSockets.push(s));
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const client = new EgressHttpClient(lookup, undefined, {
      url: new URL(`http://127.0.0.1:${(stalled.address() as AddressInfo).port}`),
      token: TOKEN,
    });

    try {
      const error = await expectEgressError(
        client.request({
          url: 'https://p.test/',
          policy: withLimits(RELAYED, { headersTimeoutMs: 50 }),
        }),
      );
      expect(error.kind).toBe(EgressFailureKind.TIMEOUT);
    } finally {
      client.onModuleDestroy();
      for (const s of stalledSockets) s.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });
});

describe('connection reuse', () => {
  it('two sequential calls share one keep-alive socket', async () => {
    const client = relayClient();

    await client.request({ url: 'https://p.test/a', policy: RELAYED });
    await client.request({ url: 'https://p.test/b', policy: RELAYED });

    expect(calls).toHaveLength(2);
    expect(connections).toBe(1);
  });
});

describe('classification', () => {
  it('RELAY_UNAVAILABLE is a platform fault with a fixed detail', async () => {
    answer = () => relayError('UNAUTHORIZED');
    const error = await expectEgressError(
      relayClient().request({ url: 'https://p.test/', policy: RELAYED }),
    );

    const classified = classifyTransportError(error, 'partial');

    expect(classified.kind).toBe(TransportErrorKind.PLATFORM_UNAVAILABLE);
    expect(classified.detail).toBe('egress relay unavailable');
    expect(classified.partialBody).toBeNull();
    expect(canEverSlash(ResponseClass.SYSTEM_ERROR)).toBe(false);
  });

  it('is recognised under a cause chain too', () => {
    const inner = new EgressError(EgressFailureKind.RELAY_UNAVAILABLE, 'x');
    const outer = Object.assign(new Error('wrapped'), { cause: inner });

    expect(classifyTransportError(outer).kind).toBe(TransportErrorKind.PLATFORM_UNAVAILABLE);
  });
});

describe('takeEgressRelayConfig', () => {
  beforeEach(() => resetEnvSigningKeyCacheForTests());

  it('is null when EGRESS_RELAY_URL is unset, and still removes the token', () => {
    const env: NodeJS.ProcessEnv = { EGRESS_RELAY_TOKEN: TOKEN };

    expect(takeEgressRelayConfig(env)).toBeNull();
    expect(env.EGRESS_RELAY_TOKEN).toBeUndefined();
  });

  it('reads the URL and takes the token out of the environment', () => {
    const env: NodeJS.ProcessEnv = {
      EGRESS_RELAY_URL: 'https://egress.example.test',
      EGRESS_RELAY_TOKEN: TOKEN,
    };

    const taken = takeEgressRelayConfig(env);

    expect(taken?.url.href).toBe('https://egress.example.test/');
    expect(taken?.token).toBe(TOKEN);
    expect(env.EGRESS_RELAY_TOKEN).toBeUndefined();
  });

  it('refuses a URL without a token, without quoting anything secret', () => {
    expect(() =>
      takeEgressRelayConfig({ EGRESS_RELAY_URL: 'https://egress.example.test' }),
    ).toThrow(/EGRESS_RELAY_TOKEN/);
  });

  it('refuses a short or non-hex token without quoting it', () => {
    const weak = 'not-a-hex-token-but-long-enough-to-matter-0123456789';
    let message = '';
    try {
      takeEgressRelayConfig({
        EGRESS_RELAY_URL: 'https://egress.example.test',
        EGRESS_RELAY_TOKEN: weak,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/EGRESS_RELAY_TOKEN/);
    expect(message).not.toContain(weak);
  });

  it('refuses an http relay URL in production', () => {
    expect(() =>
      takeEgressRelayConfig({
        NODE_ENV: 'production',
        EGRESS_RELAY_URL: 'http://egress.example.test',
        EGRESS_RELAY_TOKEN: TOKEN,
      }),
    ).toThrow(/https/);
  });

  it('refuses an unparseable URL', () => {
    expect(() =>
      takeEgressRelayConfig({ EGRESS_RELAY_URL: 'not a url', EGRESS_RELAY_TOKEN: TOKEN }),
    ).toThrow(/EGRESS_RELAY_URL/);
  });
});
