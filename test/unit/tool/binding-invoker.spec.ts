/**
 * The production call path, against real sockets.
 *
 * The mapping engine and the response classifier both shipped with no caller.
 * `EgressBindingInvoker` is the caller, and the thing worth testing about it is
 * precisely the part a mock would assume away: that a request built from a
 * stored mapping arrives at a real server in the shape the mapping described,
 * and that a real socket failure comes back as a value rather than an
 * exception.
 *
 * The DNS/connect seam is the same one `egress-http.client.spec.ts` documents —
 * a public-looking address is faked so the address rules run unmodified, and
 * the already-approved connection lands on a local server.
 */
import { AddressInfo } from 'node:net';
import * as http from 'node:http';

import {
  ClassificationReason,
  ResponseBodyKind,
  ResponseClass,
  TransportErrorKind,
  classifyResponse,
} from '@modules/tool/domain/classification';
import { MappingFault, mappingFaultOf } from '@modules/tool/domain/mapping';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { EgressHttpClient } from '@shared/network/egress';
import { bindingEndpointProtocols } from '@shared/network/egress/egress.policy';
import { AppError } from '@shared/errors/app-errors';

import {
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  buildTool,
  usdc,
} from './helpers/routing-fixtures';

const PROVIDER_ADDRESS = '93.184.216.34';

const lookup = jest.fn(async (hostname: string) => {
  if (hostname.endsWith('.example.com')) return [{ address: PROVIDER_ADDRESS, family: 4 as const }];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

let server: http.Server;
let port: number;
let handler: http.RequestListener;

const openSockets: Array<{ destroy: () => void }> = [];

function invoker(): EgressBindingInvoker {
  return new EgressBindingInvoker(
    new EgressHttpClient(lookup, (target) => ({
      address: '127.0.0.1',
      family: 4,
      port: target.port === 80 ? port : target.port,
    })),
  );
}

interface Received {
  method?: string;
  url?: string;
  body?: string;
  contentType?: string;
  headers?: http.IncomingHttpHeaders;
}

let received: Received;

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
  received = {};
});

/** Records what arrived, then answers with the given status and body. */
function respondWith(status: number, body: string, contentType = 'application/json'): void {
  handler = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: req.headers['content-type'],
        headers: req.headers,
      };
      res.writeHead(status, { 'content-type': contentType });
      res.end(body);
    });
  };
}

