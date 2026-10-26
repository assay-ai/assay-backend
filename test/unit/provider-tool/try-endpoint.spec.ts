import {
  TryParseError,
  TryWarningCode,
  exampleOf,
  inferSchema,
  isCredentialName,
  outputOf,
  planFromCurl,
  planFromOpenApi,
  shellWords,
} from '@modules/provider-tool/domain/try-endpoint';
import { ProviderToolTryService } from '@modules/provider-tool/services/provider-tool-try.service';
import { ResponseBodyKind } from '@modules/tool/domain/classification';
import { BindingInvocation } from '@modules/tool/ports/binding-invoker.port';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { EgressError, EgressFailureKind } from '@shared/network/egress';

const problemsOf = (work: () => unknown): readonly string[] => {
  try {
    work();
  } catch (error) {
    if (error instanceof TryParseError) return error.problems;
    throw error;
  }
  return [];
};

describe('Try your endpoint: parsing (design spec §7.10)', () => {
  it('splits a shell command line: quotes, escapes, line continuations', () => {
    expect(shellWords(`curl -H 'A: b c' \\\n  "https://x.example/?q=\\"1\\""`)).toEqual([
      'curl',
      '-H',
      'A: b c',
      'https://x.example/?q="1"',
    ]);
    expect(problemsOf(() => shellWords(`curl 'unclosed`))).toHaveLength(1);
  });

  it('keeps the path of a pasted curl in the endpoint (onboarding run 3: /latest)', () => {
    const plan = planFromCurl(`curl 'https://api.frankfurter.app/latest?from=GBP&to=JPY'`);
    expect(plan).toMatchObject({
      method: 'GET',
      url: 'https://api.frankfurter.app/latest?from=GBP&to=JPY',
      endpoint: 'https://api.frankfurter.app/latest',
      arguments: { from: 'GBP', to: 'JPY' },
      requestMapping: { method: 'GET', query: { from: '$.from', to: '$.to' } },
    });
    expect(plan.requestMapping).not.toHaveProperty('path');
  });

  it('reads a GET with a query: inputs from the query, a credential header kept out', () => {
    const plan = planFromCurl(
      `curl -sS -H 'Authorization: Bearer sk_live_abcdef123456' -H 'X-Version: 2' ` +
        `'https://api.example.com/v1/search?q=solana&limit=5'`,
    );
    expect(plan).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/v1/search?q=solana&limit=5',
      endpoint: 'https://api.example.com/v1/search',
      arguments: { q: 'solana', limit: '5' },
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'string' } },
        required: ['q', 'limit'],
      },
      requestMapping: {
        method: 'GET',
        query: { q: '$.q', limit: '$.limit' },
        headers: { 'x-version': { $const: '2' } },
      },
    });
    expect(plan.headers.authorization).toBe('Bearer sk_live_abcdef123456');
    expect(plan.secrets).toEqual(
      expect.arrayContaining(['Bearer sk_live_abcdef123456', 'sk_live_abcdef123456']),
    );
    expect(JSON.stringify(plan.requestMapping)).not.toContain('sk_live');
    expect(JSON.stringify(plan.inputSchema)).not.toContain('authorization');
    expect(plan.warnings.map((warning) => warning.code)).toContain(
      TryWarningCode.CREDENTIAL_DETECTED,
    );
  });

  it('reads a POST with a JSON body; a query credential is sent, masked and not an input', () => {
    const plan = planFromCurl(
      `curl -X POST 'https://api.example.com/search?api_key=secret123456' ` +
        `--json '{"query":"solana","limit":5,"filters":{"lang":"en"}}'`,
    );
    expect(plan).toMatchObject({
      method: 'POST',
      body: { query: 'solana', limit: 5, filters: { lang: 'en' } },
      arguments: { query: 'solana', limit: 5, filters: { lang: 'en' } },
      inputSchema: {
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
          filters: { type: 'object', properties: { lang: { type: 'string' } } },
        },
      },
      requestMapping: { body: { query: '$.query', limit: '$.limit', filters: '$.filters' } },
      secretQueryNames: ['api_key'],
    });
    expect(plan.headers['content-type']).toBe('application/json');
    expect(plan.arguments).not.toHaveProperty('api_key');
    expect(plan.secrets).toContain('secret123456');
  });

  it('turns -G data into the query and -u into Basic auth', () => {
    const plan = planFromCurl(`curl -G -d q=a+b -d n=1 -u me:pw123456789 https://x.example/s`);
    expect(plan.url).toBe('https://x.example/s?q=a+b&n=1');
    expect(plan.arguments).toEqual({ q: 'a b', n: '1' });
    expect(plan.headers.authorization).toMatch(/^Basic /);
    expect(plan.secrets).toContain('pw123456789');
  });

  it('drops transport headers and the platform namespace', () => {
    const plan = planFromCurl(
      `curl -H 'Host: evil.example' -H 'X-Assay-Call-Id: spoof' -H 'Content-Length: 3' https://x.example/`,
    );
    expect(Object.keys(plan.headers)).toEqual([]);
  });

  it('refuses what it cannot try', () => {
    for (const [command, pattern] of [
      [`curl -X PUT https://x.example/`, /only GET and POST/],
      [`curl -d @body.json https://x.example/`, /from a file/],
      [`curl -d 'a=1' https://x.example/`, /not JSON/],
      [`curl -d '[1]' https://x.example/`, /JSON object/],
      [`curl ftp://x.example/`, /only http/],
      [`curl https://user:pw@x.example/`, /user name or password/],
      [`curl --proxy http://p https://x.example/`, /not supported/],
      [`curl -H Bad https://x.example/`, /Name: value/],
      [`curl -s`, /no URL/],
    ] as const) {
      expect(problemsOf(() => planFromCurl(command)).join(' ')).toMatch(pattern);
    }
    expect(problemsOf(() => planFromCurl('x'.repeat(16 * 1024 + 1)))).toHaveLength(1);
  });

  it('reads credential names conservatively', () => {
    for (const name of ['authorization', 'Cookie', 'x-api-key', 'api_key', 'apikey', 'token']) {
      expect(isCredentialName(name)).toBe(true);
    }
    for (const name of ['q', 'query', 'author', 'monkey', 'limit', 'keyword']) {
      expect(isCredentialName(name)).toBe(false);
    }
  });
});

