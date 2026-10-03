/**
 * The transport cases, against real sockets.
 *
 * The case matrix in `response-classification.spec.ts` hands the classifier
 * hand-built `TransportError`s. This file does not: it stands up a real HTTP
 * server (and, where HTTP's own API refuses to misbehave, a raw TCP server that
 * writes malformed responses byte by byte), makes real `fetch` calls against
 * it, and feeds whatever Node actually throws into `classifyTransportError`.
 *
 * That matters because the recogniser's whole job is pattern-matching error
 * shapes that no specification defines — `UND_ERR_*` codes, `TypeError:
 * terminated`, errors nested three deep under `.cause`. A test that constructs
 * those shapes from memory proves the classifier agrees with the author's
 * recollection. This one proves it agrees with the runtime.
 *
 * Every assertion here ends in the same place: `SYSTEM_ERROR`, stake untouched.
 * The `kind` assertions are the diagnostic detail the router reads; the class
 * assertion is the one that protects a provider's money.
 */
import { AddressInfo } from 'node:net';
import * as http from 'node:http';
import * as net from 'node:net';

import {
  ClassificationPolicy,
  ClassificationReason,
  ProviderResponse,
  ResponseClass,
  TransportErrorKind,
  canEverSlash,
  classifyResponse,
  classifyTransportError,
  readResponseBody,
} from '@modules/tool/domain/classification';

const POLICY: ClassificationPolicy = { toolId: 'search_web' };

// ---------------------------------------------------------------------------
// The probe — a minimal stand-in for the router's call path
// ---------------------------------------------------------------------------

/**
 * Perform one real call and reduce it to a `ProviderResponse`.
 *
 * The body is read incrementally rather than with `res.text()` so that a
 * failure part-way through leaves the bytes that did arrive in `received` —
 * which is exactly the "timeout with a partial body" case,
 * and it cannot be observed at all if the read is atomic.
 */
async function probe(url: string, timeoutMs = 5_000): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let received = '';

  try {
    const response = await fetch(url, { signal: controller.signal });
    const headers = Object.fromEntries(response.headers.entries());

    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    }

    return {
      status: response.status,
      headers,
      body: readResponseBody(received, headers['content-type']),
    };
  } catch (error) {
    return {
      status: 0,
      headers: {},
      body: readResponseBody(null),
      transportError: classifyTransportError(error, received.length > 0 ? received : null),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

/** Handles that must be destroyed in `afterAll`, or Jest hangs on an open socket. */
const openSockets = new Set<net.Socket>();

let httpServer: http.Server;
let httpBase: string;
let rawServer: net.Server;
let rawBase: string;
let deadPort: number;

/**
 * Sockets deliberately abandoned mid-response. `server.close()` waits for
 * in-flight connections, so a route that never finishes its body would hang the
 * teardown forever if the socket were not tracked and destroyed.
 */
const stalled = new Set<http.ServerResponse>();

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [{ title: 'x' }] }));
        return;

      case '/empty':
        // A 200 that announces JSON and sends nothing. What a load balancer
        // that lost the payload looks like from the client's side.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end();
        return;

      case '/html':
        // A 200 carrying an intermediary's error page — the substitution case.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html><body>502 Bad Gateway</body></html>');
        return;

      case '/envelope':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limit exceeded', code: 'RATE_LIMITED' }));
        return;

      case '/503':
        res.writeHead(503, { 'retry-after': '120', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'maintenance' }));
        return;

      case '/429':
        res.writeHead(429, { 'retry-after': '30' });
        res.end();
        return;

      case '/422':
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'lang not supported' }));
        return;

      case '/slow-body':
        // Headers and half a body, then silence. The client's deadline expires
        // with real bytes already in hand.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"results":[{"title":"par');
        stalled.add(res);
        return;

      case '/reset':
        // Headers, some bytes, then the socket is torn down underneath the
        // response — an upstream crashing or a proxy dropping the connection.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"results":[{"tit');
        setTimeout(() => res.socket?.destroy(), 20);
        return;

      default:
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no such route' }));
    }
  });

  // Raw TCP, because `http.ServerResponse` will not knowingly emit a body
  // shorter than its own `Content-Length`. Announcing 4096 bytes and closing
  // after 24 is the truncation case, provable from the framing alone.
  rawServer = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => openSockets.delete(socket));
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 4096\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          '{"results":[{"title":"',
      );
      setTimeout(() => socket.destroy(), 20);
    });
  });

  await Promise.all([listen(httpServer), listen(rawServer)]);
  httpBase = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  rawBase = `http://127.0.0.1:${(rawServer.address() as AddressInfo).port}`;

  // A port that was open and is now closed — a provider that is down, rather
  // than a port number nobody ever used.
  deadPort = await borrowAndReleasePort();
});

afterAll(async () => {
  for (const res of stalled) res.socket?.destroy();
  for (const socket of openSockets) socket.destroy();
  await Promise.all([close(httpServer), close(rawServer)]);
});

