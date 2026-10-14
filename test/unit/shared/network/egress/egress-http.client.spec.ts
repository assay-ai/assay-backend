/**
 * The SSRF guard, end to end, against real sockets.
 *
 * The six required cases are numbered in the `describe` titles. Cases
 * 4, 5 and 6 need a server that actually answers, so this file stands one up
 * rather than mocking `http.request` — a mock proves the client agrees with the
 * author's model of Node, and the whole failure mode being defended against is
 * that Node does something the author did not model.
 *
 * ## Why the destination is faked and the address is not
 *
 * `classifyAddress` refuses every address that is safe to fake and permits
 * every address a test must not dial. So the DNS answer is faked — a
 * public-looking `93.184.216.34` for the hosts that must pass, `10.0.0.5` for
 * the ones that must not — and `EGRESS_CONNECT_OVERRIDE` lands the *already
 * approved* connection on the local server. The address rules run unmodified on
 * the real resolved address, which is the part under test. See
 * `EGRESS_CONNECT_OVERRIDE`'s doc comment for why that seam cannot weaken the
 * guard.
 */
import { AddressInfo } from 'node:net';
import * as http from 'node:http';

import {
  BlockedAddressReason,
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
  INTERNAL_EGRESS_POLICY,
  UNTRUSTED_EGRESS_POLICY,
  withLimits,
} from '@shared/network/egress';
import { assertRedirectAllowed } from '@shared/network/egress/egress-http.client';
import {
  ResponseClass,
  canEverSlash,
  classifyTransportError,
} from '@modules/tool/domain/classification';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** What each hostname in this file resolves to. Nothing here touches real DNS. */
const ZONE: Readonly<Record<string, { address: string; family: 4 | 6 }>> = {
  'edge.provider.test': { address: '93.184.216.34', family: 4 }, // public — must pass
  'cdn.provider.test': { address: '93.184.216.35', family: 4 }, // public — must pass
  'internal.provider.test': { address: '10.0.0.5', family: 4 }, // private — must not
  'metadata.provider.test': { address: '169.254.169.254', family: 4 }, // metadata — must not
  'split.provider.test': { address: '93.184.216.34', family: 4 }, // first of two, see below
};

/** Hostnames that answer with more than one record. */
const MULTI: Readonly<Record<string, Array<{ address: string; family: 4 | 6 }>>> = {
  'split.provider.test': [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ],
};

const lookup = jest.fn(async (hostname: string) => {
  if (MULTI[hostname]) return MULTI[hostname];
  if (ZONE[hostname]) return [ZONE[hostname]];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

let server: http.Server;
let port: number;
/** Set per test — what the server does with the next request. */
let handler: http.RequestListener;

/** Sockets a test opened deliberately and must close, or Jest hangs. */
const openSockets: Array<{ destroy: () => void }> = [];

function clientWithLocalConnect(): EgressHttpClient {
  return new EgressHttpClient(lookup, (target) => ({
    address: '127.0.0.1',
    family: 4,
    port: target.port === 80 ? port : target.port,
  }));
}

/** No connect override: a blocked address must be refused before any socket exists. */
function clientWithoutConnect(): EgressHttpClient {
  return new EgressHttpClient(lookup);
}

async function expectEgressError(promise: Promise<unknown>): Promise<EgressError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressError);
    return error as EgressError;
  }
  throw new Error('expected the request to be refused, but it resolved');
}

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handler = (_req, res) => res.end('{}');
  lookup.mockClear();
});

// ---------------------------------------------------------------------------
// Sanity: the harness can reach the server at all
// ---------------------------------------------------------------------------

describe('a public endpoint that behaves', () => {
  it('is fetched, and the body comes back', async () => {
    handler = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"results":[1,2,3]}');
    };

    const response = await clientWithLocalConnect().request({
      url: 'http://edge.provider.test/search',
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"results":[1,2,3]}');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.redirects).toBe(0);
  });

  it('sends the real hostname in Host, not the address it connected to', async () => {
    let seen = '';
    handler = (req, res) => {
      seen = req.headers.host ?? '';
      res.end('{}');
    };

    await clientWithLocalConnect().request({ url: 'http://edge.provider.test/x' });

    expect(seen).toBe('edge.provider.test');
  });
});

// ---------------------------------------------------------------------------
// Case 1 — a URL pointing at 127.0.0.1
// ---------------------------------------------------------------------------

