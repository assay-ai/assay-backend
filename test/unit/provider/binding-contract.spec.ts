import {
  assertBindingContract,
  defaultBindingRange,
} from '@modules/provider/domain/binding-contract';
import { evaluatePublishGate, PublishRequirement } from '@modules/provider/domain/publish-gate';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { BindingTestOutcome, BindingTestLayer } from '@modules/provider/ports/binding-test.types';
import { testedVersion } from '@modules/provider/services/binding-mapping-tester.service';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import {
  Tool,
  ToolContractVersion,
  ToolTier,
  ToolVersionStatus,
} from '@modules/tool/ports/tool.types';

/**
 * The binding editor's contract check and the per-major publish gate
 * (design spec §7.5: the contract check covers core fields plus every
 * declared optional field; a major needs a re-map and a passing test run).
 */

function v(overrides: Partial<ToolContractVersion>): ToolContractVersion {
  return {
    version: 1,
    semver: '1.0.0',
    major: 1,
    summary: 'Weather now.',
    description: 'Current weather at a point.',
    inputSchema: {
      type: 'object',
      properties: { latitude: { type: 'number' }, units: { type: 'string' } },
      required: ['latitude'],
    },
    outputSchema: {
      type: 'object',
      properties: { temperatureC: { type: 'number' }, uvIndex: { type: 'number' } },
      required: ['temperatureC'],
    },
    optionalInputFields: ['units'],
    optionalOutputFields: ['uvIndex'],
    examples: [],
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    status: ToolVersionStatus.ACTIVE,
    sunsetAt: null,
    changelog: null,
    publishedAt: null,
    ...overrides,
  };
}

const V1 = v({});
const V2 = v({
  version: 2,
  semver: '2.0.0',
  major: 2,
  outputSchema: {
    type: 'object',
    properties: { temperatureC: { type: 'number' }, feelsLikeC: { type: 'number' } },
    required: ['temperatureC', 'feelsLikeC'],
  },
  optionalOutputFields: [],
});

const TOOL: Tool = {
  id: 't',
  name: 'get_weather',
  description: V1.description,
  inputSchema: V1.inputSchema,
  outputSchema: V1.outputSchema,
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
  versions: [V2, V1],
  currentVersion: 1,
};

const response = { temperatureC: { $path: '$.t' }, uvIndex: { $path: '$.uv' } };
const selectors = ['$.latitude', '$.units'];

function terms(overrides: Partial<Parameters<typeof assertBindingContract>[1]> = {}) {
  return {
    toolVersionRange: '^1',
    providesOutputFields: [],
    supportsInputFields: [],
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { errorCode?: string }).errorCode;
  }
  return undefined;
}