const OPENAPI = JSON.stringify({
  openapi: '3.0.3',
  servers: [{ url: 'https://api.example.com/{v}', variables: { v: { default: 'v2' } } }],
  security: [{ key: [] }],
  paths: {
    '/cities/{cityId}/weather': {
      parameters: [{ $ref: '#/components/parameters/CityId' }],
      get: {
        operationId: 'getWeather',
        parameters: [
          { name: 'units', in: 'query', schema: { type: 'string', default: 'metric' } },
          { name: 'X-Key', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Weather' } } },
          },
        },
      },
    },
    '/search': {
      post: {
        operationId: 'search',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { q: { type: 'string' }, limit: { type: 'integer', default: 10 } },
                required: ['q'],
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
  components: {
    parameters: {
      CityId: { name: 'cityId', in: 'path', required: true, schema: { type: 'string' } },
    },
    schemas: {
      Weather: {
        type: 'object',
        properties: { tempC: { type: 'number' }, xml: { type: 'string' } },
        required: ['tempC'],
      },
    },
  },
});

describe('Try your endpoint: OpenAPI', () => {
  it('names the operation when there is more than one', () => {
    expect(problemsOf(() => planFromOpenApi(OPENAPI)).join(' ')).toMatch(/getWeather, search/);
    expect(problemsOf(() => planFromOpenApi(OPENAPI, { operationId: 'nope' })).join(' ')).toMatch(
      /no GET or POST operation "nope"/,
    );
  });

  it('resolves refs, server variables and path templates; waits for a missing value', () => {
    const missing = planFromOpenApi(OPENAPI, { operationId: 'getWeather' });
    expect(missing.runnable).toBe(false);
    expect(missing.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        TryWarningCode.MISSING_TEST_VALUES,
        TryWarningCode.AUTH_REQUIRED,
        TryWarningCode.NOT_SUPPORTED,
      ]),
    );

    const plan = planFromOpenApi(OPENAPI, {
      operationId: 'getWeather',
      input: { cityId: 'paris' },
      headers: { 'X-Key': 'k_1234567890' },
    });
    expect(plan).toMatchObject({
      runnable: true,
      method: 'GET',
      url: 'https://api.example.com/v2/cities/paris/weather?units=metric',
      endpoint: 'https://api.example.com/v2',
      operationId: 'getWeather',
      arguments: { cityId: 'paris', units: 'metric' },
      inputSchema: { required: ['cityId'] },
      outputSchema: { type: 'object', properties: { tempC: { type: 'number' } } },
      requestMapping: {
        method: 'GET',
        path: '/cities/{$.cityId}/weather',
        query: { units: '$.units' },
      },
    });
    expect(plan.headers['x-key']).toBe('k_1234567890');
    expect(plan.secrets).toContain('k_1234567890');
    expect(JSON.stringify(plan.requestMapping)).not.toContain('k_1234567890');
  });

  it('maps a JSON body’s properties as inputs', () => {
    const plan = planFromOpenApi(OPENAPI, { operationId: 'search', input: { q: 'solana' } });
    expect(plan).toMatchObject({
      method: 'POST',
      body: { q: 'solana', limit: 10 },
      requestMapping: { body: { q: '$.q', limit: '$.limit' } },
      inputSchema: { required: ['q'] },
    });
  });

  it('refuses what is not OpenAPI 3', () => {
    expect(problemsOf(() => planFromOpenApi('swagger: "2.0"')).join(' ')).toMatch(/OpenAPI 3/);
    expect(problemsOf(() => planFromOpenApi(': : :')).length).toBe(1);
  });
});

describe('Try your endpoint: inference', () => {
  it('infers a schema; arrays merge their objects', () => {
    expect(inferSchema({ items: [{ a: 1, b: 'x' }, { a: 2.5 }], ok: true })).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { a: { type: 'integer' }, b: { type: 'string' } },
            required: ['a'],
          },
        },
        ok: { type: 'boolean' },
      },
      required: ['items', 'ok'],
    });
  });

  it('wraps a non-object answer as `result`', () => {
    expect(outputOf([1, 2], null)).toEqual({
      outputSchema: {
        type: 'object',
        properties: { result: { type: 'array', items: { type: 'integer' } } },
        required: ['result'],
      },
      responseMapping: { result: { $path: '$' } },
    });
    expect(outputOf({ a: 1 }, null).responseMapping).toEqual({ a: '$.a' });
  });

  it('keeps the example inside 2 KB', () => {
    expect(exampleOf({ q: 'a' }, { posts: [] })).toEqual({
      example: { arguments: { q: 'a' }, result: { posts: [] } },
      trimmed: false,
    });
    expect(exampleOf({ q: 'a' }, { blob: 'x'.repeat(3000) })).toEqual({
      example: { arguments: { q: 'a' } },
      trimmed: true,
    });
  });
});

