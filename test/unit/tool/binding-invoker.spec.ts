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
import { BindingAuthMode } from '@modules/tool/ports/tool.types';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { EgressHttpClient } from '@shared/network/egress';
import type { EgressRequest } from '@shared/network/egress/egress-http.client';
import type { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import { ProviderErrors } from '@modules/provider/errors/provider.errors';
import type { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';
import type { SignableRequest } from '@modules/tool/request-auth/signature-base';
import { bindingEndpointProtocols } from '@shared/network/egress/egress.policy';
import { EgressError, EgressFailureKind } from '@shared/network/egress/egress.errors';
import { REDACTED } from '@modules/tool/domain/egress/credential-redaction';
import { AppError } from '@shared/errors/app-errors';

import {
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  buildTool,
  plainInvoker,
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
  return plainInvoker(
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

  it('asks for the egress relay on every provider call', async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
      bytes: 2,
      url: 'http://provider-a.example.com/api/search',
      redirects: 0,
    });
    await plainInvoker({ request } as unknown as EgressHttpClient).invoke({
      tool,
      binding,
      input: { query: 'x' },
      timeoutMs: 2_000,
      callId: 'test-call-id',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].policy.relay).toBe(true);
  });

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

/**
 * Credentials and the Assay signature, against a fake client: what matters
 * here is the exact header set and order handed to `EgressHttpClient`, and what
 * the vault and the signer were asked.
 */
describe('EgressBindingInvoker (credentials and signature)', () => {
  const tool = buildTool();
  const ENDPOINT = 'https://p.test/v1';

  function setup(options: {
    credentials?: Array<{ name: string; value: string }>;
    vaultError?: unknown;
    signerError?: unknown;
    mappingHeaders?: Record<string, { $const: string }>;
    method?: 'GET' | 'POST';
    reply?: { headers?: Record<string, string>; body?: string; contentType?: string };
    transportError?: unknown;
    authMode?: BindingAuthMode;
    omit?: { credentials?: boolean; signature?: boolean; audience?: boolean };
  }) {
    const sent: EgressRequest[] = [];
    const http = {
      request: jest.fn(async (req: EgressRequest) => {
        sent.push(req);
        if (options.transportError) throw options.transportError;
        const body = options.reply?.body ?? '{"answer":"ok"}';
        return {
          status: 200,
          headers: {
            'content-type': options.reply?.contentType ?? 'application/json',
            ...options.reply?.headers,
          },
          body,
          bytes: body.length,
          url: req.url,
          redirects: 0,
        };
      }),
    } as unknown as EgressHttpClient;

    const vault = {
      headersFor: jest.fn(async () => {
        if (options.vaultError) throw options.vaultError;
        return options.credentials ?? [];
      }),
    };

    const signed: SignableRequest[] = [];
    const signer = {
      sign: jest.fn(async (req: SignableRequest, _audience: string) => {
        if (options.signerError) throw options.signerError;
        signed.push(req);
        return {
          ...(req.body === undefined ? {} : { 'Content-Digest': 'sha-256=:digest:' }),
          'Signature-Input': 'assay=("@method");keyid="k"',
          Signature: 'assay=:sig:',
        };
      }),
    };

    const binding = buildBinding('provider-p', {
      endpoint: ENDPOINT,
      // Signature mode unless a test says otherwise: most of these pin the
      // signed request. `authMode: undefined` passed explicitly means unset.
      authMode: 'authMode' in options ? options.authMode : BindingAuthMode.SIGNATURE,
      requestMapping:
        options.method === 'GET'
          ? {
              method: 'GET',
              path: '/search',
              query: { q: { $path: '$.query' } },
              headers: options.mappingHeaders,
            }
          : {
              method: 'POST',
              path: '/search',
              body: { q: { $path: '$.query' } },
              headers: options.mappingHeaders,
            },
    });

    const subject = new EgressBindingInvoker(
      http,
      vault as unknown as CredentialVaultService,
      signer as unknown as RequestSignerService,
    );
    const run = () =>
      subject.invoke({
        tool,
        binding,
        input: { query: 'q' },
        timeoutMs: 2_000,
        callId: 'call-1',
        omit: options.omit,
      });
    return { run, sent, signed, vault, signer, http, binding };
  }

  /** Lower-cased header names, in the order the invoker built them. */
  const names = (req: EgressRequest) => Object.keys(req.headers ?? {});
  const lower = (req: EgressRequest) =>
    Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

  it('sends the vault credential headers', async () => {
    const { run, sent } = setup({ credentials: [{ name: 'Authorization', value: 'Bearer k' }] });
    await run();
    expect(lower(sent[0]).authorization).toBe('Bearer k');
  });

  it('asks the vault for exactly the endpoint origin, as the binding provider', async () => {
    const { run, vault, binding } = setup({});
    await run();
    expect(vault.headersFor).toHaveBeenCalledWith(binding.providerId, binding.id, 'https://p.test');
  });

  it('lets a vault header override a mapping header case-insensitively', async () => {
    const { run, sent } = setup({
      credentials: [{ name: 'x-key', value: 'v' }],
      mappingHeaders: { 'X-Key': { $const: 'm' } },
    });
    await run();
    const headers = sent[0].headers ?? {};
    const keys = Object.keys(headers).filter((k) => k.toLowerCase() === 'x-key');
    expect(keys).toHaveLength(1);
    expect(headers[keys[0]]).toBe('v');
  });

  it('keeps x-assay-call-id un-overridable by the vault', async () => {
    const { run, sent } = setup({
      credentials: [{ name: 'X-Assay-Call-Id', value: 'forged' }],
    });
    await run();
    const headers = sent[0].headers ?? {};
    const keys = Object.keys(headers).filter((k) => k.toLowerCase() === 'x-assay-call-id');
    expect(keys).toEqual(['x-assay-call-id']);
    expect(headers['x-assay-call-id']).toBe('call-1');
  });

  it('adds signature, signature-input and content-digest to a POST', async () => {
    const { run, sent } = setup({});
    await run();
    const headers = lower(sent[0]);
    expect(headers.signature).toBe('assay=:sig:');
    expect(headers['signature-input']).toBe('assay=("@method");keyid="k"');
    expect(headers['content-digest']).toBe('sha-256=:digest:');
  });

  it('adds no content-digest to a GET', async () => {
    const { run, sent, signed } = setup({ method: 'GET' });
    await run();
    expect(signed[0].body).toBeUndefined();
    expect(lower(sent[0])['content-digest']).toBeUndefined();
    expect(lower(sent[0]).signature).toBe('assay=:sig:');
  });

  it('orders headers: defaults, mapping, credentials, call id, signature', async () => {
    const { run, sent } = setup({
      credentials: [{ name: 'Authorization', value: 'Bearer k' }],
      mappingHeaders: { 'X-Mapped': { $const: 'm' } },
    });
    await run();
    expect(names(sent[0])).toEqual([
      'accept',
      'content-type',
      'x-mapped',
      'authorization',
      'x-assay-call-id',
      'content-digest',
      'signature-input',
      'signature',
    ]);
  });

  it('signs the final URL, method, headers and body that are sent', async () => {
    const { run, sent, signed } = setup({
      credentials: [{ name: 'Authorization', value: 'Bearer k' }],
    });
    await run();
    expect(signed).toHaveLength(1);
    expect(signed[0].url).toBe(sent[0].url);
    expect(signed[0].method).toBe(sent[0].method);
    expect(signed[0].body).toBe(sent[0].body);
    expect(signed[0].headers).toMatchObject({
      authorization: 'Bearer k',
      'x-assay-call-id': 'call-1',
    });
    expect(sent[0].url).toBe('https://p.test/v1/search');
  });

  it('turns a vault failure into a platform-fault transport error and never dials', async () => {
    const { run, http, signer } = setup({
      vaultError: ProviderErrors.credentialVaultUnavailable({ reason: 'key not loaded' }),
    });
    const response = await run();
    expect(http.request).not.toHaveBeenCalled();
    expect(signer.sign).not.toHaveBeenCalled();
    expect(response.status).toBe(0);
    expect(response.transportError?.kind).toBe(TransportErrorKind.PLATFORM_UNAVAILABLE);
    expect(classifyResponse(response, { toolId: TOOL_ID })).toMatchObject({
      responseClass: ResponseClass.SYSTEM_ERROR,
      reason: ClassificationReason.PLATFORM_UNAVAILABLE,
    });
  });

  describe('API-key bindings without credentials for the origin', () => {
    it.each([BindingAuthMode.API_KEY, BindingAuthMode.BOTH])(
      '%s: platform fault with the fixed detail, nothing dialled',
      async (authMode) => {
        const { run, http, signer } = setup({ authMode });
        const response = await run();
        expect(http.request).not.toHaveBeenCalled();
        expect(signer.sign).not.toHaveBeenCalled();
        expect(response.transportError?.kind).toBe(TransportErrorKind.PLATFORM_UNAVAILABLE);
        expect(response.transportError?.detail).toBe('credentials missing for this address');
        expect(classifyResponse(response, { toolId: TOOL_ID })).toMatchObject({
          responseClass: ResponseClass.SYSTEM_ERROR,
          reason: ClassificationReason.PLATFORM_UNAVAILABLE,
        });
      },
    );
    it('dials when the set exists', async () => {
      const { run, http } = setup({
        authMode: BindingAuthMode.API_KEY,
        credentials: [{ name: 'X-Key', value: 'k' }],
      });
      await run();
      expect(http.request).toHaveBeenCalled();
    });
    it.each([BindingAuthMode.NONE, BindingAuthMode.SIGNATURE, undefined])(
      'dials without credentials when the mode is %s',
      async (authMode) => {
        const { run, http } = setup({ authMode });
        await run();
        expect(http.request).toHaveBeenCalled();
      },
    );
    it.each([BindingAuthMode.NONE, BindingAuthMode.SIGNATURE])(
      'still reads the vault and attaches a stored set when the mode is %s',
      async (authMode) => {
        const { run, sent, vault } = setup({
          authMode,
          credentials: [{ name: 'X-Key', value: 'stored-under-any-mode' }],
        });
        await run();
        expect(vault.headersFor).toHaveBeenCalledTimes(1);
        expect(lower(sent[0])['x-key']).toBe('stored-under-any-mode');
      },
    );
    it('still lets the tester omit credentials on purpose', async () => {
      const { run, http } = setup({
        authMode: BindingAuthMode.API_KEY,
        omit: { credentials: true },
      });
      await run();
      expect(http.request).toHaveBeenCalled();
    });
  });

  it('keeps raw error text out of the detail when the vault throws a non-AppError', async () => {
    const { run } = setup({ vaultError: new Error('connection to 10.0.0.5 refused') });
    const response = await run();
    expect(response.transportError?.kind).toBe(TransportErrorKind.PLATFORM_UNAVAILABLE);
    expect(response.transportError?.detail).toBe('credential lookup failed');
    expect(response.transportError?.detail).not.toContain('10.0.0.5');
  });

  describe('the signature audience (aud)', () => {
    it('signs for the binding’s own provider, never anyone else', async () => {
      const { run, signer } = setup({});
      await run();
      expect(signer.sign).toHaveBeenCalledTimes(1);
      expect(signer.sign.mock.calls[0][1]).toBe('provider-p');
    });

    it.each([BindingAuthMode.SIGNATURE, BindingAuthMode.BOTH])(
      'signs a %s binding',
      async (authMode) => {
        const { run, signer } = setup({ authMode, credentials: [{ name: 'X-Key', value: 'k' }] });
        await run();
        expect(signer.sign).toHaveBeenCalledTimes(1);
      },
    );

    it.each([BindingAuthMode.API_KEY, BindingAuthMode.NONE, undefined])(
      'does not sign a %s binding: the signature protects nothing there',
      async (authMode) => {
        const { run, signer, sent } = setup({
          authMode,
          credentials: [{ name: 'X-Key', value: 'k' }],
        });
        await run();
        expect(signer.sign).not.toHaveBeenCalled();
        expect(lower(sent[0])['signature']).toBeUndefined();
        expect(lower(sent[0])['signature-input']).toBeUndefined();
      },
    );

    it('signs the tester’s probe for a random foreign audience', async () => {
      const { run, signer } = setup({ omit: { audience: true } });
      await run();
      const audience = signer.sign.mock.calls[0][1];
      expect(audience).toMatch(/^probe-[0-9a-f-]{36}$/);
      expect(audience).not.toBe('provider-p');
    });
  });

  it('keeps raw error text out of the detail when the signer throws a non-AppError', async () => {
    const { run } = setup({ signerError: new Error('key file /secrets/ed25519 unreadable') });
    const response = await run();
    expect(response.transportError?.detail).toBe('request signing failed');
  });

  it('keeps the fixed message of an AppError', async () => {
    const error = ProviderErrors.credentialVaultUnavailable({ reason: 'key not loaded' });
    const { run } = setup({ vaultError: error });
    const response = await run();
    expect(response.transportError?.detail).toBe(error.message);
  });

  describe('echoed credentials', () => {
    const KEY = 'sk-example-0123456789abcdef';
    const b64 = (text: string) => Buffer.from(text).toString('base64');

    it('redacts the values from the JSON body and the headers before returning', async () => {
      const { run } = setup({
        credentials: [{ name: 'X-Api-Key', value: KEY }],
        reply: {
          headers: { 'x-echo': KEY },
          body: JSON.stringify({ got: KEY, b64: b64(KEY), pct: encodeURIComponent(KEY) }),
        },
      });
      const response = await run();
      expect(JSON.stringify(response)).not.toContain(KEY);
      expect(JSON.stringify(response)).not.toContain(b64(KEY).slice(0, 12));
      expect(response.headers?.['x-echo']).toBe(REDACTED);
      expect(response.body).toEqual({
        kind: ResponseBodyKind.JSON,
        value: { got: REDACTED, b64: REDACTED, pct: REDACTED },
      });
    });

    it('redacts a non-JSON body', async () => {
      const { run } = setup({
        credentials: [{ name: 'X-Api-Key', value: KEY }],
        reply: { body: `<pre>key=${KEY.toUpperCase()}</pre>`, contentType: 'text/html' },
      });
      const response = await run();
      expect(JSON.stringify(response)).not.toMatch(/sk-example/i);
    });

    it('redacts a transport failure: detail and partial body', async () => {
      const { run } = setup({
        credentials: [{ name: 'X-Api-Key', value: KEY }],
        transportError: new EgressError(EgressFailureKind.TIMEOUT, `stalled after ${KEY}`, {
          partialBody: `{"echo":"${KEY}`,
        }),
      });
      const response = await run();
      expect(response.transportError?.kind).toBe(TransportErrorKind.TIMEOUT);
      expect(JSON.stringify(response)).not.toContain(KEY);
    });

    it('leaves the response untouched when there are no credentials', async () => {
      const { run } = setup({ reply: { body: JSON.stringify({ got: KEY }) } });
      const response = await run();
      expect(response.body).toEqual({ kind: ResponseBodyKind.JSON, value: { got: KEY } });
    });
  });

  describe('x-assay-* mapping headers', () => {
    it('drops every mapping header in the x-assay- namespace and keeps the call id', async () => {
      const { run, sent, signed } = setup({
        mappingHeaders: {
          'X-Assay-Agent': { $const: 'forged' },
          'x-assay-timestamp': { $const: '1' },
          'X-Assay-Call-Id': { $const: 'forged' },
          'X-Kept': { $const: 'k' },
        },
      });
      await run();
      const headers = lower(sent[0]);
      expect(Object.keys(headers).filter((k) => k.startsWith('x-assay-'))).toEqual([
        'x-assay-call-id',
      ]);
      expect(headers['x-assay-call-id']).toBe('call-1');
      expect(headers['x-kept']).toBe('k');
      expect(signed[0].headers['x-assay-agent']).toBeUndefined();
    });
  });

  describe('outbound header size cap', () => {
    it('refuses to dial when mapping + credentials + Assay headers exceed 8 KiB', async () => {
      const { run, http } = setup({
        credentials: [
          { name: 'X-A', value: 'a'.repeat(4000) },
          { name: 'X-B', value: 'b'.repeat(4000) },
        ],
        mappingHeaders: { 'X-Mapped': { $const: 'm'.repeat(200) } },
      });
      const response = await run();
      expect(http.request).not.toHaveBeenCalled();
      expect(response.status).toBe(0);
      expect(response.transportError).toEqual({
        kind: TransportErrorKind.PLATFORM_UNAVAILABLE,
        partialBody: null,
        detail: 'outbound request headers exceed 8 KiB',
      });
    });

    it('dials when the total is within the cap', async () => {
      const { run, http } = setup({
        credentials: [{ name: 'X-A', value: 'a'.repeat(4000) }],
        mappingHeaders: { 'X-Mapped': { $const: 'm'.repeat(2000) } },
      });
      await run();
      expect(http.request).toHaveBeenCalledTimes(1);
    });
  });
});
