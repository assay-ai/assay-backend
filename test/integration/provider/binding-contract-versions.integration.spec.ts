import { AddressInfo } from 'node:net';
import * as http from 'node:http';

import { PublishRequirement } from '@modules/provider/domain/publish-gate';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import {
  PricingMode,
  Tool,
  ToolContractVersion,
  ToolTier,
  ToolVersionStatus,
} from '@modules/tool/ports/tool.types';
import { toServedToolBindings } from '@modules/tool/services/database-tool-catalogue';
import { EgressHttpClient } from '@shared/network/egress';
import { MoneyUtil } from '@shared/utils/money.util';

import { plainInvoker } from '../../unit/tool/helpers/routing-fixtures';
import {
  BindingEditorTestContext,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  USDC_DECIMALS,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

/**
 * A binding's contract range and declared fields against a real database
 * (design spec §7.5): checked per major at save, terms of the revision, a
 * tester run per major, and the published revision's terms served.
 */
function version(overrides: Partial<ToolContractVersion>): ToolContractVersion {
  return {
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: 'Returns web results for a query.',
    description: 'Returns web results for a query.',
    inputSchema: TOOL.inputSchema,
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' }, score: { type: 'string' } },
      required: ['answer'],
    },
    optionalInputFields: [],
    optionalOutputFields: ['score'],
    examples: [],
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    status: ToolVersionStatus.ACTIVE,
    sunsetAt: null,
    changelog: null,
    publishedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

const V1 = version({});
const V2 = version({
  version: 2,
  semver: '2.0.0',
  major: 2,
  outputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' }, source: { type: 'string' } },
    required: ['answer', 'source'],
  },
  optionalOutputFields: [],
});
const VERSIONED: Tool = { ...TOOL, versions: [V2, V1], currentVersion: 1, version: V1 };

const SUBJECT = 'cred-integration';
const PROVIDER_ADDRESS = '93.184.216.34';

const lookup = jest.fn(async (hostname: string) => {
  if (hostname.endsWith('.example.com')) return [{ address: PROVIDER_ADDRESS, family: 4 as const }];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

let server: http.Server;
let port: number;
const openSockets: Array<{ destroy: () => void }> = [];
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

function goodEndpoint(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { answer: 'forty-two' } }));
}

function body(overrides: Partial<SaveToolBindingBodyDto> = {}): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: `http://provider.example.com/api`,
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    // $0.05, so the computed minimum is exactly the $50 floor.
    priceAmount: '50000',
    assetId: USDC_ASSET,
    // Required, and stated rather than derived. The service
    // deliberately does NOT fall back to `[chainIdOf(assetId)]`, so a fixture
    // that omits it reaches `assertChainsRoutable` as `undefined`. The `as
    // SaveToolBindingBodyDto` cast below hides that from the compiler, which is
    // why this was found only by running the suite.
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 30_000,
    ...overrides,
  } as SaveToolBindingBodyDto;
}

const usdc = (whole: number) =>
  MoneyUtil.of(String(BigInt(whole) * 1_000_000n), USDC_ASSET, USDC_DECIMALS);

let context: BindingEditorTestContext;

// Top level, not per-`describe`: Jest runs a describe's `afterAll` before the
// next describe's tests, so a server opened inside the first one is already
// closed by the time the second dials it.
beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => respond(req, res));
  });
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  const invoker = plainInvoker(
    new EgressHttpClient(lookup, (target) => ({
      address: '127.0.0.1',
      family: 4,
      port: target.port === 80 ? port : target.port,
    })),
  );

  context = await createBindingEditorTestContext(invoker, VERSIONED);
});

afterAll(async () => {
  await context.close();
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await context.reset();
  await context.registerProvider();
  context.stakes.set(context.organizationId, usdc(100));
  respond = goodEndpoint;
});

describe('binding contract ranges and declared fields (T3)', () => {
  it('defaults to the current major and refuses a declared field the mapping never writes', async () => {
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    expect(binding).toMatchObject({ toolVersionRange: '^1', providesOutputFields: [] });

    await context.reset();
    await context.registerProvider();
    await expect(
      context.editor.create(
        context.organizationId,
        SUBJECT,
        body({ providesOutputFields: ['score'] }),
      ),
    ).rejects.toMatchObject({ errorCode: ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING });
    await expect(
      context.editor.create(
        context.organizationId,
        SUBJECT,
        body({ providesOutputFields: ['nonsense'] }),
      ),
    ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_BINDING_CONTRACT_MISMATCH });
  });

  it('a new major needs a re-map, and a green tester run per major before publishing', async () => {
    await expect(
      context.editor.create(
        context.organizationId,
        SUBJECT,
        body({ toolVersionRange: '^1 || ^2' }),
      ),
    ).rejects.toMatchObject({ errorCode: ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING });

    const binding = await context.editor.create(
      context.organizationId,
      SUBJECT,
      body({
        toolVersionRange: '^2||^1',
        responseMapping: { answer: '$.data.answer', source: '$.data.answer' },
      }),
    );
    expect(binding.toolVersionRange).toBe('^1 || ^2');

    // The default run tests the highest major only.
    const run = await context.tester.run(context.organizationId, SUBJECT, binding.id, {
      query: 'anything',
    });
    expect(run).toMatchObject({ toolVersion: 2, toolVersionSemver: '2.0.0', outcome: 'PASSED' });
    let check = await context.publisher.check(context.organizationId, binding.id);
    expect(check.publishable).toBe(false);
    expect(
      check.requirements.find((r) => r.requirement === PublishRequirement.TESTER_RUN && !r.met)
        ?.detail,
    ).toContain('Contract v1:');

    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' }, 1);
    check = await context.publisher.check(context.organizationId, binding.id);
    expect(check.publishable).toBe(true);
    await context.publisher.publish(context.organizationId, SUBJECT, binding.id);
  });

  it('the range and declared fields are terms of the revision: served from the published one', async () => {
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' });
    await context.publisher.publish(context.organizationId, SUBJECT, binding.id);

    const edited = await context.editor.update(context.organizationId, SUBJECT, binding.id, {
      providesOutputFields: ['score'],
      responseMapping: { answer: '$.data.answer', score: '$.data.answer' },
    });
    expect(edited.version).toBe(2);
    expect(edited.hasUnpublishedChanges).toBe(true);

    const row = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: binding.id },
    });
    const [served] = await toServedToolBindings([row!], context.versions);
    // Routing still serves revision 1, which promised nothing optional.
    expect(served).toMatchObject({ version: 1, providesOutputFields: [] });
  });
});