describe('assertBindingContract', () => {
  it('defaults a new binding to the tool’s current major and returns the canonical range', () => {
    expect(defaultBindingRange(TOOL)).toBe('^1');
    expect(
      assertBindingContract(
        TOOL,
        terms({ providesOutputFields: ['uvIndex'], supportsInputFields: ['units'] }),
        { responseMapping: response, requestSelectors: selectors },
      ),
    ).toBe('^1');
  });

  it('refuses a malformed range, a major with no published version, and undeclarable fields', () => {
    const mismatch = ProviderErrorCode.PROVIDER_BINDING_CONTRACT_MISMATCH;
    const mappings = { responseMapping: response, requestSelectors: selectors };
    expect(
      codeOf(() => assertBindingContract(TOOL, terms({ toolVersionRange: '>=1' }), mappings)),
    ).toBe(mismatch);
    expect(
      codeOf(() => assertBindingContract(TOOL, terms({ toolVersionRange: '^3' }), mappings)),
    ).toBe(mismatch);
    expect(
      codeOf(() =>
        assertBindingContract(TOOL, terms({ providesOutputFields: ['temperatureC'] }), mappings),
      ),
    ).toBe(mismatch);
    expect(
      codeOf(() =>
        assertBindingContract(TOOL, terms({ supportsInputFields: ['latitude'] }), mappings),
      ),
    ).toBe(mismatch);
  });

  it('refuses a supported input the request mapping never reads (it would be dropped)', () => {
    expect(
      codeOf(() =>
        assertBindingContract(TOOL, terms({ supportsInputFields: ['units'] }), {
          responseMapping: response,
          requestSelectors: ['$.latitude'],
        }),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CONTRACT_MISMATCH);
  });

  it('checks the response mapping against core plus declared fields, per major', () => {
    const coreOnly = { temperatureC: { $path: '$.t' } };
    // Declared but not written: refused at save.
    expect(
      codeOf(() =>
        assertBindingContract(TOOL, terms({ providesOutputFields: ['uvIndex'] }), {
          responseMapping: coreOnly,
          requestSelectors: selectors,
        }),
      ),
    ).toBe(ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING);
    // Not declared: the core alone is enough.
    expect(
      assertBindingContract(TOOL, terms(), {
        responseMapping: coreOnly,
        requestSelectors: selectors,
      }),
    ).toBe('^1');
    // A new major must be re-mapped: v2 makes feelsLikeC core.
    expect(
      codeOf(() =>
        assertBindingContract(TOOL, terms({ toolVersionRange: '^1 || ^2' }), {
          responseMapping: coreOnly,
          requestSelectors: selectors,
        }),
      ),
    ).toBe(ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING);
    expect(
      assertBindingContract(TOOL, terms({ toolVersionRange: '^2||^1' }), {
        responseMapping: { ...coreOnly, feelsLikeC: { $path: '$.f' } },
        requestSelectors: selectors,
      }),
    ).toBe('^1 || ^2');
  });
});

describe('the tester’s contract version', () => {
  it('tests the newest version of the highest major in range, or the one asked for in range', () => {
    expect(testedVersion(TOOL, '^1 || ^2').semver).toBe('2.0.0');
    expect(testedVersion(TOOL, '^1 || ^2', 1).semver).toBe('1.0.0');
    expect(codeOf(() => testedVersion(TOOL, '^1', 2))).toBe(
      ProviderErrorCode.PROVIDER_BINDING_CONTRACT_MISMATCH,
    );
  });
});

describe('the publish gate, per contract major', () => {
  const passed = {
    mappingVersion: 4,
    outcome: BindingTestOutcome.PASSED,
    failedLayer: null,
    ranAt: new Date('2026-10-01T00:00:00Z'),
  };
  const base = {
    mappingVersion: 4,
    latestRun: passed,
    payoutByChain: new Map([['solana:x' as never, { passed: true } as never]]),
    stakeByChain: new Map([['solana:x' as never, { passed: true } as never]]),
  };

  it('is met when every major in the range has a green run at this revision', () => {
    const check = evaluatePublishGate({
      ...base,
      runsByMajor: new Map([
        [1, passed],
        [2, passed],
      ]),
    });
    expect(check.publishable).toBe(true);
  });

  it('names each major with no run, or a failed one', () => {
    const check = evaluatePublishGate({
      ...base,
      runsByMajor: new Map([
        [1, passed],
        [2, null],
        [
          3,
          { ...passed, outcome: BindingTestOutcome.FAILED, failedLayer: BindingTestLayer.UPSTREAM },
        ],
      ]),
    });
    expect(check.publishable).toBe(false);
    const unmet = check.requirements.filter((requirement) => !requirement.met);
    expect(unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: PublishRequirement.TESTER_RUN,
          detail: expect.stringContaining('Contract v2:'),
        }),
        expect.objectContaining({
          requirement: PublishRequirement.TESTER_PASSED,
          code: 'tester_failed',
          detail: expect.stringContaining('Contract v3:'),
        }),
      ]),
    );
  });
});

describe('the publish gate wants each major tested at its newest version (P2-2)', () => {
  it('a run at an older minor does not count', async () => {
    const { BindingPublishService } =
      await import('@modules/provider/services/binding-publish.service');
    const V1_1 = { ...V1, version: 3, semver: '1.1.0' };
    const tool = { ...TOOL, versions: [V2, V1_1, V1], currentVersion: 3 };
    const run = (toolVersion: number) => ({
      mappingVersion: 4,
      toolVersion,
      outcome: BindingTestOutcome.PASSED,
      failedLayer: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    const service = new BindingPublishService(
      {} as never,
      { findForRevision: async () => [run(1)] } as never,
      {} as never,
      {} as never,
      new Map(),
      {} as never,
      { findTool: async () => tool } as never,
    );
    const at = (runs: unknown[]) =>
      (
        service as unknown as {
          runsByMajor: (o: string, r: unknown) => Promise<Map<number, unknown>>;
        }
      ).runsByMajor.call(
        Object.assign(Object.create(service), {
          runs: { findForRevision: async () => runs },
        }),
        'org',
        { id: 'b', toolId: 't', toolVersionRange: '^1', mappingVersion: 4 },
      );
    expect((await at([run(1)])).get(1)).toBeNull();
    expect((await at([run(3)])).get(1)).toMatchObject({ outcome: BindingTestOutcome.PASSED });
  });
});