describe('case 1 — a URL pointing at loopback', () => {
  it.each([
    ['http://127.0.0.1/', BlockedAddressReason.LOOPBACK],
    ['http://127.0.0.1:8080/admin', BlockedAddressReason.LOOPBACK],
    ['http://127.1.1.1/', BlockedAddressReason.LOOPBACK],
    ['http://[::1]:3000/', BlockedAddressReason.LOOPBACK],
    ['http://0.0.0.0/', BlockedAddressReason.UNSPECIFIED],
  ])('blocks %s', async (url, reason) => {
    const error = await expectEgressError(clientWithoutConnect().request({ url }));

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(error.addressReason).toBe(reason);
  });

  it('never opens a socket — the block happens before connect', async () => {
    let reached = false;
    handler = (_req, res) => {
      reached = true;
      res.end('{}');
    };

    // The override would land this on the live server if the guard let it past.
    await expectEgressError(clientWithLocalConnect().request({ url: `http://127.0.0.1:${port}/` }));

    expect(reached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — the cloud metadata endpoint
// ---------------------------------------------------------------------------

describe('case 2 — a URL pointing at instance metadata', () => {
  it.each([
    ['http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['http://169.254.170.2/v2/credentials'],
    ['http://100.100.100.200/latest/meta-data/'],
    ['http://[fd00:ec2::254]/latest/meta-data/'],
  ])('blocks %s as CLOUD_METADATA', async (url) => {
    const error = await expectEgressError(clientWithoutConnect().request({ url }));

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(error.addressReason).toBe(BlockedAddressReason.CLOUD_METADATA);
  });

  it('blocks the rest of the link-local range too, not just the famous address', async () => {
    const error = await expectEgressError(
      clientWithoutConnect().request({ url: 'http://169.254.42.1/' }),
    );

    expect(error.addressReason).toBe(BlockedAddressReason.LINK_LOCAL);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — a hostname whose DNS answer is internal
// ---------------------------------------------------------------------------

describe('case 3 — a hostname that resolves to an internal address', () => {
  it('blocks it, naming the address DNS actually returned', async () => {
    const error = await expectEgressError(
      clientWithoutConnect().request({ url: 'http://internal.provider.test/v1/search' }),
    );

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(error.addressReason).toBe(BlockedAddressReason.PRIVATE);
    expect(error.address).toBe('10.0.0.5');
    expect(error.message).toContain('10.0.0.5');
  });

  it('blocks a hostname whose DNS answer resolves to metadata', async () => {
    const error = await expectEgressError(
      clientWithoutConnect().request({ url: 'http://metadata.provider.test/' }),
    );

    expect(error.addressReason).toBe(BlockedAddressReason.CLOUD_METADATA);
  });

  it('blocks a hostname that answers with one public and one private record', async () => {
    // A split answer is the rebinding attacker betting on which record we take.
    // Every record has to pass, not just the one we would have picked.
    const error = await expectEgressError(
      clientWithLocalConnect().request({ url: 'http://split.provider.test/' }),
    );

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(error.address).toBe('10.0.0.5');
  });

  it('resolves exactly once per hop, so a second answer has nothing to attach to', async () => {
    await clientWithLocalConnect().request({ url: 'http://edge.provider.test/' });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('edge.provider.test');
  });
});

// ---------------------------------------------------------------------------
// Case 4 — a redirect from a public address to an internal one
// ---------------------------------------------------------------------------

describe('case 4 — a redirect from a public address to an internal one', () => {
  it.each([[301], [302], [303], [307], [308]])(
    'blocks the %i hop to a private address',
    async (status) => {
      handler = (_req, res) => {
        res.writeHead(status, { location: 'http://internal.provider.test/admin' });
        res.end();
      };

      const error = await expectEgressError(
        clientWithLocalConnect().request({ url: 'http://edge.provider.test/start' }),
      );

      expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
      expect(error.addressReason).toBe(BlockedAddressReason.PRIVATE);
      expect(error.url).toBe('http://internal.provider.test/admin');
    },
  );

  it('blocks a redirect to the metadata endpoint by literal address', async () => {
    handler = (_req, res) => {
      res.writeHead(302, {
        location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      });
      res.end();
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({ url: 'http://edge.provider.test/start' }),
    );

    expect(error.addressReason).toBe(BlockedAddressReason.CLOUD_METADATA);
  });

  it('blocks a redirect that changes scheme to file:', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({ url: 'http://edge.provider.test/start' }),
    );

    expect(error.kind).toBe(EgressFailureKind.SCHEME_NOT_ALLOWED);
  });

  it('follows a redirect that stays public, and re-resolves on the way', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://cdn.provider.test/final' });
        res.end();
        return;
      }
      res.end('{"ok":true}');
    };

    const response = await clientWithLocalConnect().request({
      url: 'http://edge.provider.test/start',
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(response.redirects).toBe(1);
    // Two hops, two resolutions. One resolution reused across hops is how a
    // redirect check gets skipped without anybody noticing.
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('drops Authorization when the redirect changes origin', async () => {
    const seen: Array<string | undefined> = [];
    handler = (req, res) => {
      seen.push(req.headers.authorization);
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://cdn.provider.test/final' });
        res.end();
        return;
      }
      res.end('{}');
    };

    await clientWithLocalConnect().request({
      url: 'http://edge.provider.test/start',
      headers: { authorization: 'Bearer platform-secret' },
    });

    expect(seen[0]).toBe('Bearer platform-secret');
    expect(seen[1]).toBeUndefined();
  });

  // Review P-7: provider API keys travel in headers nobody can enumerate.
  it('forwards only an allowlist of headers when the redirect changes origin', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    handler = (req, res) => {
      seen.push(req.headers);
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://cdn.provider.test/final' });
        res.end();
        return;
      }
      res.end('{}');
    };

    await clientWithLocalConnect().request({
      url: 'http://edge.provider.test/start',
      headers: {
        'x-api-key': 'provider-secret',
        accept: 'application/json',
        'x-assay-call-id': 'c1',
      },
    });

    expect(seen[0]['x-api-key']).toBe('provider-secret');
    expect(seen[1]['x-api-key']).toBeUndefined();
    expect(seen[1].accept).toBe('application/json');
    expect(seen[1]['x-assay-call-id']).toBe('c1');
  });

  it('keeps provider headers on a same-origin redirect', async () => {
    const seen: Array<string | string[] | undefined> = [];
    handler = (req, res) => {
      seen.push(req.headers['x-api-key']);
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.end('{}');
    };

    await clientWithLocalConnect().request({
      url: 'http://edge.provider.test/start',
      headers: { 'x-api-key': 'provider-secret' },
    });

    expect(seen).toEqual(['provider-secret', 'provider-secret']);
  });

  it.each([[307], [308]])(
    'refuses a %i that would resend the body to another origin',
    async (status) => {
      const paths: Array<string | undefined> = [];
      handler = (req, res) => {
        paths.push(req.url);
        res.writeHead(status, { location: 'http://cdn.provider.test/collect' });
        res.end();
      };

      const error = await expectEgressError(
        clientWithLocalConnect().request({
          url: 'http://edge.provider.test/start',
          method: 'POST',
          body: '{"secret":"buyer"}',
        }),
      );

      expect(error.kind).toBe(EgressFailureKind.REDIRECT_INVALID);
      expect(paths).toEqual(['/start']);
    },
  );

  it('refuses an https → http downgrade on any hop', () => {
    expect(() =>
      assertRedirectAllowed(
        new URL('https://edge.provider.test/a'),
        new URL('http://edge.provider.test/b'),
        302,
        false,
      ),
    ).toThrow(EgressError);
    expect(() =>
      assertRedirectAllowed(
        new URL('http://edge.provider.test/a'),
        new URL('https://cdn.provider.test/b'),
        302,
        false,
      ),
    ).not.toThrow();
  });

  it('stops at maxRedirects rather than looping', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'http://cdn.provider.test/again' });
      res.end();
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: 'http://edge.provider.test/start',
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { maxRedirects: 2 }),
      }),
    );

    expect(error.kind).toBe(EgressFailureKind.TOO_MANY_REDIRECTS);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — a body larger than the cap
// ---------------------------------------------------------------------------

describe('case 5 — a response body larger than the cap', () => {
  const capped = withLimits(UNTRUSTED_EGRESS_POLICY, { maxResponseBytes: 4096 });

  it('aborts a body that declares more than the cap, without reading it', async () => {
    let written = 0;
    handler = (_req, res) => {
      res.setHeader('content-length', String(1024 * 1024));
      res.write('x'.repeat(1024));
      written += 1024;
      res.end();
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({ url: 'http://edge.provider.test/big', policy: capped }),
    );

    expect(error.kind).toBe(EgressFailureKind.RESPONSE_TOO_LARGE);
    expect(error.message).toContain('Content-Length');
    expect(written).toBeLessThanOrEqual(1024);
  });

  it('aborts a chunked body that passes the cap on arrival', async () => {
    // No Content-Length: the declaration check cannot help, so this is the
    // count-as-it-arrives path. A cap that only reads the header is a cap an
    // attacker turns off by omitting one.
    handler = (_req, res) => {
      res.setHeader('transfer-encoding', 'chunked');
      const chunk = 'y'.repeat(8192);
      const pump = (): void => {
        if (res.writableEnded || res.destroyed) return;
        res.write(chunk, () => setImmediate(pump));
      };
      pump();
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: 'http://edge.provider.test/stream',
        policy: capped,
      }),
    );

    expect(error.kind).toBe(EgressFailureKind.RESPONSE_TOO_LARGE);
    expect(error.message).toContain('4096 byte cap');
  });

  it('lets a body that fits through untouched', async () => {
    handler = (_req, res) => res.end('z'.repeat(4000));

    const response = await clientWithLocalConnect().request({
      url: 'http://edge.provider.test/ok',
      policy: capped,
    });

    expect(response.bytes).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — the infinite slow drip
// ---------------------------------------------------------------------------

describe('case 6 — a server that dribbles bytes forever', () => {
  /**
   * The case the worker cares about most. This server never violates the
   * protocol and never stops: it answers `200`, keeps the body open, and writes
   * one byte every 50ms. Nothing about it looks like a failure — an idle
   * timeout would be reset by every byte, a size cap would take hours to trip,
   * and `Content-Length` is absent so nothing can be predicted from the header.
   * Only a total read deadline ends it.
   */
  it('is cut off by the body read deadline', async () => {
    let timer: NodeJS.Timeout;
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write(' ');
      }, 50);
    };

    const startedAt = Date.now();
    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: 'http://edge.provider.test/drip',
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { bodyTimeoutMs: 400 }),
      }),
    );
    const elapsed = Date.now() - startedAt;
    clearInterval(timer!);

    expect(error.kind).toBe(EgressFailureKind.TIMEOUT);
    expect(error.message).toContain('body did not complete');
    // Bounded, and bounded by the *body* budget rather than by the total one.
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
    // The bytes that did arrive are kept as evidence and never parsed.
    expect(error.partialBody).toContain('{');
  });

  it('is cut off by the header deadline when it never answers at all', async () => {
    handler = () => {
      /* accept the connection, send nothing, ever */
    };

    const startedAt = Date.now();
    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: 'http://edge.provider.test/silent',
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { headersTimeoutMs: 300 }),
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(error.kind).toBe(EgressFailureKind.TIMEOUT);
    expect(error.message).toContain('no response headers');
    expect(elapsed).toBeLessThan(3_000);
  });

  it('is bounded by the total budget even across a redirect chain', async () => {
    // Each hop stays inside its own per-hop budget, so only the total deadline
    // can stop the chain. Without it the worst case is `maxRedirects + 1` times
    // the per-hop number.
    handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(302, { location: 'http://cdn.provider.test/again' });
        res.end();
      }, 200);
    };

    const startedAt = Date.now();
    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: 'http://edge.provider.test/start',
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, {
          headersTimeoutMs: 5_000,
          maxRedirects: 20,
          totalTimeoutMs: 500,
        }),
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(error.kind).toBe(EgressFailureKind.TIMEOUT);
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// The scheme gate, and the classification contract
// ---------------------------------------------------------------------------

