import { AddressInfo } from 'node:net';
import * as http from 'node:http';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import {
  BindingTestLayer,
  BindingTestLayerStatus,
  BindingTestOutcome,
  BindingTestPolicySource,
  BindingTestWarningCode,
} from '@modules/provider/ports/binding-test.types';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { BindingMappingTesterService } from '@modules/provider/services/binding-mapping-tester.service';
import { ProviderEgressLimiter } from '@modules/provider/services/provider-egress-limiter.service';
import { ResponseClass } from '@modules/tool/domain/classification';
import { MappingFault } from '@modules/tool/domain/mapping/mapping.types';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingInvokerPort } from '@modules/tool/ports/binding-invoker.port';
import { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { BindingAuthMode, BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { ONE_CREDENTIAL, plainInvoker } from '../tool/helpers/routing-fixtures';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import { StageStatus, VerificationStage } from '@modules/verification/domain/stage';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { EgressHttpClient } from '@shared/network/egress';

import { STAKE_ASSET, buildTool } from '../tool/helpers/routing-fixtures';

// This spec dials a real local socket inside the parallel unit suite. On a
// two-core CI runner it has timed out under load (TOOL_ALL_BINDINGS_FAILED, the
// assertion never reached); retrying keeps the assertion and drops the timing flake.
jest.retryTimes(2, { logErrorsBeforeRetry: true });

/**
 * The mapping tester against a **real socket**.
 *
 * The shape of this file: test the tester against an endpoint returning good
 * data and one returning garbage, and prove the results differ at EACH LAYER
 * exactly as expected. Two endpoints, one binding, and
 * the assertion is not "green vs red" but that the **layers differ in the right
 * places**: a garbage response passes the socket, passes the classifier, and
 * dies at the mapping — which is a completely different conversation with a
 * provider than a connection that never opened.
 *
 * A real `node:http` server rather than a stubbed invoker, for the same reason
 * `binding-invoker.spec.ts` and `call-id-header.spec.ts` use one: the claim is
 * that a provider's own endpoint is dialled the way production dials it, and a
 * script cannot demonstrate that. `EgressHttpClient` runs
 * `UNTRUSTED_EGRESS_POLICY`, which blocks loopback by design, so the DNS and
 * connect seams are faked exactly as those files do it — the address rules run
 * unmodified and the approved connection lands locally.
 */
const PROVIDER = 'org-88888888-8888-4888-8888-888888888888';
const SUBJECT = 'cred-1';
const PROVIDER_ADDRESS = '93.184.216.34';

const lookup = jest.fn(async (hostname: string) => {
  if (hostname.endsWith('.example.com')) return [{ address: PROVIDER_ADDRESS, family: 4 as const }];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

/** No keys: what a deployment without `PROVIDER_REQUEST_SIGNING_KEYS` runs (never production). */
const UNSIGNED_SIGNER = new RequestSignerService([]);

let server: http.Server;
let port: number;
let received: { url: string; headers: http.IncomingHttpHeaders; body: string } | null = null;
const openSockets: Array<{ destroy: () => void }> = [];

/** What the fixture endpoint answers next. Set per test. */
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received = { url: req.url ?? '', headers: req.headers, body };
      respond(req, res);
    });
  });
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = null;
});

function bindingRow(overrides: Partial<ToolBindingEntity> = {}): ToolBindingEntity {
  return {
    id: 'a3f1c2d4-0000-4000-8000-000000000001',
    organizationId: PROVIDER,
    toolId: 'search_web',
    endpoint: 'http://provider-a.example.com/api',
    requestMapping: { method: 'POST', path: '/search', body: { q: { $path: '$.query' } } },
    responseMapping: { answer: { $path: '$.data.answer' } },
    pricingMode: PricingMode.PAID,
    priceAmount: '50000',
    assetId: STAKE_ASSET,
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    slaFailureRate: '0.02000',
    timeoutMs: 30_000,
    authMode: BindingAuthMode.API_KEY,
    status: BindingStatus.DRAFT,
    mappingVersion: 1,
    publishedVersion: null,
    publishedAt: null,
    ...overrides,
  } as ToolBindingEntity;
}

