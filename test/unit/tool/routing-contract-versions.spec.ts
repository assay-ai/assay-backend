import { ProviderTier } from '@modules/provider/ports/provider.types';
import { ContractRequest } from '@modules/tool/domain/contract/contract-versions';
import { applyContractGate } from '@modules/tool/domain/routing/contract-gate';
import {
  OnEmpty,
  ProviderMode,
  RuleRejectionReason,
  RuleSource,
} from '@modules/tool/domain/routing';
import { ResponseClass } from '@modules/tool/domain/classification';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import {
  Tool,
  ToolBinding,
  ToolContractVersion,
  ToolTier,
  ToolVersionStatus,
} from '@modules/tool/ports/tool.types';
import { BindingAttemptRecorder } from '@modules/tool/services/binding-attempt-recorder.service';

import {
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  buildTool,
  jsonResponse,
  usdc,
} from './helpers/routing-fixtures';

/**
 * Contract version selection and the contract's hard constraints in routing
 * (design spec §7.3 "Contract version", §7.5). Every new reason is a routing
 * decision, never a provider-quality event.
 */

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

const V1_0 = version({});
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
const V2_0 = version({
  version: 3,
  semver: '2.0.0',
  major: 2,
  outputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' }, score: { type: 'number' } },
    required: ['answer', 'score'],
  },
});

function versionedTool(overrides: Partial<Tool> = {}): Tool {
  return buildTool({ versions: [V2_0, V1_1, V1_0], currentVersion: 2, ...overrides });
}

const rich = buildBinding('rich', {
  toolVersionRange: '^1',
  providesOutputFields: ['uv_index'],
  supportsInputFields: ['units'],
  responseMapping: { answer: { $path: '$.answer' }, uv_index: { $path: '$.uv' } },
});
const plain = buildBinding('plain', { toolVersionRange: '^1' });
const next = buildBinding('next', {
  toolVersionRange: '^2',
  responseMapping: { answer: { $path: '$.answer' }, score: { $path: '$.score' } },
});

const providers = [buildProvider('rich'), buildProvider('plain'), buildProvider('next')];
const stakes = { rich: usdc(1000), plain: usdc(1000), next: usdc(1000) };

function harness(options: {
  tool?: Tool;
  bindings?: readonly ToolBinding[];
  stakes?: Record<string, ReturnType<typeof usdc>>;
  responses?: Record<string, Record<string, unknown>>;
  observations?: BindingAttemptRecorder;
}) {
  const responses = options.responses ?? {};
  const invoker = new ScriptedInvoker({
    'binding-rich': async () => jsonResponse(responses.rich ?? { answer: 'r', uv: 3 }),
    'binding-plain': async () => jsonResponse(responses.plain ?? { answer: 'p' }),
    'binding-next': async () => jsonResponse(responses.next ?? { answer: 'n', score: 1 }),
  });
  const built = buildRouter({
    tool: options.tool ?? versionedTool(),
    bindings: options.bindings ?? [rich, plain, next],
    providers,
    stakes: options.stakes ?? stakes,
    invoker,
    observations: options.observations,
  });
  return { ...built, invoker };
}

function contract(overrides: Partial<ContractRequest> = {}): ContractRequest {
  return { range: null, requireOutputFields: [], ...overrides };
}

async function route(router: ReturnType<typeof harness>['router'], context = {}) {
  return router.route({
    toolId: TOOL_ID,
    input: { query: 'weather' },
    callId: 'call-1',
    context: { ...ROUTING_CONTEXT, callClass: 'PAID', ...context },
  });
}