describe('ProviderToolTryService', () => {
  const ORG = '00000000-0000-4000-8000-000000000001';
  const active = { findOne: async () => ({ organizationId: ORG, status: 'ACTIVE' }) } as never;
  const SESSION = { organizationId: ORG, credentialId: 'login', callerKind: 'HUMAN' } as never;
  let limited = 0;
  const limiter = {
    run: (_org: string, work: () => Promise<unknown>) => {
      limited += 1;
      return work();
    },
  } as never;
  const audited: Array<Record<string, unknown>> = [];
  const audit = {
    recordAfterCommit: async (entry: Record<string, unknown>) => {
      audited.push(entry);
    },
  } as never;
  /** The org's bindings: the origins a try run is signed towards. */
  let ownEndpoints: string[] = ['https://api.example.com/v1'];
  const bindings = {
    find: async () => ownEndpoints.map((endpoint) => ({ id: 'b', endpoint })),
  } as never;
  beforeEach(() => {
    audited.length = 0;
    limited = 0;
    ownEndpoints = ['https://api.example.com/v1'];
  });

  function serviceWith(answer: (call: BindingInvocation) => unknown, providers = active) {
    const calls: BindingInvocation[] = [];
    const invoker = {
      invoke: async (call: BindingInvocation) => {
        calls.push(call);
        return answer(call);
      },
    };
    return {
      service: new ProviderToolTryService(providers, bindings, limiter, audit, invoker as never),
      calls,
    };
  }

  it('sends through the invoker with signing on, redacts echoes, and infers the draft', async () => {
    const { service, calls } = serviceWith(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        kind: ResponseBodyKind.JSON,
        value: { posts: [{ id: 1 }], echo: 'Bearer sk_live_abcdef123456' },
      },
    }));
    const result = await service.try(SESSION, {
      curl: `curl -H 'Authorization: Bearer sk_live_abcdef123456' 'https://api.example.com/s?q=x&token=tok_9876543210'`,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    // api.example.com is one of the org's binding origins: signed.
    expect(call.omit).toEqual({ credentials: true, signature: false });
    expect(audited).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        action: 'provider_tool.try_run',
        resourceId: 'https://api.example.com',
        after: {
          origin: 'https://api.example.com',
          method: 'GET',
          callId: call.callId,
          signed: true,
          source: 'CURL',
        },
      }),
    ]);
    expect(JSON.stringify(audited)).not.toMatch(/sk_live|tok_98/);
    expect(call.binding.endpoint).toBe('https://api.example.com/s');
    expect(call.input).toEqual({});
    expect(result).toMatchObject({
      source: 'CURL',
      ran: true,
      passed: true,
      request: {
        method: 'GET',
        url: 'https://api.example.com/s?q=x&token=***',
        headerNames: ['authorization'],
      },
      upstream: { status: 200, bodyKind: 'JSON' },
      inferred: {
        endpoint: 'https://api.example.com/s',
        inputSchema: { properties: { q: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { posts: { type: 'array' } } },
        responseMapping: { posts: '$.posts', echo: '$.echo' },
      },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('sk_live_abcdef123456');
    expect(text).not.toContain('tok_9876543210');
  });

  it('reports a failed answer without inferring an output', async () => {
    const { service } = serviceWith(() => ({
      status: 0,
      body: { kind: ResponseBodyKind.EMPTY },
      transportError: { kind: 'TIMEOUT', detail: 'took too long' },
    }));
    const result = await service.try(SESSION, { curl: 'curl https://api.example.com/s' });
    expect(result).toMatchObject({
      ran: true,
      passed: false,
      upstream: { status: 0, transportError: { kind: 'TIMEOUT' } },
      inferred: { outputSchema: null, responseMapping: null },
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('NO_JSON_RESPONSE');
  });

  it('refuses private addresses before dialling, non-providers, and two sources at once', async () => {
    const { service, calls } = serviceWith(() => {
      throw new Error('must not dial');
    });
    for (const url of [
      'http://127.0.0.1/x',
      'http://10.0.0.8/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://localhost:3000/x',
      'http://api.localhost/x',
    ]) {
      await expect(service.try(SESSION, { curl: `curl ${url}` })).rejects.toMatchObject({
        errorCode: 'TOOL_PROVIDER_TOOL_INVALID',
      });
    }
    await expect(
      service.try(SESSION, { curl: 'curl https://a.example/', openapi: '{}' }),
    ).rejects.toMatchObject({ errorCode: 'TOOL_PROVIDER_TOOL_INVALID' });
    const buyer = serviceWith(() => null, { findOne: async () => null } as never);
    await expect(
      buyer.service.try(SESSION, { curl: 'curl https://a.example/' }),
    ).rejects.toMatchObject({ errorCode: 'TOOL_PROVIDER_TOOL_NOT_ALLOWED' });
    expect(calls).toHaveLength(0);
  });

  it('does not send a plan with missing required values', async () => {
    const { service, calls } = serviceWith(() => {
      throw new Error('must not dial');
    });
    const result = await service.try(SESSION, { openapi: OPENAPI, operationId: 'getWeather' });
    expect(result).toMatchObject({ ran: false, passed: false, upstream: null });
    expect(result.inferred.outputSchema).toMatchObject({ properties: { tempC: {} } });
    expect(calls).toHaveLength(0);
  });

  it('on the production invoker: the exact request, signed, under the untrusted relay policy', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const http = {
      request: async (request: Record<string, unknown>) => {
        sent.push(request);
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}',
        };
      },
    };
    const vault = {
      headersFor: async () => {
        throw new Error('the vault is never read');
      },
    };
    const signer = {
      sign: async () => ({ signature: 'sig1=:abc:', 'signature-input': 'sig1=()' }),
    };
    const invoker = new EgressBindingInvoker(http as never, vault as never, signer as never);
    const service = new ProviderToolTryService(active, bindings, limiter, audit, invoker);
    const result = await service.try(SESSION, {
      curl: `curl -X POST -H 'X-Api-Key: key_abcdefgh1234' 'https://api.example.com/v1/s?q=a' -d '{"n":1}'`,
    });
    expect(result.passed).toBe(true);
    expect(sent).toHaveLength(1);
    const request = sent[0] as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      policy: { relay: boolean; trust?: string };
    };
    expect(request).toMatchObject({
      url: 'https://api.example.com/v1/s?q=a',
      method: 'POST',
      body: '{"n":1}',
    });
    expect(request.headers).toMatchObject({
      'x-api-key': 'key_abcdefgh1234',
      signature: 'sig1=:abc:',
      'content-type': 'application/json',
    });
    expect(request.headers['x-assay-call-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.policy.relay).toBe(true);
  });

  it('answers a name that does not resolve exactly as one that resolves to a private address', async () => {
    const refusals = [
      new EgressError(
        EgressFailureKind.DNS_FAILED,
        'no-such-host.internal did not resolve: getaddrinfo ENOTFOUND no-such-host.internal',
        {
          url: 'https://no-such-host.internal/',
          cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
        },
      ),
      new EgressError(
        EgressFailureKind.BLOCKED_ADDRESS,
        'the host resolves to a non-public address',
        {
          url: 'https://redis-e2e/',
          address: '172.18.0.4',
        },
      ),
    ];
    const answers: unknown[] = [];
    for (const refusal of refusals) {
      const http = {
        request: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw refusal;
        },
      };
      const invoker = new EgressBindingInvoker(http as never, {} as never, {} as never);
      const service = new ProviderToolTryService(active, bindings, limiter, audit, invoker);
      const result = await service.try(SESSION, { curl: 'curl https://some-host.example/' });
      answers.push({ ...result, ranAt: null });
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({
      ran: true,
      passed: false,
      upstream: { status: 0, latencyMs: 0, transportError: { kind: 'DNS_FAILURE' } },
    });
    expect(JSON.stringify(answers)).not.toMatch(/ENOTFOUND|non-public address|172\.18|redis-e2e/);
  });

  it('sends unsigned, and says so, to an origin that is none of the org’s bindings', async () => {
    const { service, calls } = serviceWith(() => ({
      status: 200,
      body: { kind: ResponseBodyKind.JSON, value: { ok: true } },
    }));
    const result = await service.try(SESSION, { curl: 'curl https://other-provider.example/v1/s' });
    expect(calls[0].omit).toEqual({ credentials: true, signature: true });
    expect(result.warnings.map((warning) => warning.code)).toContain('UNSIGNED_FOREIGN_ORIGIN');
    expect(audited).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ origin: 'https://other-provider.example', signed: false }),
      }),
    ]);
    // Same host, another port: another origin.
    ownEndpoints = ['https://other-provider.example:8443/v1'];
    await service.try(SESSION, { curl: 'curl https://other-provider.example/v1/s' });
    expect(calls[1].omit?.signature).toBe(true);
  });

  it('refuses headers, input or operationId beside a curl command', async () => {
    const { service, calls } = serviceWith(() => null);
    for (const extra of [{ headers: { a: 'b' } }, { input: { q: 1 } }, { operationId: 'x' }]) {
      await expect(
        service.try(SESSION, { curl: 'curl https://api.example.com/v1', ...extra }),
      ).rejects.toMatchObject({ errorCode: 'TOOL_PROVIDER_TOOL_INVALID' });
    }
    expect(calls).toHaveLength(0);
  });

  it('parses inside the limiter slot', async () => {
    const { service } = serviceWith(() => null);
    await expect(
      service.try(SESSION, { curl: 'curl -X PUT https://a.example/' }),
    ).rejects.toMatchObject({
      errorCode: 'TOOL_PROVIDER_TOOL_INVALID',
    });
    expect(limited).toBe(1);
  });
});