function buildTester(
  row: ToolBindingEntity,
  tool = buildTool(),
  invokerOverride?: BindingInvokerPort,
  signer: RequestSignerService = UNSIGNED_SIGNER,
) {
  const saved: unknown[] = [];

  const editor = { loadEditable: jest.fn(async () => row) } as unknown as BindingEditorService;
  const runs = {
    save: jest.fn(async (entity: unknown) => {
      saved.push(entity);
      return entity;
    }),
  } as unknown as BindingTestRunRepository;

  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(async () => tool),
    listTools: jest.fn(),
    findBindings: jest.fn(),
  };

  // No stored policy — the same answer `VerificationAggregatorService` would
  // get today, since nothing registers one yet. The tester says so on the
  // report rather than pretending it ran the real thing.
  const policies = {
    resolveForTraffic: jest.fn(async () => null),
  } as unknown as DecisionPolicyService;

  const invoker =
    invokerOverride ??
    plainInvoker(
      new EgressHttpClient(lookup, (target) => ({
        address: '127.0.0.1',
        family: 4,
        port: target.port === 80 ? port : target.port,
      })),
      // The default row is an API-key binding: without a stored key the invoker
      // refuses to dial (platform fault), which is not what these cases probe.
      ONE_CREDENTIAL,
    );

  return {
    tester: new BindingMappingTesterService(
      editor,
      runs,
      catalogue,
      invoker,
      policies,
      new ProviderEgressLimiter(),
      signer,
    ),
    saved,
  };
}

function layer(report: { layers: readonly { layer: BindingTestLayer }[] }, name: BindingTestLayer) {
  const found = report.layers.find((entry) => entry.layer === name);
  if (!found) throw new Error(`the report has no ${name} row`);
  return found as {
    layer: BindingTestLayer;
    status: BindingTestLayerStatus;
    code: string | null;
    detail: string | null;
    fault: MappingFault | null;
  };
}

function stage(report: any, name: VerificationStage) {
  return report.verification.stages.find((entry: any) => entry.stage === name);
}

describe('BindingMappingTesterService — an endpoint that behaves', () => {
  it('passes every layer, and shows the raw body, the mapped document and each stage', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'forty-two' }, meta: { ms: 12 } }));
    };

    const { tester, saved } = buildTester(
      // NONE: no probe, so `received` below is the main request.
      bindingRow({ authMode: BindingAuthMode.NONE }),
    );
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'the ultimate question',
    });

    console.log('GOOD ENDPOINT — layers:', JSON.stringify(report.layers, null, 2));
    console.log('GOOD ENDPOINT — raw body:', report.upstream?.rawBody);
    console.log('GOOD ENDPOINT — mapped:', JSON.stringify(report.mapped));
    console.log('GOOD ENDPOINT — stages:', JSON.stringify(report.verification?.stages, null, 2));

    expect(report.outcome).toBe(BindingTestOutcome.PASSED);
    expect(report.failedLayer).toBeNull();

    // Panel one: what the endpoint actually sent.
    expect(report.upstream?.status).toBe(200);
    expect(report.upstream?.rawBody).toBe('{"data":{"answer":"forty-two"},"meta":{"ms":12}}');

    // Panel two: the document the mapping produced, against the tool contract.
    expect(report.mapped).toEqual({ answer: 'forty-two' });

    // Panel three: every layer, and every verification stage under it.
    expect(report.layers.every((entry) => entry.status === BindingTestLayerStatus.PASSED)).toBe(
      true,
    );
    expect((report.classification as { responseClass: ResponseClass }).responseClass).toBe(
      ResponseClass.DATA_RESULT,
    );
    expect(report.verification?.verdict).toBe(VerdictStatus.PASS);
    expect(report.verification?.policySource).toBe(BindingTestPolicySource.TOOL_SCHEMA_ONLY);
    expect(stage(report, VerificationStage.SCHEMA).status).toBe(StageStatus.PASSED);

    // The request really left, at the mapped path, carrying a real call id.
    // The endpoint's own path prefix survives — `/api` + the mapped `/search`.
    expect(received?.url).toBe('/api/search');
    expect(received?.body).toBe('{"q":"the ultimate question"}');
    expect(received?.headers['x-assay-call-id']).toBe(report.callId);

    // And the run is on the record, against the revision it exercised.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      mappingVersion: 1,
      outcome: BindingTestOutcome.PASSED,
      failedLayer: null,
    });
  });

  it('is not a pass when every check was skipped: no schema, no rule that applied', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'forty-two' } }));
    };

    // No output schema and no stored policy: the schema stage is
    // NOT_APPLICABLE and the deterministic stage has no rule to apply, so the
    // engine's verdict is PASS on zero evaluated checks.
    const { tester, saved } = buildTester(bindingRow(), buildTool({ outputSchema: undefined }));
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'q',
    });

    expect(report.verification?.verdict).toBe(VerdictStatus.PASS);
    expect(stage(report, VerificationStage.SCHEMA).status).toBe(StageStatus.NOT_APPLICABLE);
    expect(layer(report, BindingTestLayer.VERIFICATION)).toMatchObject({
      status: BindingTestLayerStatus.INCONCLUSIVE,
      code: 'no_check_evaluated',
    });
    expect(report.outcome).toBe(BindingTestOutcome.FAILED);
    expect(report.failedLayer).toBe(BindingTestLayer.VERIFICATION);
    expect(saved[0]).toMatchObject({ outcome: BindingTestOutcome.FAILED });
  });

  it('reports the URL it built, with header names only — never their values', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'ok' } }));
    };

    const { tester } = buildTester(
      bindingRow({
        requestMapping: {
          method: 'POST',
          path: '/search',
          query: { hl: { $const: 'en' } },
          headers: { authorization: { $const: 'Bearer not-a-real-secret' } },
          body: { q: { $path: '$.query' } },
        },
      }),
    );

    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'x',
    });

    expect(report.request?.url).toBe('http://provider-a.example.com/api/search?hl=en');
    expect(report.request?.headerNames).toContain('authorization');
    // The report is persisted and rendered. A value here would be a place
    // credentials accumulate the day somebody ignores the "no secrets in a
    // mapping" rule.
    expect(JSON.stringify(report.request)).not.toContain('not-a-real-secret');
  });
});