describe('contract version selection', () => {
  it('serves an unpinned call at tools.current_version, not at a newer major', async () => {
    const { router, invoker } = harness({});
    const routed = await route(router);

    expect(routed.tool.version?.semver).toBe('1.1.0');
    expect(invoker.providerIds).not.toContain('next');
    expect(routed.tool.inputSchema).toEqual(V1_1.inputSchema);
  });

  it('moves unpinned calls only when current_version moves', async () => {
    const { router } = harness({ tool: versionedTool({ currentVersion: 3 }) });
    const routed = await route(router);

    expect(routed.tool.version?.semver).toBe('2.0.0');
    expect(routed.providerId).toBe('next');
  });

  it('falls back to the next lower major when the default major has no eligible binding', async () => {
    const { router } = harness({
      tool: versionedTool({ currentVersion: 3 }),
      stakes: { rich: usdc(1000), plain: usdc(1000) },
    });
    const routed = await route(router);

    expect(routed.tool.version?.semver).toBe('1.1.0');
    expect(['rich', 'plain']).toContain(routed.providerId);
  });

  it('serves a pinned range at its highest version with an eligible binding, and never below it', async () => {
    const { router } = harness({});
    const pinned = await route(router, { contract: contract({ range: [2] }) });
    expect(pinned.tool.version?.semver).toBe('2.0.0');

    const { router: unstaked } = harness({ stakes: { rich: usdc(1000), plain: usdc(1000) } });
    await expect(route(unstaked, { contract: contract({ range: [2] }) })).rejects.toBeDefined();
  });

  it('refuses CONTRACT_VERSION_RETIRED, naming the replacement, when the range is retired', async () => {
    const retired = versionedTool({
      versions: [
        V2_0,
        { ...V1_1, status: ToolVersionStatus.RETIRED, sunsetAt: new Date('2026-09-01T00:00:00Z') },
        { ...V1_0, status: ToolVersionStatus.RETIRED, sunsetAt: new Date('2026-09-01T00:00:00Z') },
      ],
      currentVersion: 3,
    });
    const { router } = harness({ tool: retired });

    await expect(route(router, { contract: contract({ range: [1] }) })).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.CONTRACT_VERSION_RETIRED,
      context: {
        details: {
          replacement: 'Search the web@2 (v2.0.0)',
          replacementTool: { toolId: TOOL_ID, name: 'Search the web', major: 2, semver: '2.0.0' },
        },
      },
    });
    const quote = await router.quote(TOOL_ID, {
      ...ROUTING_CONTEXT,
      contract: contract({ range: [1] }),
    });
    expect(quote?.price).toBeNull();
    expect(quote?.contractRefusal).toMatchObject({ refusal: 'RETIRED' });
  });

  it('decides the version once, on the whole pool: a pinned payee off it is PAYEE_NO_LONGER_ELIGIBLE', async () => {
    const { router } = harness({});
    const offer = await router.offer(TOOL_ID, { ...ROUTING_CONTEXT, callClass: 'PAID' });
    expect(offer.contractVersion).toBe(2);

    await expect(
      router.offer(TOOL_ID, { ...ROUTING_CONTEXT, callClass: 'PAID', onlyProviderId: 'next' }),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
      context: {
        details: {
          providers: [
            expect.objectContaining({
              providerId: 'next',
              reason: RuleRejectionReason.PAYEE_NO_LONGER_ELIGIBLE,
              rule: RuleRejectionReason.CONTRACT_VERSION_MISMATCH,
              source: RuleSource.MIGRATION,
            }),
          ],
        },
      },
    });
  });
});

describe('the contract hard constraints', () => {
  it('CONTRACT_VERSION_MISMATCH carries the served majors and the requested range', () => {
    const candidate = { binding: { id: 'b1', providerId: 'p1', toolVersionRange: '^1' } };
    const { kept, rejected } = applyContractGate([candidate as never], V2_0, {
      range: [2, 3],
      requireOutputFields: [],
    });
    expect(kept).toEqual([]);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: RuleRejectionReason.CONTRACT_VERSION_MISMATCH,
        source: RuleSource.MIGRATION,
        servedMajors: [1],
        requestedMajor: 2,
        requestedRange: [2, 3],
      }),
    ]);
    const unconstrained = applyContractGate([candidate as never], V2_0, {
      range: null,
      requireOutputFields: [],
    });
    expect(unconstrained.rejected[0]).toMatchObject({ requestedRange: null });
  });

  it('routes a required optional output only to bindings that declare it (MISSING_OUTPUT_FIELD)', async () => {
    const { router } = harness({});
    const routed = await route(router, {
      contract: contract({ requireOutputFields: ['uv_index'] }),
    });
    expect(routed.providerId).toBe('rich');

    await expect(
      route(router, {
        contract: contract({ requireOutputFields: ['uv_index'] }),
        rules: {
          agent: { excludeProviderIds: ['rich'], maxPrice: null, minTier: null, minQuality: null },
          entry: null,
        },
      }),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
      context: {
        details: {
          providers: expect.arrayContaining([
            expect.objectContaining({
              providerId: 'plain',
              reason: RuleRejectionReason.MISSING_OUTPUT_FIELD,
              source: RuleSource.TOOLSET,
              fields: ['uv_index'],
            }),
            expect.objectContaining({
              providerId: 'rich',
              reason: RuleRejectionReason.EXCLUDED_BY_AGENT,
            }),
          ]),
        },
      },
    });
  });

  it('routes an optional input only to bindings that support it, and never drops it', async () => {
    const { router, invoker } = harness({});
    const routed = await route(router, {
      contract: contract({ argumentNames: ['query', 'units'] }),
    });
    expect(routed.providerId).toBe('rich');
    expect(invoker.providerIds).toEqual(['rich']);
  });

  it('refuses UNSUPPORTED_INPUT_FIELD when no allowed provider supports the optional input', async () => {
    const { router, invoker } = harness({ bindings: [plain, next] });
    await expect(
      route(router, { contract: contract({ argumentNames: ['query', 'units'] }) }),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.UNSUPPORTED_INPUT_FIELD,
      message: 'No allowed provider supports units.',
      context: { details: { fields: ['units'] } },
    });
    expect(invoker.invocations).toHaveLength(0);
  });

  it('a quote under the same request prices only what can serve it', async () => {
    const { router } = harness({});
    const quote = await router.quote(TOOL_ID, {
      ...ROUTING_CONTEXT,
      contract: contract({ argumentNames: ['units'] }),
    });
    expect(quote?.routableBindings).toBe(1);
    expect(quote?.tool.version?.semver).toBe('1.1.0');
  });

  it('FALLBACK_BEST drops the entry preferences but keeps the version, required outputs and inputs', async () => {
    const entry = {
      mode: ProviderMode.ONLY,
      providerIds: ['plain'],
      minTier: null,
      maxPrice: null,
      minQuality: null,
      onEmpty: OnEmpty.FALLBACK_BEST,
    };
    const { router } = harness({});
    // ONLY [plain] cannot return uv_index, so the entry leaves nobody: the
    // fallback ignores ONLY but not the required output, and serves `rich`.
    const routed = await route(router, {
      contract: contract({ requireOutputFields: ['uv_index'] }),
      rules: { agent: null, entry },
    });
    expect(routed.providerId).toBe('rich');
    expect(routed.fellBack).toBe(true);

    // Nothing left that returns uv_index once the agent excludes `rich`: the
    // fallback never serves `plain` (missing the field) or `next` (other major).
    await expect(
      route(router, {
        contract: contract({ requireOutputFields: ['uv_index'] }),
        rules: {
          agent: { excludeProviderIds: ['rich'], maxPrice: null, minTier: null, minQuality: null },
          entry,
        },
      }),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });

    // And it keeps agent rules: a minimum tier the providers miss still refuses.
    await expect(
      route(router, {
        rules: {
          agent: {
            excludeProviderIds: [],
            maxPrice: null,
            minTier: ProviderTier.TRUSTED,
            minQuality: null,
          },
          entry: { ...entry, providerIds: ['nobody'] },
        },
      }),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
  });

  it('is never a provider-quality event: nothing is recorded for a binding the contract drops', async () => {
    const recorded: string[] = [];
    const observations = {
      record: (input: { binding: ToolBinding }) => recorded.push(input.binding.id),
    } as unknown as BindingAttemptRecorder;
    const { router } = harness({ bindings: [plain, next], observations });

    await expect(
      route(router, { contract: contract({ argumentNames: ['units'] }) }),
    ).rejects.toBeDefined();
    expect(recorded).toEqual([]);
  });
});

