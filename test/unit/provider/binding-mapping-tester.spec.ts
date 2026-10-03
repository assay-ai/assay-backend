import { AddressInfo } from 'node:net';
import * as http from 'node:http';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import {
  BindingTestLayer,
  BindingTestLayerStatus,
  BindingTestOutcome,
  BindingTestPolicySource,
} from '@modules/provider/ports/binding-test.types';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { BindingMappingTesterService } from '@modules/provider/services/binding-mapping-tester.service';
import { ResponseClass } from '@modules/tool/domain/classification';
import { MappingFault } from '@modules/tool/domain/mapping/mapping.types';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import { StageStatus, VerificationStage } from '@modules/verification/domain/stage';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { EgressHttpClient } from '@shared/network/egress';

import { STAKE_ASSET, buildTool } from '../tool/helpers/routing-fixtures';

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
    status: BindingStatus.DRAFT,
    mappingVersion: 1,
    publishedVersion: null,
    publishedAt: null,
    ...overrides,
  } as ToolBindingEntity;
}

function buildTester(row: ToolBindingEntity) {
  const saved: unknown[] = [];

  const editor = { loadEditable: jest.fn(async () => row) } as unknown as BindingEditorService;
  const runs = {
    save: jest.fn(async (entity: unknown) => {
      saved.push(entity);
      return entity;
    }),
  } as unknown as BindingTestRunRepository;

  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(async () => buildTool()),
    listTools: jest.fn(),
    findBindings: jest.fn(),
  };

  // No stored policy — the same answer `VerificationAggregatorService` would
  // get today, since nothing registers one yet. The tester says so on the
  // report rather than pretending it ran the real thing.
  const policies = {
    resolveForTraffic: jest.fn(async () => null),
  } as unknown as DecisionPolicyService;

  const invoker = new EgressBindingInvoker(
    new EgressHttpClient(lookup, (target) => ({
      address: '127.0.0.1',
      family: 4,
      port: target.port === 80 ? port : target.port,
    })),
  );

  return {
    tester: new BindingMappingTesterService(editor, runs, catalogue, invoker, policies),
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

    const { tester, saved } = buildTester(bindingRow());
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
    expect(received?.headers['x-x402-call-id']).toBe(report.callId);

    // And the run is on the record, against the revision it exercised.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      mappingVersion: 1,
      outcome: BindingTestOutcome.PASSED,
      failedLayer: null,
    });
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
