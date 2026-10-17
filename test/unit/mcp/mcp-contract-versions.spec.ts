import { McpFailureCode } from '@modules/mcp/services/mcp-tool-call.service';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import {
  Tool,
  ToolContractVersion,
  ToolTier,
  ToolVersionStatus,
} from '@modules/tool/ports/tool.types';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import { EndpointKind, McpPathKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { EntryContract, McpEndpointView } from '@modules/toolset/domain/view';

import {
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildTool,
  jsonResponse,
} from '../tool/helpers/routing-fixtures';
import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import { SESSION, buildMcpHarness } from './helpers/mcp-harness';

/**
 * The MCP call path at a contract version (design spec §7.3, §7.5): the
 * entry range, `?tools=name@N`, required outputs and optional inputs are
 * hard constraints, refused before any intent exists; the call is quoted,
 * checked and routed at one version.
 */

const TOOL_NAME = 'search_web';
const TOOLSET_ID = '0b9a7f7e-2d55-4c1e-9a52-6f0c3f9d1e01';

function version(overrides: Partial<ToolContractVersion>): ToolContractVersion {
  return {
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: 'Searches the web.',
    description: 'Returns web results for a query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
    optionalInputFields: [],
    optionalOutputFields: [],
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

const V1_1 = version({
  version: 2,
  semver: '1.1.0',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, units: { type: 'string' } },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' }, uv_index: { type: 'number' } },
    required: ['answer'],
  },
  optionalInputFields: ['units'],
  optionalOutputFields: ['uv_index'],
});
const V2 = version({ version: 3, semver: '2.0.0', major: 2 });

function tool(overrides: Partial<Tool> = {}): Tool {
  return buildTool({
    name: TOOL_NAME,
    versions: [V2, V1_1, version({})],
    currentVersion: 2,
    ...overrides,
  });
}

function harness(
  options: { tool?: Tool; richAnswer?: Record<string, unknown>; withoutRich?: boolean } = {},
) {
  const invoker = new ScriptedInvoker({
    'binding-plain': async () => jsonResponse({ answer: 'plain' }),
    'binding-rich': async () => jsonResponse(options.richAnswer ?? { answer: 'rich', uv: 4 }),
    'binding-next': async () => jsonResponse({ answer: 'next' }),
  });
  const built = buildMcpHarness({
    tool: options.tool ?? tool(),
    bindings: [
      buildBinding('plain', { toolVersionRange: '^1' }),
      ...(options.withoutRich
        ? []
        : [
            buildBinding('rich', {
              toolVersionRange: '^1',
              providesOutputFields: ['uv_index'],
              supportsInputFields: ['units'],
              requestMapping: {
                method: 'POST',
                path: '/search',
                body: { q: { $path: '$.query' }, units: { $path: '$.units', $optional: true } },
              },
              responseMapping: { answer: { $path: '$.answer' }, uv_index: { $path: '$.uv' } },
            }),
          ]),
      buildBinding('next', { toolVersionRange: '^2' }),
    ],
    providers: [buildProvider('plain'), buildProvider('rich'), buildProvider('next')],
    invoker,
  });
  return { ...built, invoker };
}

function rootView(query = ''): McpEndpointView {
  const parsed = parseMcpUrl(`/${query}`)!;
  return {
    canonicalUrl: `https://mcp.example.com/${query}`,
    path: parsed.path,
    kind: EndpointKind.ROOT,
    filter: parsed.filter,
    toolset: null,
    handle: null,
    baseToolIds: null,
    entryRules: new Map(),
    notice: null,
  };
}

function toolsetView(contract: EntryContract): McpEndpointView {
  const parsed = parseMcpUrl('/my/research')!;
  return {
    canonicalUrl: 'https://mcp.example.com/my/research',
    path: { kind: McpPathKind.MY_TOOLSET, slug: 'research', version: null },
    kind: EndpointKind.TOOLSET,
    filter: parsed.filter,
    toolset: { id: TOOLSET_ID, slug: 'research', name: 'Research', version: null, latest: false },
    handle: null,
    baseToolIds: [TOOL_ID],
    entryRules: new Map(),
    entryContracts: new Map([[TOOL_ID, contract]]),
    notice: null,
  };
}

function scopeOf(view: McpEndpointView): McpScope {
  return {
    view,
    access: {
      agentId: SESSION.agentId,
      agent: ALLOW_ALL,
      key: null,
      rules: null,
      pinnedTools: [],
      policyVersion: 1,
    },
    attribution: attributionOf(view),
  };
}

describe('MCP calls at a contract version', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  it('an unpinned call is served at the current version (1.1.0), never by a v2-only binding', async () => {
    const h = harness();
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      { query: 'x' },
      undefined,
      scopeOf(rootView()),
    );
    expect(outcome.kind).toBe('RESULT');
    expect(h.invoker.providerIds).not.toContain('next');
  });

  it('an entry range ^2 routes to the v2 binding only', async () => {
    const h = harness();
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      { query: 'x' },
      undefined,
      scopeOf(toolsetView({ range: [2], requireOutputFields: [] })),
    );
    expect(outcome.kind).toBe('RESULT');
    expect(h.invoker.providerIds).toEqual(['next']);
  });

  it('?tools=name@2 pins the major on a URL with no toolset', async () => {
    const h = harness();
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      { query: 'x' },
      undefined,
      scopeOf(rootView('?tools=search_web@2')),
    );
    expect(outcome.kind).toBe('RESULT');
    expect(h.invoker.providerIds).toEqual(['next']);
  });

  it('?tools=name@N to a major that does not exist serves nothing at that URL', async () => {
    const h = harness();
    await expect(
      h.calls.call(
        SESSION,
        TOOL_NAME,
        { query: 'x' },
        undefined,
        scopeOf(rootView('?tools=search_web@7')),
      ),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET });
  });

  it('an optional input is routed only to a provider that supports it, and reaches it', async () => {
    const h = harness();
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      { query: 'x', units: 'metric' },
      undefined,
      scopeOf(rootView()),
    );
    expect(outcome.kind).toBe('RESULT');
    expect(h.invoker.providerIds).toEqual(['rich']);
    expect(h.invoker.invocations[0].input).toEqual({ query: 'x', units: 'metric' });
  });

  it('UNSUPPORTED_INPUT_FIELD before any intent when no allowed provider supports the input', async () => {
    const h = harness({ withoutRich: true });
    await expect(
      h.calls.call(
        SESSION,
        TOOL_NAME,
        { query: 'x', units: 'metric' },
        undefined,
        scopeOf(rootView()),
      ),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.UNSUPPORTED_INPUT_FIELD,
      message: 'No allowed provider supports units.',
    });
    expect(h.intents.rows.size).toBe(0);
    expect(h.invoker.invocations).toHaveLength(0);
  });

  it('a required optional output routes only to a provider that declares it', async () => {
    const h = harness();
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      { query: 'x' },
      undefined,
      scopeOf(toolsetView({ range: [1], requireOutputFields: ['uv_index'] })),
    );
    expect(outcome.kind).toBe('RESULT');
    expect(h.invoker.providerIds).toEqual(['rich']);
    expect(outcome.kind === 'RESULT' && outcome.output).toEqual({ answer: 'rich', uv_index: 4 });
  });

  it('a declared field missing from the response is a contract violation: refunded, never failed over', async () => {
    const h = harness({ richAnswer: { answer: 'rich' } });
    const outcome = await h.calls.call(
      SESSION,
      TOOL_NAME,
      { query: 'x' },
      undefined,
      scopeOf(toolsetView({ range: [1], requireOutputFields: ['uv_index'] })),
    );
    expect(outcome).toMatchObject({
      kind: 'ERROR',
      code: McpFailureCode.PROVIDER_CONTRACT_VIOLATION,
    });
    expect(h.invoker.providerIds).toEqual(['rich']);
    expect([...h.intents.rows.values()].map((row) => row.status)).toEqual([
      PaymentIntentStatus.REFUNDED,
    ]);
  });

  it('CONTRACT_VERSION_RETIRED before any intent, naming the replacement', async () => {
    const sunset = new Date('2026-09-01T00:00:00Z');
    const retired = tool({
      versions: [
        V2,
        { ...V1_1, status: ToolVersionStatus.RETIRED, sunsetAt: sunset },
        { ...version({}), status: ToolVersionStatus.RETIRED, sunsetAt: sunset },
      ],
      currentVersion: 3,
    });
    const h = harness({ tool: retired });
    await expect(
      h.calls.call(
        SESSION,
        TOOL_NAME,
        { query: 'x' },
        undefined,
        scopeOf(toolsetView({ range: [1], requireOutputFields: [] })),
      ),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.CONTRACT_VERSION_RETIRED,
      message: 'This version of the tool was retired. Use search_web@2 (v2.0.0).',
    });
    expect(h.intents.rows.size).toBe(0);
    expect(h.invoker.invocations).toHaveLength(0);
  });

  it('a rail-B retry is held to the contract version its offer named, or refused before any charge', async () => {
    const h = harness();
    const retry = {
      rail: null,
      voucher: {
        signed: { voucher: {} as never, signature: 'unchecked-before-the-offer' },
        providerId: 'rich',
        // v2.0.0: `rich` serves only ^1, so the payee cannot serve it.
        contractVersion: 3,
      },
    };
    await expect(
      h.calls.call(
        { ...SESSION },
        TOOL_NAME,
        { query: 'x' },
        { ...retry, rail: 'RAIL_B_VOUCHER' as never },
        scopeOf(rootView()),
      ),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
      context: {
        details: {
          providers: [
            expect.objectContaining({
              providerId: 'rich',
              reason: 'PAYEE_NO_LONGER_ELIGIBLE',
              rule: 'CONTRACT_VERSION_MISMATCH',
            }),
          ],
        },
      },
    });
    expect(h.intents.rows.size).toBe(0);
    expect(h.invoker.invocations).toHaveLength(0);
  });
});