describe('schemes other than http and https', () => {
  it.each([
    ['file:///etc/passwd'],
    ['gopher://127.0.0.1:6379/_SET%20foo%20bar'],
    ['ftp://example.com/x'],
    ['data:text/plain,hello'],
    ['redis://10.0.0.5:6379'],
    ['jar:http://example.com/a.jar!/'],
  ])('refuses %s', async (url) => {
    const error = await expectEgressError(clientWithoutConnect().request({ url }));
    expect(error.kind).toBe(EgressFailureKind.SCHEME_NOT_ALLOWED);
  });

  it('refuses a URL that is not a URL', async () => {
    const error = await expectEgressError(
      clientWithoutConnect().request({ url: '/relative/path' }),
    );
    expect(error.kind).toBe(EgressFailureKind.URL_INVALID);
  });
});

describe('every refusal reaches the classifier as SYSTEM_ERROR', () => {
  /**
   * The response-classifier half of the contract. A call that never happened, or that was
   * cut short by one of our own limits, tells us nothing about the provider's
   * data quality — so it must not be able to cost them a strike or their stake.
   * `EgressError` exposes its code as `.code` precisely so
   * `classifyTransportError` recognises it here.
   */
  it.each([
    [EgressFailureKind.BLOCKED_ADDRESS, 'http://169.254.169.254/'],
    [EgressFailureKind.SCHEME_NOT_ALLOWED, 'file:///etc/passwd'],
    [EgressFailureKind.URL_INVALID, 'not-a-url'],
    [EgressFailureKind.DNS_FAILED, 'http://nowhere.provider.test/'],
  ])('%s classifies with stake untouched', async (kind, url) => {
    const error = await expectEgressError(clientWithoutConnect().request({ url }));
    expect(error.kind).toBe(kind);

    const transport = classifyTransportError(error, error.partialBody);
    expect(canEverSlash(ResponseClass.SYSTEM_ERROR)).toBe(false);
    expect(transport.detail).toContain(error.code);
  });

  it('a body-size abort and a read timeout classify the same way', async () => {
    handler = (_req, res) => {
      res.setHeader('content-length', String(10 * 1024 * 1024));
      res.end('x'.repeat(64));
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: 'http://edge.provider.test/big',
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { maxResponseBytes: 128 }),
      }),
    );

    const transport = classifyTransportError(error, error.partialBody);
    expect(transport.detail).toContain('EGRESS_RESPONSE_TOO_LARGE');
  });
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial review
// ---------------------------------------------------------------------------