describe('Try your endpoint: hostile OpenAPI documents (security review P0)', () => {
  const props = (ref: string) =>
    Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, { $ref: ref }]));
  const doc = (schemas: Record<string, unknown>, root: string) =>
    JSON.stringify({
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/x': {
          get: {
            operationId: 'x',
            responses: {
              '200': { content: { 'application/json': { schema: { $ref: root } } } },
            },
          },
        },
      },
      components: { schemas },
    });

  it('a self-referring schema (A.p0..p99 → A) finishes at once: the cycle is cut', () => {
    const text = doc(
      { A: { type: 'object', properties: props('#/components/schemas/A') } },
      '#/components/schemas/A',
    );
    expect(text.length).toBeLessThan(8 * 1024);
    const started = Date.now();
    const plan = planFromOpenApi(text);
    expect(Date.now() - started).toBeLessThan(500);
    expect((plan.outputSchema as { properties: Record<string, unknown> }).properties.p0).toEqual(
      {},
    );
  });

  it('a chain that would expand to 100^8 nodes is refused within the node budget', () => {
    const schemas: Record<string, unknown> = { B8: { type: 'string' } };
    for (let i = 0; i < 8; i += 1) {
      schemas[`B${i}`] = { type: 'object', properties: props(`#/components/schemas/B${i + 1}`) };
    }
    const started = Date.now();
    expect(
      problemsOf(() => planFromOpenApi(doc(schemas, '#/components/schemas/B0'))).join(' '),
    ).toMatch(/expand past 5000 nodes/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps at most 20 entries of an allOf', () => {
    const many = Array.from({ length: 50 }, () => ({ type: 'object' }));
    const plan = planFromOpenApi(doc({ C: { allOf: many } }, '#/components/schemas/C'));
    expect((plan.outputSchema as { allOf: unknown[] }).allOf).toHaveLength(20);
  });
});