function listen(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

function close(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function borrowAndReleasePort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const { port } = server.address() as AddressInfo;
  await close(server);
  return port;
}

// ---------------------------------------------------------------------------
// Cases that complete at the application layer
// ---------------------------------------------------------------------------

describe('real HTTP responses', () => {
  it('200 with results over the wire → DATA_RESULT', async () => {
    const result = classifyResponse(await probe(`${httpBase}/ok`), POLICY);
    expect(result.responseClass).toBe(ResponseClass.DATA_RESULT);
    expect(result.reason).toBe(ClassificationReason.OK);
  });

  it('200 with a genuinely empty body over the wire → SYSTEM_ERROR', async () => {
    const response = await probe(`${httpBase}/empty`);
    expect(response.status).toBe(200);

    const result = classifyResponse(response, POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.BODY_EMPTY);
    expect(canEverSlash(result.responseClass)).toBe(false);
  });

  it('200 whose body is HTML despite an application/json header → SYSTEM_ERROR', async () => {
    const result = classifyResponse(await probe(`${httpBase}/html`), POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.BODY_NOT_JSON);
  });

  it('200 carrying an error envelope → SYSTEM_ERROR, not a strike', async () => {
    const result = classifyResponse(await probe(`${httpBase}/envelope`), POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.BODY_ERROR_ENVELOPE);
  });

  it('503 with Retry-After over the wire → SYSTEM_ERROR carrying 120s of advice', async () => {
    const result = classifyResponse(await probe(`${httpBase}/503`), POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.UPSTREAM_SERVER_ERROR);
    expect(result.retryAfterMs).toBe(120_000);
  });

  it('429 with Retry-After over the wire → SYSTEM_ERROR carrying 30s of advice', async () => {
    const result = classifyResponse(await probe(`${httpBase}/429`), POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.UPSTREAM_RATE_LIMITED);
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('422 over the wire → REQUEST_ERROR', async () => {
    const result = classifyResponse(await probe(`${httpBase}/422`), POLICY);
    expect(result.responseClass).toBe(ResponseClass.REQUEST_ERROR);
    expect(canEverSlash(result.responseClass)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cases that never complete
// ---------------------------------------------------------------------------

describe('real transport failures', () => {
  it('a timeout part-way through the body → SYSTEM_ERROR, and the partial bytes stay evidence', async () => {
    const response = await probe(`${httpBase}/slow-body`, 250);

    expect(response.transportError?.kind).toBe(TransportErrorKind.TIMEOUT);
    // The bytes really did arrive — this is not a case of "nothing came back".
    expect(response.transportError?.partialBody).toContain('{"results":[{"title":"par');

    const result = classifyResponse(response, POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.TRANSPORT_TIMEOUT);
    // The heart of it: bytes in hand did NOT make this a candidate for a
    // quality judgement, so no verification and no route to the stake.
    expect(canEverSlash(result.responseClass)).toBe(false);
  });

  it('a connection destroyed mid-body → SYSTEM_ERROR', async () => {
    const response = await probe(`${httpBase}/reset`);

    // Chunked, so nothing announced a length: undici reports `terminated` with
    // `UND_ERR_SOCKET: other side closed` underneath it.
    expect(response.transportError?.kind).toBe(TransportErrorKind.CONNECTION_RESET);
    expect(response.transportError?.partialBody).toBe('{"results":[{"tit');

    const result = classifyResponse(response, POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.TRANSPORT_CONNECTION_RESET);
    expect(canEverSlash(result.responseClass)).toBe(false);
  });

  it('a body shorter than its own Content-Length → SYSTEM_ERROR', async () => {
    const response = await probe(rawBase);

    // The framing itself proves the body incomplete, so this is the truncation
    // kind rather than the reset kind:
    // `UND_ERR_RES_CONTENT_LENGTH_MISMATCH`.
    expect(response.transportError?.kind).toBe(TransportErrorKind.BODY_TRUNCATED);

    const result = classifyResponse(response, POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.TRANSPORT_BODY_TRUNCATED);
    expect(canEverSlash(result.responseClass)).toBe(false);
  });

  it('nothing listening on the port → SYSTEM_ERROR', async () => {
    const response = await probe(`http://127.0.0.1:${deadPort}/ok`);

    expect(response.transportError?.kind).toBe(TransportErrorKind.CONNECTION_REFUSED);

    const result = classifyResponse(response, POLICY);
    expect(result.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.reason).toBe(ClassificationReason.TRANSPORT_CONNECTION_REFUSED);
  });

  it('a hostname that does not resolve → SYSTEM_ERROR', async () => {
    // `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve, so
    // this test does not depend on the network being reachable.
    const response = await probe('http://provider.invalid/ok', 3_000);

    expect(response.transportError?.kind).toBe(TransportErrorKind.DNS_FAILURE);
    expect(classifyResponse(response, POLICY).responseClass).toBe(ResponseClass.SYSTEM_ERROR);
  });

  it('prints what the runtime actually threw, for each failure shape', async () => {
    const observed = await Promise.all(
      [
        ['timeout mid-body', () => probe(`${httpBase}/slow-body`, 200)],
        ['socket destroyed mid-body', () => probe(`${httpBase}/reset`)],
        ['content-length mismatch', () => probe(rawBase)],
        ['connection refused', () => probe(`http://127.0.0.1:${deadPort}/ok`)],
        ['dns failure', () => probe('http://provider.invalid/ok', 3_000)],
      ].map(async ([label, run]) => {
        const response = await (run as () => Promise<ProviderResponse>)();
        const { responseClass, reason } = classifyResponse(response, POLICY);
        return {
          case: label as string,
          kind: response.transportError?.kind,
          class: responseClass,
          reason,
          bytesBeforeFailure: response.transportError?.partialBody?.length ?? 0,
          detail: response.transportError?.detail,
        };
      }),
    );

    console.log(`\n${observed.map((o) => JSON.stringify(o)).join('\n')}\n`);

    // Whatever the runtime threw, and however this recogniser labelled it, one
    // thing is not negotiable.
    for (const row of observed) {
      expect(row.class).toBe(ResponseClass.SYSTEM_ERROR);
      expect(canEverSlash(row.class)).toBe(false);
    }
  });
});