describe('declared optional outputs at call time', () => {
  it('maps a declared field and serves it', async () => {
    const { router } = harness({ bindings: [rich] });
    const routed = await route(router);
    expect(routed.output).toEqual({ answer: 'r', uv_index: 3 });
    // Verification judges against the binding's own promise.
    expect(routed.tool.outputSchema.required).toEqual(['answer', 'uv_index']);
  });

  it('counts a declared field that is missing as the provider’s contract violation (no failover)', async () => {
    const { router, invoker } = harness({
      bindings: [rich, plain],
      responses: { rich: { answer: 'r' } },
    });
    const routed = await route(router);

    expect(routed.providerId).toBe('rich');
    expect(routed.output).toBeNull();
    expect(routed.classification.responseClass).toBe(ResponseClass.DATA_RESULT);
    expect(invoker.providerIds).toEqual(['rich']);
  });

  it('does not hold a binding to a field it never declared', async () => {
    const { router } = harness({ bindings: [plain] });
    const routed = await route(router);
    expect(routed.output).toEqual({ answer: 'p' });
  });

  it('a tool built without versions routes exactly as before (implicit 1.0.0, range ^1)', async () => {
    const { router } = harness({ tool: buildTool(), bindings: [buildBinding('plain')] });
    const routed = await route(router);
    expect(routed.tool.version?.semver).toBe('1.0.0');
    await expect(route(router, { contract: contract({ range: [2] }) })).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET,
    });
    expect(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING).toBeDefined();
  });
});

describe('review fixes: version choice and declared outputs', () => {
  it('a FALLBACK_BEST at a higher version never beats a version the entry accepts', async () => {
    // Range ^1 || ^2, ONLY [plain] (a ^1 binding): v2 is reachable only by
    // falling back to `next`, v1 strictly by `plain`. v1 wins.
    const { router } = harness({});
    const routed = await route(router, {
      contract: contract({ range: [1, 2] }),
      rules: {
        agent: null,
        entry: {
          mode: ProviderMode.ONLY,
          providerIds: ['plain'],
          minTier: null,
          maxPrice: null,
          minQuality: null,
          onEmpty: OnEmpty.FALLBACK_BEST,
        },
      },
    });
    expect(routed.providerId).toBe('plain');
    expect(routed.fellBack).toBeUndefined();
    expect(routed.tool.version?.major).toBe(1);
  });

  it('a declared output mapped below the top level and missing is the provider’s fault, not a failover', async () => {
    const nested = buildBinding('rich', {
      toolVersionRange: '^1',
      providesOutputFields: ['uv_index'],
      responseMapping: { answer: { $path: '$.answer' }, uv_index: { $path: '$.uv.value' } },
    });
    const { router, invoker } = harness({
      bindings: [nested, plain],
      responses: { rich: { answer: 'r' } },
    });
    const routed = await route(router);
    expect(routed.providerId).toBe('rich');
    expect(routed.output).toBeNull();
    expect(routed.classification.responseClass).toBe(ResponseClass.DATA_RESULT);
    expect(invoker.providerIds).toEqual(['rich']);
  });
});