describe('Try your endpoint: credentials (security review P2)', () => {
  it('reads camelCase credential names', () => {
    for (const name of ['accessToken', 'authToken', 'clientSecret', 'apiKey', 'refreshToken']) {
      expect(isCredentialName(name)).toBe(true);
    }
    for (const name of ['pageSize', 'userName', 'keywords']) {
      expect(isCredentialName(name)).toBe(false);
    }
  });

  it('every OpenAPI test header is a secret, whatever it is called', () => {
    const text = JSON.stringify({
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: { '/x': { get: { operationId: 'x', responses: {} } } },
    });
    const plan = planFromOpenApi(text, { headers: { 'X-Tenant': 'tenant_abcdef123' } });
    expect(plan.headers['x-tenant']).toBe('tenant_abcdef123');
    expect(plan.secrets).toContain('tenant_abcdef123');
    expect(JSON.stringify(plan.requestMapping)).not.toContain('tenant_abcdef123');
  });

  it('a curl body’s credential fields are sent, never inputs, examples or mapping', () => {
    const plan = planFromCurl(
      `curl https://api.example.com/s --json '{"q":"x","apiKey":"ak_123456789","auth":{"user":"u"},` +
        `"opts":{"clientSecret":"cs_987654321","lang":"en"}}'`,
    );
    expect(plan.body).toMatchObject({
      apiKey: 'ak_123456789',
      opts: { clientSecret: 'cs_987654321' },
    });
    expect(plan.arguments).toEqual({ q: 'x', opts: { lang: 'en' } });
    expect(Object.keys((plan.inputSchema as { properties: object }).properties)).toEqual([
      'q',
      'opts',
    ]);
    expect(plan.requestMapping.body).toEqual({ q: '$.q', opts: '$.opts' });
    expect(plan.secrets).toEqual(expect.arrayContaining(['ak_123456789', 'cs_987654321', 'u']));
    expect(
      plan.warnings.filter((warning) => warning.code === TryWarningCode.CREDENTIAL_DETECTED),
    ).toHaveLength(3);
    const text = JSON.stringify({
      args: plan.arguments,
      schema: plan.inputSchema,
      map: plan.requestMapping,
    });
    expect(text).not.toMatch(/ak_123|cs_987/);
  });
});