describe('BindingMappingTesterService — an endpoint that returns rubbish', () => {
  it('passes the socket and the classifier, and dies at the mapping, with a pointer and a fault', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Valid JSON, 200, and nothing the mapping's selector can find.
      res.end(JSON.stringify({ oops: { nothing: 'here' } }));
    };

    const { tester, saved } = buildTester(bindingRow());
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'the ultimate question',
    });

    console.log('RUBBISH ENDPOINT — layers:', JSON.stringify(report.layers, null, 2));
    console.log('RUBBISH ENDPOINT — raw body:', report.upstream?.rawBody);
    console.log('RUBBISH ENDPOINT — mapped:', JSON.stringify(report.mapped));

    expect(report.outcome).toBe(BindingTestOutcome.FAILED);
    expect(report.failedLayer).toBe(BindingTestLayer.RESPONSE_MAPPING);

    // The layers *differ from the good run in exactly one place before the
    // failure*: the socket and the classifier are identical.
    expect(layer(report, BindingTestLayer.REQUEST_MAPPING).status).toBe(
      BindingTestLayerStatus.PASSED,
    );
    expect(layer(report, BindingTestLayer.UPSTREAM).status).toBe(BindingTestLayerStatus.PASSED);
    expect(layer(report, BindingTestLayer.CLASSIFICATION).status).toBe(
      BindingTestLayerStatus.PASSED,
    );

    const mapping = layer(report, BindingTestLayer.RESPONSE_MAPPING);
    expect(mapping.status).toBe(BindingTestLayerStatus.FAILED);
    expect(mapping.code).toBe('TOOL_MAPPING_PATH_NOT_FOUND');
    // The selector did not resolve at all, so this is **ours**, not the
    // provider's — the distinction `docs/mapping-format.md` says is easy to get
    // wrong and expensive when it is.
    expect(mapping.fault).toBe(MappingFault.PLATFORM);

    // And the layer after it says nothing, rather than looking fine.
    expect(layer(report, BindingTestLayer.VERIFICATION).status).toBe(
      BindingTestLayerStatus.NOT_REACHED,
    );
    expect(report.verification).toBeNull();

    // The raw body is still shown — it is the evidence the provider needs.
    expect(report.upstream?.rawBody).toBe('{"oops":{"nothing":"here"}}');
    expect(report.mapped).toBeNull();

    expect(saved[0]).toMatchObject({
      outcome: BindingTestOutcome.FAILED,
      failedLayer: BindingTestLayer.RESPONSE_MAPPING,
    });
  });

  it('stops at the classifier when the endpoint 500s, and never maps', async () => {
    respond = (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream on fire' }));
    };

    const { tester } = buildTester(bindingRow());
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'x',
    });

    console.log('500 ENDPOINT — layers:', JSON.stringify(report.layers, null, 2));

    expect(report.failedLayer).toBe(BindingTestLayer.CLASSIFICATION);
    expect(layer(report, BindingTestLayer.UPSTREAM).status).toBe(BindingTestLayerStatus.PASSED);
    expect(layer(report, BindingTestLayer.RESPONSE_MAPPING).status).toBe(
      BindingTestLayerStatus.NOT_REACHED,
    );
    expect((report.classification as { responseClass: ResponseClass }).responseClass).toBe(
      ResponseClass.SYSTEM_ERROR,
    );
  });

  it('fails at the request mapping, before any socket opens, when the sample input is wrong', async () => {
    respond = (_req, res) => res.end('{}');

    const { tester } = buildTester(bindingRow());
    // `query` is `required` on the tool's inputSchema.
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      wrong: 'field',
    });

    expect(report.failedLayer).toBe(BindingTestLayer.REQUEST_MAPPING);
    // The agent's arguments, not the provider's endpoint — so nothing is filed
    // against their availability, and nothing was dialled at all.
    expect(layer(report, BindingTestLayer.REQUEST_MAPPING).fault).toBe(MappingFault.AGENT);
    expect(layer(report, BindingTestLayer.UPSTREAM).status).toBe(
      BindingTestLayerStatus.NOT_REACHED,
    );
    expect(received).toBeNull();
    expect(report.request).toBeNull();
  });
});