describe('EgressBindingInvoker (router call path)', () => {
  const A = 'provider-a';
  const tool = buildTool();
  const binding = buildBinding(A, { endpoint: 'http://provider-a.example.com/api' });

  it('builds the upstream request from the stored mapping', async () => {
    respondWith(200, JSON.stringify({ answer: 'from upstream' }));

    const response = await invoker().invoke({
      tool,
      binding,
      input: { query: 'solar flare' },
      timeoutMs: 2_000,
      callId: 'test-call-id',
    });

    // The endpoint's own path prefix survives, and the mapped path is appended
    // to it rather than replacing it.
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/api/search');
    expect(received.contentType).toBe('application/json');
    expect(JSON.parse(received.body ?? '{}')).toEqual({ q: 'solar flare' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      kind: ResponseBodyKind.JSON,
      value: { answer: 'from upstream' },
    });
  });

  it('sends X-Assay-Call-Id on the upstream request, byte-identical to the invocation', async () => {
    respondWith(200, JSON.stringify({ answer: 'from upstream' }));

    await invoker().invoke({
      tool,
      binding,
      input: { query: 'solar flare' },
      timeoutMs: 2_000,
      callId: 'call-abc-123',
    });

    console.log('Captured upstream headers:', JSON.stringify(received.headers, null, 2));
    expect(received.headers?.['x-assay-call-id']).toBe('call-abc-123');
  });

  it('does not let a binding-supplied header override X-Assay-Call-Id', async () => {
    respondWith(200, JSON.stringify({ answer: 'from upstream' }));

    // A provider's own mapping is untrusted input — a mapping that
    // stamped its own value onto this header would spoof the correlation id
    // the whole feature exists to make unforgeable.
    const spoofingBinding = buildBinding(A, {
      endpoint: 'http://provider-a.example.com/api',
      requestMapping: {
        method: 'POST',
        path: '/search',
        body: { q: { $path: '$.query' } },
        headers: {
          'X-Assay-Call-Id': { $const: 'attacker-supplied-id' },
          'x-assay-call-id': { $const: 'also-attacker' },
        },
      },
    });

    await invoker().invoke({
      tool,
      binding: spoofingBinding,
      input: { query: 'solar flare' },
      timeoutMs: 2_000,
      callId: 'real-call-id',
    });

    expect(received.headers?.['x-assay-call-id']).toBe('real-call-id');
  });

  it('returns a 5xx as a status rather than throwing', async () => {
    respondWith(503, JSON.stringify({ error: 'overloaded' }));

    const response = await invoker().invoke({
      tool,
      binding,
      input: { query: 'x' },
      timeoutMs: 2_000,
      callId: 'test-call-id',
    });

    // Deciding what a 503 *means* is the classifier's job, and an invoker that threw would
    // be pre-empting it by choosing an exception.
    expect(response.status).toBe(503);
    expect(response.transportError).toBeUndefined();
    expect(classifyResponse(response, { toolId: TOOL_ID }).responseClass).toBe(
      ResponseClass.SYSTEM_ERROR,
    );
  });

  it('resolves with a transport error when the provider is too slow', async () => {
    handler = (_req, res) => {
      // Headers never sent. The deadline is the only thing that ends this.
      setTimeout(() => res.end(), 5_000).unref();
    };

    const startedAt = Date.now();
    const response = await invoker().invoke({
      tool,
      binding,
      input: { query: 'x' },
      timeoutMs: 120,
      callId: 'test-call-id',
    });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(response.transportError?.kind).toBe(TransportErrorKind.TIMEOUT);
    expect(classifyResponse(response, { toolId: TOOL_ID }).responseClass).toBe(
      ResponseClass.SYSTEM_ERROR,
    );
  });

  it('lets a mapping fault propagate with its attribution intact', async () => {
    respondWith(200, JSON.stringify({ answer: 'never reached' }));

    const error = await invoker()
      .invoke({ tool, binding, input: {}, timeoutMs: 2_000, callId: 'test-call-id' })
      .then(() => null)
      .catch((e: AppError) => e);

    // The agent omitted a required argument. That is a `REQUEST_ERROR`, and
    // flattening it into a transport failure would make it a `SYSTEM_ERROR`
    // that fails over — spending a second provider on the same bad arguments.
    expect(error?.errorCode).toBe(ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING);
    expect(mappingFaultOf(error)).toBe(MappingFault.AGENT);
  });

  // Review P-6: `encodeURIComponent` leaves `..` alone and `new URL` resolves it.
  it.each(['..', '.', ''])(
    'refuses %j as a path argument instead of leaving the endpoint prefix',
    async (value) => {
      respondWith(200, JSON.stringify({ answer: 'never reached' }));
      const dotted = buildBinding(A, {
        endpoint: 'http://provider-a.example.com/v2/tenants/acme',
        requestMapping: { method: 'GET', path: '/users/{$.query}/profile' },
      });

      const error = await invoker()
        .invoke({
          tool,
          binding: dotted,
          input: { query: value },
          timeoutMs: 2_000,
          callId: 'test-call-id',
        })
        .then(() => null)
        .catch((e: AppError) => e);

      expect(error?.errorCode).toBe(ToolErrorCode.TOOL_MAPPING_TYPE_MISMATCH);
      expect(mappingFaultOf(error)).toBe(MappingFault.AGENT);
      expect(received.url).toBeUndefined();
    },
  );

  it('still sends a path argument that only contains dots', async () => {
    respondWith(200, JSON.stringify({ answer: 'ok' }));
    const dotted = buildBinding(A, {
      endpoint: 'http://provider-a.example.com/v2',
      requestMapping: { method: 'GET', path: '/files/{$.query}' },
    });

    await invoker().invoke({
      tool,
      binding: dotted,
      input: { query: '...' },
      timeoutMs: 2_000,
      callId: 'test-call-id',
    });

    expect(received.url).toBe('/v2/files/...');
  });

  it('never dials a URL whose path left the endpoint prefix', async () => {
    respondWith(200, JSON.stringify({ answer: 'never reached' }));
    const climbing = buildBinding(A, {
      endpoint: 'http://provider-a.example.com/v2/tenants/acme',
      requestMapping: { method: 'GET', path: '/../other' },
    });

    const response = await invoker().invoke({
      tool,
      binding: climbing,
      input: { query: 'x' },
      timeoutMs: 2_000,
      callId: 'test-call-id',
    });

    expect(response.transportError).toBeDefined();
    expect(received.url).toBeUndefined();
  });

  // Review P-8: plaintext binding endpoints in production.
  describe('under NODE_ENV=production', () => {
    const previous = process.env.NODE_ENV;
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });
    afterEach(() => {
      process.env.NODE_ENV = previous;
    });

    it('refuses an http:// binding endpoint before any dial', async () => {
      respondWith(200, JSON.stringify({ answer: 'never reached' }));

      const response = await invoker().invoke({
        tool,
        binding,
        input: { query: 'x' },
        timeoutMs: 2_000,
        callId: 'test-call-id',
      });

      expect(response.transportError).toBeDefined();
      expect(received.url).toBeUndefined();
      expect(bindingEndpointProtocols()).toEqual(['https:']);
      // A reason that tells the provider what to fix, not TRANSPORT_UNKNOWN (I-4).
      expect(response.transportError?.kind).toBe(TransportErrorKind.SCHEME_NOT_ALLOWED);
      expect(classifyResponse(response, { toolId: TOOL_ID })).toMatchObject({
        responseClass: ResponseClass.SYSTEM_ERROR,
        reason: ClassificationReason.TRANSPORT_HTTPS_REQUIRED,
      });
    });
  });

  it('allows http:// binding endpoints outside production, for local stacks', () => {
    expect(bindingEndpointProtocols('test')).toEqual(['http:', 'https:']);
    expect(bindingEndpointProtocols('development')).toEqual(['http:', 'https:']);
  });

  it('fails over between two real endpoints', async () => {
    // Both bindings point at the same local server; the path says which
    // provider the request is for, and the server answers accordingly.
    handler = (req, res) => {
      if (req.url?.startsWith('/a/')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'down' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answer: 'served by b' }));
    };

    const { router } = buildRouter({
      bindings: [
        buildBinding('provider-a', { endpoint: 'http://provider-a.example.com/a' }),
        buildBinding('provider-b', { endpoint: 'http://provider-b.example.com/b' }),
      ],
      providers: [buildProvider('provider-a'), buildProvider('provider-b')],
      stakes: { 'provider-a': usdc(1000), 'provider-b': usdc(1000) },
      invoker: invoker(),
    });

    const result = await router.route({
      toolId: TOOL_ID,
      callId: 'test-call-id',
      input: { query: 'x' },
      context: ROUTING_CONTEXT,
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].classification.responseClass).toBe(ResponseClass.SYSTEM_ERROR);
    expect(result.providerId).toBe('provider-b');
    expect(result.output).toEqual({ answer: 'served by b' });
  });

  it('is the only thing standing between the router and a hostile endpoint', async () => {
    // Not a routing test — a reminder that provider endpoints are typed by
    // strangers (open registration) and go through the SSRF guard. A
    // hostname resolving outside the fake zone never gets a socket.
    const scripted = new ScriptedInvoker({});
    expect(scripted.invocations).toHaveLength(0);

    const response = await invoker().invoke({
      tool,
      binding: buildBinding('provider-x', { endpoint: 'http://provider-x.internal.test/api' }),
      input: { query: 'x' },
      timeoutMs: 2_000,
      callId: 'test-call-id',
    });

    expect(response.transportError?.kind).toBe(TransportErrorKind.DNS_FAILURE);
  });
});