describe('a nameserver that simply drops the query', () => {
  /**
   * The first version of this client awaited `resolveEgressTarget` *before*
   * starting any deadline, so a blackholed nameserver left the promise pending
   * forever — no limit reached it, because every limit began after it returned.
   * A worker slot occupied indefinitely by one registered provider is exactly
   * the outcome `EgressLimits` exists to prevent, arrived at through the one
   * call that was outside the fence.
   */
  it('does not hang past the total budget', async () => {
    const neverResolves = jest.fn(() => new Promise<never>(() => {}));
    const client = new EgressHttpClient(neverResolves as never);

    const startedAt = Date.now();
    const error = await expectEgressError(
      client.request({
        url: 'http://blackhole.provider.test/tool',
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { totalTimeoutMs: 300 }),
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(error.kind).toBe(EgressFailureKind.TIMEOUT);
    expect(error.message).toContain('address resolution');
    expect(elapsed).toBeLessThan(2_000);
  });

  it('does not multiply the budget by the redirect count', async () => {
    // One slow resolution per hop, each inside its own per-hop budget, still
    // has to fit inside the total.
    const slow = jest.fn(
      () =>
        new Promise<never>(() => {
          /* pending */
        }),
    );
    const client = new EgressHttpClient(slow as never);

    const startedAt = Date.now();
    await expectEgressError(
      client.request({
        url: 'http://blackhole.provider.test/tool',
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, { totalTimeoutMs: 250, maxRedirects: 20 }),
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe('EgressTrust.INTERNAL_ALLOWED survives exactly one hop', () => {
  /**
   * The operator vouched for one URL. A `Location` header is chosen by the far
   * end, not by the operator, so carrying the relaxation across a redirect
   * would hand our own facilitator — or, from Phase 4, a third-party one, or a
   * compromised Kora — an unrestricted SSRF primitive into the VPC through a
   * single response header. Found by an adversarial review, which got a
   * `302 Location: http://127.0.0.1:<port>/latest/meta-data/iam/` all the way
   * to a 200 and a parsed body using the facilitator adapter's own policy.
   */
  const internal = withLimits(INTERNAL_EGRESS_POLICY, { totalTimeoutMs: 5_000 });

  it('reaches an internal first hop, which is the point of the trust level', async () => {
    handler = (_req, res) => res.end('{"kinds":[]}');

    const response = await clientWithLocalConnect().request({
      url: `http://127.0.0.1:${port}/supported`,
      policy: internal,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"kinds":[]}');
  });

  it('refuses the redirect that internal first hop asks for', async () => {
    handler = (req, res) => {
      if (req.url === '/verify') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/' });
        res.end();
        return;
      }
      res.end('{"AccessKeyId":"ASIA_STOLEN"}');
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: `http://127.0.0.1:${port}/verify`,
        policy: internal,
      }),
    );

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(error.addressReason).toBe(BlockedAddressReason.CLOUD_METADATA);
  });

  it.each([
    ['http://127.0.0.1:9999/admin', BlockedAddressReason.LOOPBACK],
    ['http://10.0.0.5/internal', BlockedAddressReason.PRIVATE],
    ['http://192.168.1.1/router', BlockedAddressReason.PRIVATE],
  ])('refuses a redirect to %s even from an internal origin', async (location, reason) => {
    handler = (_req, res) => {
      res.writeHead(302, { location });
      res.end();
    };

    const error = await expectEgressError(
      clientWithLocalConnect().request({
        url: `http://127.0.0.1:${port}/start`,
        policy: internal,
      }),
    );

    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
    expect(error.addressReason).toBe(reason);
  });
});