describe('BindingMappingTesterService — unauthenticated probes', () => {
  const ID = 'a3f1c2d4-0000-4000-8000-000000000001';
  const ok = {
    status: 200,
    body: { kind: 'JSON', value: { data: { answer: 'x' } } },
    headers: { 'content-type': 'application/json' },
  };

  function fake(answer: (omit: unknown) => { status: number }) {
    const invoke = jest.fn(async (invocation: { omit?: unknown }) => ({
      ...ok,
      ...answer(invocation.omit),
    }));
    return { invoke, invoker: { invoke } as unknown as BindingInvokerPort };
  }

  const run = (mode: BindingAuthMode, invoker: BindingInvokerPort) =>
    buildTester(bindingRow({ authMode: mode }), buildTool(), invoker).tester.run(
      PROVIDER,
      SUBJECT,
      ID,
      { query: 'q' },
    );

  it('SIGNATURE: warns ACCEPTS_UNSIGNED when the unsigned probe is answered 200, outcome still PASSED', async () => {
    const { invoker, invoke } = fake(() => ({ status: 200 }));
    const report = await run(BindingAuthMode.SIGNATURE, invoker);
    expect(report.outcome).toBe(BindingTestOutcome.PASSED);
    expect(report.warnings).toEqual([
      {
        code: BindingTestWarningCode.ACCEPTS_UNSIGNED,
        message: 'Your endpoint accepted a request without an Assay signature.',
      },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0].omit).toEqual({ signature: true });
  });

  it('has no warnings when the probe is refused with 401', async () => {
    const { invoker } = fake((omit) => ({ status: omit ? 401 : 200 }));
    const report = await run(BindingAuthMode.SIGNATURE, invoker);
    expect(report.outcome).toBe(BindingTestOutcome.PASSED);
    expect(report.warnings).toEqual([]);
  });

  it('BOTH: probes signature and credentials separately', async () => {
    const { invoker, invoke } = fake(() => ({ status: 200 }));
    const report = await run(BindingAuthMode.BOTH, invoker);
    expect(report.warnings.map((w) => w.code)).toEqual([
      BindingTestWarningCode.ACCEPTS_UNSIGNED,
      BindingTestWarningCode.ACCEPTS_WITHOUT_CREDENTIALS,
    ]);
    expect(invoke.mock.calls.map((c) => c[0].omit)).toEqual([
      undefined,
      { signature: true },
      { credentials: true },
    ]);
  });

  it('API_KEY: warns ACCEPTS_WITHOUT_CREDENTIALS', async () => {
    const { invoker } = fake(() => ({ status: 200 }));
    const report = await run(BindingAuthMode.API_KEY, invoker);
    expect(report.warnings[0].message).toBe(
      'Your endpoint accepted a request without your API key.',
    );
  });

  it('NONE: warns NO_AUTHENTICATION with exactly one invoke', async () => {
    const { invoker, invoke } = fake(() => ({ status: 200 }));
    const report = await run(BindingAuthMode.NONE, invoker);
    expect(report.warnings).toEqual([
      {
        code: BindingTestWarningCode.NO_AUTHENTICATION,
        message: 'Anyone who learns your endpoint URL can call it directly, without paying.',
      },
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not probe when the main run fails', async () => {
    const { invoker, invoke } = fake(() => ({ status: 500 }));
    const report = await run(BindingAuthMode.BOTH, invoker);
    expect(report.outcome).toBe(BindingTestOutcome.FAILED);
    expect(report.warnings).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('BindingMappingTesterService — the signature headers in the request view', () => {
  const signer = new RequestSignerService([
    { keyId: 'tester-1', seed: Buffer.alloc(32, 7), claimedPublicKey: null },
  ]);

  function signedTester(row: ToolBindingEntity) {
    const invoker = new EgressBindingInvoker(
      new EgressHttpClient(lookup, (target) => ({
        address: '127.0.0.1',
        family: 4,
        port: target.port === 80 ? port : target.port,
      })),
      ONE_CREDENTIAL,
      signer,
    );
    return buildTester(row, buildTool(), invoker, signer).tester;
  }

  it('names the headers Assay adds, signature included, so a provider can code against them', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'ok' } }));
    };

    const tester = signedTester(bindingRow({ authMode: BindingAuthMode.NONE }));
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'x',
    });

    const names = report.request?.headerNames ?? [];
    expect(names).toEqual(
      expect.arrayContaining(['x-assay-call-id', 'content-digest', 'signature-input', 'signature']),
    );
    // The view says what went on the wire: every name it lists was received.
    for (const name of names) expect(received?.headers[name]).toBeDefined();
    // Names only: no signature, digest or call id value is in the report.
    const view = JSON.stringify(report.request);
    expect(view).not.toContain(String(received?.headers['signature']));
    expect(view).not.toContain(String(received?.headers['x-assay-call-id']));
  });

  it('lists a signature name once, even when the mapping also sets it', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'ok' } }));
    };

    const tester = signedTester(
      bindingRow({
        authMode: BindingAuthMode.NONE,
        requestMapping: {
          method: 'POST',
          path: '/search',
          headers: { Signature: { $const: 'x' } },
          body: { q: { $path: '$.query' } },
        },
      }),
    );
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'x',
    });

    const names = report.request?.headerNames ?? [];
    expect(names.filter((name) => name === 'signature')).toHaveLength(1);
    expect(names.slice(-3)).toEqual(['content-digest', 'signature-input', 'signature']);
  });

  it('lists no signature header when this deployment does not sign', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'ok' } }));
    };

    const { tester } = buildTester(bindingRow({ authMode: BindingAuthMode.NONE }));
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'x',
    });

    const names = report.request?.headerNames ?? [];
    expect(names).toContain('x-assay-call-id');
    expect(names).not.toContain('signature');
    expect(names).not.toContain('signature-input');
    expect(received?.headers['signature']).toBeUndefined();
  });

  it('never lists a stored credential header, by name or value', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'ok' } }));
    };

    const tester = signedTester(bindingRow({ authMode: BindingAuthMode.NONE }));
    const report = await tester.run(PROVIDER, SUBJECT, 'a3f1c2d4-0000-4000-8000-000000000001', {
      query: 'x',
    });

    // A stored set is attached under every mode (NONE: no probe, so `received`
    // is the main request). The stored key went out, but neither its name nor its value is in the view.
    expect(received?.headers['x-provider-key']).toBe('test-key');
    expect(report.request?.headerNames).not.toContain('x-provider-key');
    expect(JSON.stringify(report.request)).not.toContain('test-key');
  });
});
